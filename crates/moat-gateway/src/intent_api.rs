//! The intent API: how the host tells Moat what the human actually asked for.
//!
//! Binds to a loopback address, no authentication. It is a side channel
//! rather than something parsed out of the MCP stream on purpose; see ADR
//! 0004 (step 7 follow-up) for why.

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
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
    amount: f64,
    #[serde(default)]
    tolerance: f64,
    currency: String,
    #[serde(default)]
    invoice_fingerprint: Option<String>,
    #[serde(default)]
    require_invoice_fingerprint: bool,
    #[serde(default)]
    aggregate_limit: Option<f64>,
    expires_at: String,
    #[serde(default)]
    repeat_payments: bool,
    #[serde(default = "one_payment")]
    max_payments: u32,
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

async fn post_intent(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(body): Json<IntentBody>,
) -> ApiResult {
    let text = body.text.trim();
    if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "text is empty"));
    }
    let session = shared.store.get_or_create(&id);
    let turn = lock(&session).register_intent(text);
    tracing::info!(session = %id, turn, chars = text.chars().count(), "intent registered");
    Ok(Json(json!({ "session": id, "turn": turn })))
}

async fn post_resume(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(body): Json<ResumeBody>,
) -> ApiResult {
    let Some(pending) = shared.take_resume(&body.resume_token) else {
        return Err(err(
            StatusCode::NOT_FOUND,
            "unknown or already used resume_token",
        ));
    };
    if pending.session != id {
        // Put it back: it was not this session's to consume.
        let token = shared.new_resume(pending);
        tracing::warn!(session = %id, %token, "resume token presented for the wrong session");
        return Err(err(
            StatusCode::CONFLICT,
            "resume_token belongs to another session",
        ));
    }
    let evidence_id = pending.evidence_id.clone();
    let confirmed = shared.resolve_step_up(pending, &body.resume_token, body.approved);
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
    Path(id): Path<String>,
    Json(body): Json<HeadlessBody>,
) -> ApiResult {
    let session = shared.store.get_or_create(&id);
    lock(&session).set_headless(body.headless);
    tracing::info!(session = %id, headless = body.headless, "headless flag set");
    Ok(Json(json!({ "session": id, "headless": body.headless })))
}

async fn post_authorization(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(body): Json<AuthorizationBody>,
) -> ApiResult {
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
    if currency.len() != 3 || !currency.bytes().all(|c| c.is_ascii_alphabetic()) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "currency must be a three-letter ISO code",
        ));
    }
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
    let amount_minor = major_to_minor(body.amount, &currency).ok_or_else(|| {
        err(
            StatusCode::BAD_REQUEST,
            "amount is invalid for this currency",
        )
    })?;
    let tolerance_minor =
        major_to_minor_allow_zero(body.tolerance, &currency).ok_or_else(|| {
            err(
                StatusCode::BAD_REQUEST,
                "tolerance is invalid for this currency",
            )
        })?;
    let aggregate_limit_minor = body
        .aggregate_limit
        .map(|limit| {
            major_to_minor(limit, &currency).ok_or_else(|| {
                err(
                    StatusCode::BAD_REQUEST,
                    "aggregate_limit is invalid for this currency",
                )
            })
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
    let session = shared.store.get_or_create(&id);
    let mut session = lock(&session);
    session
        .register_payment_authorization(authorization.clone())
        .map_err(|message| err(StatusCode::CONFLICT, message))?;
    // Feed the same user-approved values into the existing provenance engine.
    session.register_intent(&format!(
        "Authorize invoice {} to {} for {} {} until {}",
        invoice_id, payee, body.amount, currency, body.expires_at
    ));
    tracing::info!(session = %id, authorization_id, invoice_id, "payment authorization registered");
    Ok(Json(
        json!({ "session": id, "authorization": authorization }),
    ))
}

async fn cancel_authorization(
    State(shared): State<Arc<Shared>>,
    Path((id, authorization_id)): Path<(String, String)>,
) -> ApiResult {
    let session = shared.store.get_or_create(&id);
    if !lock(&session).cancel_payment_authorization(&authorization_id) {
        return Err(err(StatusCode::NOT_FOUND, "unknown authorization_id"));
    }
    tracing::info!(session = %id, %authorization_id, "payment authorization cancelled");
    Ok(Json(json!({
        "session": id,
        "authorization_id": authorization_id,
        "cancelled": true
    })))
}

async fn get_workflow(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> ApiResult {
    let Some(session) = shared.store.get(&id) else {
        return Err(err(StatusCode::NOT_FOUND, "unknown session"));
    };
    let session = lock(&session);
    Ok(Json(json!({
        "session": id,
        "authorizations": session.payment_authorizations(),
        "payment_outcomes": session.payment_outcomes(),
        "events": session.events(),
        "evidence": shared.evidence_for(&id),
    })))
}

fn currency_factor(currency: &str) -> f64 {
    if matches!(
        currency,
        "BIF"
            | "CLP"
            | "DJF"
            | "GNF"
            | "JPY"
            | "KMF"
            | "KRW"
            | "MGA"
            | "PYG"
            | "RWF"
            | "UGX"
            | "VND"
            | "VUV"
            | "XAF"
            | "XOF"
            | "XPF"
    ) {
        1.0
    } else {
        100.0
    }
}

fn major_to_minor(amount: f64, currency: &str) -> Option<u64> {
    if !amount.is_finite() || amount <= 0.0 {
        return None;
    }
    major_to_minor_allow_zero(amount, currency)
}

fn major_to_minor_allow_zero(amount: f64, currency: &str) -> Option<u64> {
    if !amount.is_finite() || amount < 0.0 {
        return None;
    }
    let minor = amount * currency_factor(currency);
    let rounded = minor.round();
    ((minor - rounded).abs() <= 1e-7 && rounded <= u64::MAX as f64).then_some(rounded as u64)
}

async fn get_evidence(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> ApiResult {
    let records = shared.evidence_for(&id);
    Ok(Json(json!(records)))
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
        .with_state(shared)
}

/// Bind and serve until the task is dropped.
pub async fn serve(addr: &str, shared: Arc<Shared>) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding intent API on {addr}"))?;
    let local = listener.local_addr().context("intent API local address")?;
    if !local.ip().is_loopback() {
        tracing::warn!(%local, "intent API is not bound to loopback and has no authentication");
    }
    tracing::info!(%local, "intent API listening");
    axum::serve(listener, router(shared))
        .await
        .context("intent API server")
}
