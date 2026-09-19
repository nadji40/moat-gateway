//! The intent API: how the host tells Moat what the human actually asked for.
//!
//! Binds to a loopback address and supports database-backed bearer authentication.
//! It is a side channel
//! rather than something parsed out of the MCP stream on purpose; see ADR
//! 0004 (step 7 follow-up) for why.

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use moat_core::money::parse_major;
use moat_core::session::{lock, PaymentAuthorization};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::Shared;

#[derive(Deserialize)]
struct IntentBody {
    text: String,
}

#[derive(Deserialize)]
struct ResumeBody {
    resume_token: String,
    approved: bool,
}

#[derive(Deserialize)]
struct HeadlessBody {
    headless: bool,
}

#[derive(Deserialize)]
struct AuthorizationBody {
    authorization_id: String,
    invoice_id: String,
    payee: String,
    #[serde(default)]
    recipient_account_id: Option<String>,
    /// Major units, as a decimal string or a JSON number. Strings are the
    /// only exact form once an asset has more than a few decimal places.
    amount: Value,
    #[serde(default = "zero_amount")]
    tolerance: Value,
    currency: String,
    #[serde(default)]
    invoice_fingerprint: Option<String>,
    #[serde(default)]
    require_invoice_fingerprint: bool,
    #[serde(default)]
    aggregate_limit: Option<Value>,
    expires_at: String,
    #[serde(default)]
    repeat_payments: bool,
    #[serde(default = "one_payment")]
    max_payments: u32,
}

fn zero_amount() -> Value {
    Value::from(0)
}

fn one_payment() -> u32 {
    1
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

type ApiResult = Result<Json<Value>, (StatusCode, Json<ErrorBody>)>;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<ErrorBody>) {
    (status, Json(ErrorBody { error: msg.into() }))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

async fn authenticated_tenant(shared: &Shared, headers: &HeaderMap) -> ApiResultTenant {
    match shared
        .authenticate_bearer(bearer(headers), "approver")
        .await
    {
        Ok(Some(tenant)) => Ok(tenant),
        Ok(None) => Err(err(
            StatusCode::UNAUTHORIZED,
            "valid Moat bearer token required",
        )),
        Err(error) => {
            tracing::error!(%error, "authentication storage unavailable");
            Err(err(
                StatusCode::SERVICE_UNAVAILABLE,
                "authentication unavailable",
            ))
        }
    }
}

type ApiResultTenant = Result<String, (StatusCode, Json<ErrorBody>)>;

async fn session_for_request(
    shared: &Shared,
    tenant_id: &str,
    id: &str,
) -> Result<
    std::sync::Arc<std::sync::Mutex<moat_core::session::Session>>,
    (StatusCode, Json<ErrorBody>),
> {
    shared
        .session_for_tenant(tenant_id, id, !shared.auth_required())
        .await
        .map_err(|error| {
            tracing::error!(%error, session = %id, "session storage unavailable");
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "session storage unavailable",
            )
        })?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "unknown session"))
}

async fn mutate<T, F>(shared: &Shared, tenant_id: &str, id: &str, mutation: F) -> ApiResultMut<T>
where
    T: Send,
    F: FnOnce(&mut moat_core::session::Session) -> std::result::Result<T, String> + Send,
{
    shared
        .mutate_session(tenant_id, id, mutation)
        .await
        .map_err(|error| {
            tracing::error!(%error, session = %id, "session persistence failed");
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "session persistence failed",
            )
        })?
        .map_err(|message| err(StatusCode::CONFLICT, message))
}

type ApiResultMut<T> = Result<T, (StatusCode, Json<ErrorBody>)>;

async fn post_intent(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<IntentBody>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers).await?;
    let text = body.text.trim();
    if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "text is empty"));
    }
    let _session = session_for_request(&shared, &tenant_id, &id).await?;
    let turn = mutate(&shared, &tenant_id, &id, |session| {
        Ok(session.register_intent(text))
    })
    .await?;
    tracing::info!(session = %id, turn, chars = text.chars().count(), "intent registered");
    Ok(Json(json!({ "session": id, "turn": turn })))
}

async fn post_resume(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ResumeBody>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers).await?;
    let _session = session_for_request(&shared, &tenant_id, &id).await?;
    let Some(pending) = shared
        .take_resume(&tenant_id, &id, &body.resume_token)
        .await
        .map_err(|error| {
            tracing::error!(%error, session = %id, "approval storage unavailable");
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "approval storage unavailable",
            )
        })?
    else {
        return Err(err(
            StatusCode::NOT_FOUND,
            "unknown or already used resume_token",
        ));
    };
    let evidence_id = pending.evidence_id.clone();
    let confirmed = mutate(&shared, &tenant_id, &id, |session| {
        Ok(Shared::resolve_step_up(
            session,
            pending,
            &body.resume_token,
            body.approved,
        ))
    })
    .await?;
    tracing::info!(session = %id, %evidence_id, approved = body.approved, confirmed = confirmed.len(), "step-up resolved");
    Ok(Json(json!({
        "session": id,
        "evidence_id": evidence_id,
        "approved": body.approved,
        "confirmed": confirmed,
    })))
}

async fn post_headless(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<HeadlessBody>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers).await?;
    let _session = session_for_request(&shared, &tenant_id, &id).await?;
    mutate(&shared, &tenant_id, &id, |session| {
        session.set_headless(body.headless);
        Ok(())
    })
    .await?;
    tracing::info!(session = %id, headless = body.headless, "headless flag set");
    Ok(Json(json!({ "session": id, "headless": body.headless })))
}

async fn post_authorization(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<AuthorizationBody>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers).await?;
    let authorization_id = body.authorization_id.trim();
    let invoice_id = body.invoice_id.trim();
    let payee = body.payee.trim();
    let recipient_account_id = body
        .recipient_account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let invoice_fingerprint = body
        .invoice_fingerprint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let currency = body.currency.trim().to_ascii_uppercase();
    if authorization_id.is_empty() || invoice_id.is_empty() || payee.is_empty() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "authorization_id, invoice_id and payee are required",
        ));
    }
    let Some(asset) = shared.policies.assets().lookup(&currency, None) else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unknown asset; declare it under `assets` in the policy",
        ));
    };
    if body.max_payments == 0 || (!body.repeat_payments && body.max_payments != 1) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "max_payments must be 1 unless repeat_payments is true",
        ));
    }
    if let Some(fingerprint) = &invoice_fingerprint {
        if fingerprint.len() != 64 || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "invoice_fingerprint must be a 64-character SHA-256 hex value",
            ));
        }
    }
    let amount_minor = parse_major(&body.amount, &asset, false)
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("amount: {e}")))?;
    let tolerance_minor = parse_major(&body.tolerance, &asset, true)
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("tolerance: {e}")))?;
    let aggregate_limit_minor = body
        .aggregate_limit
        .as_ref()
        .map(|limit| {
            parse_major(limit, &asset, false)
                .map_err(|e| err(StatusCode::BAD_REQUEST, format!("aggregate_limit: {e}")))
        })
        .transpose()?;
    if aggregate_limit_minor.is_some_and(|limit| limit < amount_minor) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "aggregate_limit must be at least the expected amount",
        ));
    }
    let expires = time::OffsetDateTime::parse(
        body.expires_at.trim(),
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| err(StatusCode::BAD_REQUEST, "expires_at must be RFC 3339"))?;
    let expires_unix_ms = u64::try_from(expires.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "expires_at must be after 1970"))?;

    let authorization = PaymentAuthorization {
        id: authorization_id.to_owned(),
        payee: payee.to_owned(),
        recipient_account_id,
        amount_minor,
        tolerance_minor,
        currency: currency.clone(),
        invoice_id: invoice_id.to_owned(),
        invoice_fingerprint,
        require_invoice_fingerprint: body.require_invoice_fingerprint,
        aggregate_limit_minor,
        expires_unix_ms,
        repeat_payments: body.repeat_payments,
        max_payments: body.max_payments,
        cancelled: false,
    };
    let _session = session_for_request(&shared, &tenant_id, &id).await?;
    let to_register = authorization.clone();
    mutate(&shared, &tenant_id, &id, |session| {
        session
            .register_payment_authorization(to_register)
            .map_err(|message| message.to_owned())?;
        // Feed the same user-approved values into the existing provenance engine.
        session.register_intent(&format!(
            "Authorize invoice {} to {} for {} {} until {}",
            invoice_id, payee, body.amount, currency, body.expires_at
        ));
        Ok(())
    })
    .await?;
    tracing::info!(session = %id, authorization_id, invoice_id, "payment authorization registered");
    Ok(Json(
        json!({ "session": id, "authorization": authorization }),
    ))
}

async fn cancel_authorization(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path((id, authorization_id)): Path<(String, String)>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers).await?;
    let _session = session_for_request(&shared, &tenant_id, &id).await?;
    let cancelled = mutate(&shared, &tenant_id, &id, |session| {
        Ok(session.cancel_payment_authorization(&authorization_id))
    })
    .await?;
    if !cancelled {
        return Err(err(StatusCode::NOT_FOUND, "unknown authorization_id"));
    }
    tracing::info!(session = %id, %authorization_id, "payment authorization cancelled");
    Ok(Json(json!({
        "session": id,
        "authorization_id": authorization_id,
        "cancelled": true
    })))
}

async fn get_workflow(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers).await?;
    let session = session_for_request(&shared, &tenant_id, &id).await?;
    let (authorizations, payment_outcomes, events) = {
        let session = lock(&session);
        (
            session.payment_authorizations().to_vec(),
            session.payment_outcomes().to_vec(),
            session.events().to_vec(),
        )
    };
    let evidence = shared
        .evidence_for_tenant(&tenant_id, &id)
        .await
        .map_err(|error| {
            tracing::error!(%error, session = %id, "evidence storage unavailable");
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "evidence storage unavailable",
            )
        })?;
    Ok(Json(json!({
        "session": id,
        "authorizations": authorizations,
        "payment_outcomes": payment_outcomes,
        "events": events,
        "evidence": evidence,
    })))
}

async fn get_evidence(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers).await?;
    let _session = session_for_request(&shared, &tenant_id, &id).await?;
    let records = shared
        .evidence_for_tenant(&tenant_id, &id)
        .await
        .map_err(|error| {
            tracing::error!(%error, session = %id, "evidence storage unavailable");
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "evidence storage unavailable",
            )
        })?;
    Ok(Json(json!(records)))
}

async fn live() -> StatusCode {
    StatusCode::OK
}

async fn ready(State(shared): State<Arc<Shared>>) -> StatusCode {
    match shared.storage_ready().await {
        Ok(()) => StatusCode::OK,
        Err(error) => {
            tracing::error!(%error, "intent API readiness check failed");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

/// Build the router.
pub fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/v1/session/{id}/intent", post(post_intent))
        .route("/v1/session/{id}/resume", post(post_resume))
        .route("/v1/session/{id}/headless", post(post_headless))
        .route("/v1/session/{id}/authorizations", post(post_authorization))
        .route(
            "/v1/session/{id}/authorizations/{authorization_id}/cancel",
            post(cancel_authorization),
        )
        .route("/v1/session/{id}/workflow", get(get_workflow))
        .route("/v1/session/{id}/evidence", get(get_evidence))
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .with_state(shared)
}

/// Bind and serve until the task is dropped.
pub async fn serve(addr: &str, shared: Arc<Shared>) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding intent API on {addr}"))?;
    let local = listener.local_addr().context("intent API local address")?;
    if !local.ip().is_loopback() && !shared.auth_required() {
        tracing::warn!(%local, "intent API is not loopback and authentication is disabled");
    }
    tracing::info!(%local, "intent API listening");
    axum::serve(listener, router(shared))
        .await
        .context("intent API server")
}
