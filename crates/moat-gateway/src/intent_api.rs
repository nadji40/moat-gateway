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
use moat_core::cosign;
use moat_core::destination::Destination;
use moat_core::money::parse_major;
use moat_core::outcome::OutcomeStatus;
use moat_core::policy::{payment_amount, PaymentCall};
use moat_core::session::{lock, IntentFields, PaymentAuthorization};
use moat_core::verdict::Decision;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::proxy::now_unix_ms;
use crate::state::{PolicyState, Shared};

/// What the host says the user asked for: the words, the fields, or both.
///
/// Fields are the direct path, for a client that already knows what the
/// user asked for (a form, a checkout, a confirmed mandate), and the path
/// `moat-intent` takes after reading the words. When fields are given the
/// core matches against them and never reads the text, which is then kept
/// for the record only. Text alone is read by the core's own rules.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntentBody {
    #[serde(default)]
    text: String,
    #[serde(default)]
    fields: Option<IntentFields>,
}

/// The longest message kept as an intent. A request to pay somebody is a
/// sentence or two; anything this long is a document pasted into the chat.
const MAX_INTENT_CHARS: usize = 4000;

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
    /// The bill this pays, when there is one.
    #[serde(default)]
    invoice_id: Option<String>,
    /// The payee's name. Optional when the account is pinned: on a chain the
    /// address is the payee.
    #[serde(default)]
    payee: Option<String>,
    #[serde(default)]
    recipient_account_id: Option<String>,
    /// Major units, as a decimal string or a JSON number. Strings are the
    /// only exact form once an asset has more than a few decimal places.
    amount: Value,
    #[serde(default = "zero_amount")]
    tolerance: Value,
    currency: String,
    /// CAIP-2 network the payment must move on, on rails that have more
    /// than one. Omitted on card and bank, which have exactly one each.
    #[serde(default)]
    network: Option<String>,
    /// The token contract or mint the payment must be in. Required for a
    /// token that is not the network's own coin; omitted for fiat and for
    /// the coin itself.
    #[serde(default)]
    asset_contract: Option<String>,
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

/// Authenticate an `approver` key and refuse it if it was narrowed away from
/// `scope`. Returns the tenant, which is all the handlers need once the two
/// checks have passed.
///
/// This listener is the trusted side. What arrives here is what the user
/// said and what a person approved, and it must come from code the agent does
/// not control: an agent that could register its own intent would be an agent
/// that authorizes itself. The role check is what keeps an agent key out. The
/// scope check is what keeps a harness that only registers intent from also
/// releasing held payments, which is a person's decision and not a machine's.
async fn authenticated_tenant(
    shared: &Shared,
    headers: &HeaderMap,
    scope: &str,
) -> ApiResultTenant {
    match shared
        .authenticate_bearer(bearer(headers), "approver")
        .await
    {
        Ok(Some(caller)) => {
            if !caller.may(scope) {
                return Err(err(
                    StatusCode::FORBIDDEN,
                    format!(
                        "this key is not scoped to {scope}. It carries: {}.",
                        caller.scopes.join(", ")
                    ),
                ));
            }
            Ok(caller.tenant_id)
        }
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
    let tenant_id = authenticated_tenant(&shared, &headers, "intent:write").await?;
    let text = body.text.trim().to_owned();
    if text.chars().count() > MAX_INTENT_CHARS {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("text is over {MAX_INTENT_CHARS} characters"),
        ));
    }
    if let Some(fields) = &body.fields {
        fields
            .validate()
            .map_err(|why| err(StatusCode::BAD_REQUEST, format!("fields: {why}")))?;
    } else if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "text or fields is required"));
    }
    let _session = session_for_request(&shared, &tenant_id, &id).await?;
    let structured = body.fields.is_some();
    let turn = mutate(&shared, &tenant_id, &id, move |session| {
        Ok(match body.fields {
            Some(fields) => session.register_intent_fields(&text, fields),
            None => session.register_intent(&text),
        })
    })
    .await?;
    tracing::info!(session = %id, turn, structured, "intent registered");
    Ok(Json(
        json!({ "session": id, "turn": turn, "structured": structured }),
    ))
}

async fn post_resume(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ResumeBody>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "holds:release").await?;
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
    let tenant_id = authenticated_tenant(&shared, &headers, "intent:write").await?;
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
    let tenant_id = authenticated_tenant(&shared, &headers, "authorizations:write").await?;
    let authorization_id = body.authorization_id.trim();
    let invoice_id = body
        .invoice_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let payee = body
        .payee
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
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
    let network = body
        .network
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let asset_contract = body
        .asset_contract
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if authorization_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "authorization_id is required"));
    }
    if payee.is_none() && recipient_account_id.is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "name the payee, pin the account with recipient_account_id, or both",
        ));
    }
    // On a chain the name beside an address is checked by nothing, so an
    // authorization that named only a payee would authorize whatever
    // address the agent put beside that name.
    if network.is_some() && recipient_account_id.is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "recipient_account_id is required on a network: the address is the payee",
        ));
    }
    let Some(asset) = shared
        .policies
        .assets()
        .lookup(&currency, network.as_deref())
    else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unknown asset; declare it under `assets` in the policy",
        ));
    };
    if asset.needs_contract() && asset_contract.is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!(
                concat!(
                    "asset_contract is required for {}: a ticker is a label any ",
                    "contract can wear, so name the contract or mint the payment must be in",
                ),
                currency
            ),
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

    // Computed before the value moves into the authorization. Feeding the
    // bound account into the session as part of the user's own words is what
    // gives a destination User provenance; without it the account the
    // approver typed would resolve to Unknown and no destination rule could
    // ever pass.
    let account_note = recipient_account_id
        .as_deref()
        .map(|account| format!(" at {account}"))
        .unwrap_or_default();
    // The network is part of what the approver agreed to, so it belongs in
    // the same sentence. It is bound by its own structured check rather
    // than by provenance, but a person reading the evidence should see the
    // chain they approved beside the address they approved.
    let network_note = network
        .as_deref()
        .map(|network| format!(" on {network}"))
        .unwrap_or_default();
    // Same reasoning for the contract: it is what makes the ticker mean
    // one asset rather than any asset wearing the name, so the approver
    // should see it in the sentence they approved.
    let contract_note = asset_contract
        .as_deref()
        .map(|contract| format!(" in the contract at {contract}"))
        .unwrap_or_default();
    // The amount as the approver wrote it, for the intent fields.
    let amount_text = match &body.amount {
        Value::String(text) => moat_core::normalize::normalize_number(text),
        Value::Number(n) => moat_core::normalize::normalize_number(&n.to_string()),
        _ => None,
    };
    let authorization = PaymentAuthorization {
        id: authorization_id.to_owned(),
        payee: payee.clone(),
        recipient_account_id: recipient_account_id.clone(),
        amount_minor,
        tolerance_minor,
        currency: currency.clone(),
        network: network.clone(),
        asset_contract: asset_contract.clone(),
        invoice_id: invoice_id.clone(),
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
        // What the approver approved is what the user asked for, as fields:
        // the core matches the payment against these values exactly. The
        // sentence beside them is the record a person reads.
        session.register_intent_fields(
            &format!(
                "Authorize {}{}{}{}{} for {} {} until {}",
                invoice_id
                    .as_deref()
                    .map(|invoice| format!("invoice {invoice} to "))
                    .unwrap_or_else(|| "payment to ".to_owned()),
                payee.as_deref().unwrap_or("the account"),
                account_note,
                network_note,
                contract_note,
                body.amount,
                currency,
                body.expires_at
            ),
            IntentFields {
                pay: payee.iter().cloned().collect(),
                amounts: amount_text.iter().cloned().collect(),
                currencies: vec![currency.clone()],
                destinations: recipient_account_id.iter().cloned().collect(),
                references: invoice_id.iter().cloned().collect(),
                reader: Some("authorization".to_owned()),
                ..IntentFields::default()
            },
        );
        Ok(())
    })
    .await?;
    tracing::info!(
        session = %id, authorization_id, invoice_id = invoice_id.as_deref().unwrap_or("none"),
        named = payee.is_some(), pinned = recipient_account_id.is_some(),
        "payment authorization registered"
    );
    Ok(Json(
        json!({ "session": id, "authorization": authorization }),
    ))
}

async fn cancel_authorization(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path((id, authorization_id)): Path<(String, String)>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "authorizations:write").await?;
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

/// What a reconciliation reports.
#[derive(Debug, Deserialize)]
struct ReconcileBody {
    /// What the provider says actually happened, in Moat's vocabulary:
    /// pending, submitted, confirmed, succeeded, failed or reversed.
    status: String,
    /// The provider's transaction identifier, if the check turned one up.
    #[serde(default)]
    receipt: Option<String>,
}

/// Payments Moat is still waiting on.
///
/// An operator's work queue: everything that has not reached a final state,
/// and everything Moat could not account for and has therefore blocked.
async fn get_outcomes(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "evidence:read").await?;
    let session = session_for_request(&shared, &tenant_id, &id).await?;
    let (open, all) = {
        let session = lock(&session);
        (
            session
                .open_payment_outcomes()
                .into_iter()
                .cloned()
                .collect::<Vec<_>>(),
            session.payment_outcomes().len(),
        )
    };
    Ok(Json(json!({
        "session": id,
        "open": open,
        "open_count": open.len(),
        "total": all
    })))
}

/// Tell Moat what the provider actually did.
///
/// This exists because of what an irreversible rail does to a lost
/// response. Moat holds the payment, counts it, and refuses to send
/// another under the same authorization, because it cannot tell whether
/// the first one went. Somebody has to go and look; this is where they say
/// what they found. Whatever the answer, the hold is cleared: the reason
/// for it was that nobody knew.
///
/// The outcome is addressed by the evidence id of the verdict that allowed
/// it, so the reconciliation is tied to the signed record rather than to
/// an identifier Moat invented for the purpose.
async fn reconcile_outcome(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path((id, evidence_id)): Path<(String, String)>,
    Json(body): Json<ReconcileBody>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "holds:release").await?;
    let session = session_for_request(&shared, &tenant_id, &id).await?;
    let status = OutcomeStatus::from_provider(&body.status);
    if status == OutcomeStatus::Unknown {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!(
                "status {:?} is not a state Moat recognises; reconciling to \"unknown\" \
                 would report having learned nothing",
                body.status
            ),
        ));
    }
    let receipt = body
        .receipt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    // Distinguished before the mutation, because `mutate` reports every
    // refusal as a conflict and an outcome that does not exist is a
    // different mistake from one that cannot move.
    {
        let session = lock(&session);
        if !session
            .payment_outcomes()
            .iter()
            .any(|outcome| outcome.evidence_id == evidence_id)
        {
            return Err(err(
                StatusCode::NOT_FOUND,
                "no payment outcome in this session carries that evidence id",
            ));
        }
    }
    let now = now_unix_ms();
    let outcome = mutate(&shared, &tenant_id, &id, move |session| {
        session
            .reconcile_payment_outcome(&evidence_id, status, receipt.clone(), now)
            .map_err(|error| error.to_string())
    })
    .await?;
    tracing::info!(
        session = %id,
        evidence_id = %outcome.evidence_id,
        authorization_id = %outcome.authorization_id,
        status = %outcome.status_kind,
        committed = outcome.committed,
        "payment outcome reconciled"
    );
    Ok(Json(json!({ "session": id, "outcome": outcome })))
}

/// What a caller asks Moat to co-sign.
///
/// Every field is checked against the evidence record rather than trusted.
/// The caller says what it intends to execute; Moat signs only if that is
/// what it allowed.
#[derive(Debug, Deserialize)]
struct CosignBody {
    /// The evidence record whose verdict is being turned into a signature.
    evidence_id: String,
    /// The guarded wallet that will check the signature.
    wallet: String,
    /// EVM chain id. Part of the EIP-712 domain, so a signature for one
    /// chain is worthless on another.
    chain_id: u64,
    /// Recipient, which must be the destination the record carries.
    to: String,
    /// ERC-20 contract, or absent for native value.
    #[serde(default)]
    token: Option<String>,
    /// Amount in the token's base units, as a decimal integer string.
    value: String,
    /// How many seconds the signature stays good for. Bounded.
    #[serde(default = "default_cosign_ttl")]
    ttl_seconds: u64,
}

fn default_cosign_ttl() -> u64 {
    300
}

/// The longest a verdict may stay executable.
///
/// A signature with a long life is a standing grant by another name, which
/// is the thing the arena's standing-approval attack is about. Five minutes
/// is enough to get a transaction mined on an L2 and short enough that a
/// leaked signature is nearly always already dead.
const MAX_COSIGN_TTL_SECONDS: u64 = 300;

async fn cosign_verdict(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CosignBody>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "holds:release").await?;
    let session = session_for_request(&shared, &tenant_id, &id).await?;
    let Some(cosign) = shared.cosign() else {
        return Err(err(
            StatusCode::NOT_IMPLEMENTED,
            "this gateway has no co-signing key; run it with `cosign_keys` configured",
        ));
    };

    if body.ttl_seconds == 0 || body.ttl_seconds > MAX_COSIGN_TTL_SECONDS {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("ttl_seconds must be between 1 and {MAX_COSIGN_TTL_SECONDS}"),
        ));
    }
    let wallet = address_arg(&body.wallet, "wallet")?;
    let to = address_arg(&body.to, "to")?;
    let token = match body
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(text) => address_arg(text, "token")?,
        None => [0u8; 20],
    };
    let value = cosign::value_from_decimal(&body.value)
        .map_err(|why| err(StatusCode::BAD_REQUEST, format!("value: {why}")))?;

    // The verdict, as recorded. Not as described by whoever is asking.
    let Some(record) = shared
        .evidence_for_tenant(&tenant_id, &id)
        .await
        .map_err(|error| {
            tracing::error!(%error, session = %id, "evidence could not be read");
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "the evidence for this session could not be read",
            )
        })?
        .into_iter()
        .find(|record| record.id == body.evidence_id)
    else {
        return Err(err(
            StatusCode::NOT_FOUND,
            "no evidence record in this session carries that id",
        ));
    };
    if record.verdict != Decision::Allow {
        return Err(err(
            StatusCode::CONFLICT,
            format!(
                "evidence {} is a {:?}, and only an allow can be co-signed",
                record.id, record.verdict
            ),
        ));
    }

    let call = PaymentCall {
        server: record.call.server.clone(),
        tool: record.call.tool.clone(),
        call_id: record.call.call_id.clone(),
        args: record.call.args.clone(),
    };
    let PolicyState::Loaded(policy) = shared.policies.for_upstream(&call.server) else {
        return Err(err(
            StatusCode::CONFLICT,
            "the policy that produced this verdict is no longer loadable",
        ));
    };

    // The destination the verdict was about, compared as an address rather
    // than as text, so that hex casing cannot turn one address into another.
    let mapped = policy.map_fields(&call.args);
    let recorded_destination = mapped
        .get("destination")
        .map(|(_, value)| *value)
        .or_else(|| call.args.get("recipient_account_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let asked = format!("0x{}", hex::encode(to));
    if !Destination::parse(recorded_destination).same_as(&Destination::parse(&asked)) {
        return Err(err(
            StatusCode::CONFLICT,
            format!(
                "evidence {} allowed a payment to {recorded_destination}, not to {asked}",
                record.id
            ),
        ));
    }

    // And the amount, in the base units the chain counts in. Reading it
    // through the policy's own mapping is what makes this the amount that
    // was evaluated rather than whatever argument happens to be named
    // `amount`.
    let Some((_asset, minor)) = payment_amount(policy, &call) else {
        return Err(err(
            StatusCode::CONFLICT,
            "the amount of the allowed payment could not be read through the policy's \
             field mapping, so there is nothing to bind a signature to",
        ));
    };
    let recorded_value = cosign::value_from_decimal(&minor.0.to_string())
        .map_err(|why| err(StatusCode::INTERNAL_SERVER_ERROR, why))?;
    if recorded_value != value {
        return Err(err(
            StatusCode::CONFLICT,
            format!(
                "evidence {} allowed {} base units, not {}",
                record.id, minor.0, body.value
            ),
        ));
    }

    // A payment Moat cannot account for is held (ADR 0009). Signing for an
    // authorization with an unreconciled outcome would hand out a second
    // executable verdict while the first is still unaccounted for.
    let authorization_id = call
        .args
        .get("authorization_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    {
        let session = lock(&session);
        if let Some(quarantined) = session
            .payment_outcomes()
            .iter()
            .find(|outcome| outcome.quarantined && outcome.authorization_id == authorization_id)
        {
            return Err(err(
                StatusCode::CONFLICT,
                format!(
                    "an earlier payment under {} is unaccounted for (evidence {}); \
                     reconcile it before asking for another signature",
                    authorization_id, quarantined.evidence_id
                ),
            ));
        }
        if let Some(authorization) = session.payment_authorization(&authorization_id) {
            if authorization.cancelled {
                return Err(err(
                    StatusCode::CONFLICT,
                    format!("authorization {authorization_id} has been cancelled"),
                ));
            }
        }
    }

    let expiry = now_unix_ms() / 1000 + body.ttl_seconds;
    let verdict = cosign::Verdict {
        wallet,
        to,
        token,
        value,
        evidence_id: cosign::evidence_id_to_bytes32(&record.id),
        expiry,
    };
    let signature = cosign.sign_verdict(&verdict, body.chain_id, &wallet);
    tracing::info!(
        session = %id,
        evidence_id = %record.id,
        authorization_id = %authorization_id,
        wallet = %body.wallet,
        chain_id = body.chain_id,
        expiry,
        "verdict co-signed"
    );
    Ok(Json(json!({
        "session": id,
        "evidence_id": record.id,
        "signature": signature,
        "signer": cosign.address_hex(),
        "wallet": format!("0x{}", hex::encode(wallet)),
        "to": asked,
        "token": format!("0x{}", hex::encode(token)),
        "value": body.value,
        "evidence_id_bytes32": format!("0x{}", hex::encode(verdict.evidence_id)),
        "expiry": expiry,
        "chain_id": body.chain_id,
    })))
}

fn address_arg(text: &str, field: &str) -> Result<[u8; 20], (StatusCode, Json<ErrorBody>)> {
    cosign::address_from_hex(text)
        .map_err(|why| err(StatusCode::BAD_REQUEST, format!("{field}: {why}")))
}

/// Every open payment across the tenant, not just this session.
///
/// The per-session `/outcomes` answers "what is outstanding in this
/// conversation". This answers "what is outstanding at all", which is the
/// question an operator actually has: a quarantined payment blocks its
/// mandate whether or not anyone still has the session that made it open,
/// and before the payment ledger there was no way to ask.
async fn get_tenant_outcomes(State(shared): State<Arc<Shared>>, headers: HeaderMap) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "evidence:read").await?;
    let Some(storage) = shared.storage() else {
        return Err(err(
            StatusCode::NOT_IMPLEMENTED,
            concat!(
                "this gateway has no durable storage, so it has no ledger to read; ",
                "open outcomes are per-session at /v1/session/{id}/outcomes",
            ),
        ));
    };
    let open = storage
        .open_outcomes(&tenant_id, 200)
        .await
        .map_err(|error| err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(json!({ "tenant": tenant_id, "open": open })))
}

/// One mandate and what it has spent, across every session.
async fn get_tenant_authorization(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "evidence:read").await?;
    let Some(storage) = shared.storage() else {
        return Err(err(
            StatusCode::NOT_IMPLEMENTED,
            "this gateway has no durable storage, so a mandate cannot outlive its session",
        ));
    };
    let authorization = storage
        .payment_authorization(&tenant_id, &id)
        .await
        .map_err(|error| err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let Some(authorization) = authorization else {
        return Err(err(
            StatusCode::NOT_FOUND,
            "no authorization with that id in this tenant's ledger",
        ));
    };
    let aggregate = storage
        .aggregate_for(&tenant_id, &id)
        .await
        .map_err(|error| err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(json!({
        "tenant": tenant_id,
        "authorization": authorization,
        "aggregate": {
            // Strings, because these are u128 and a JSON number is not.
            "committed_minor": aggregate.committed.0.to_string(),
            "reserved_minor": aggregate.reserved.0.to_string(),
            "total_minor": aggregate.total().0.to_string(),
            "committed_payments": aggregate.payments,
        },
    })))
}

async fn get_workflow(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    let tenant_id = authenticated_tenant(&shared, &headers, "evidence:read").await?;
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
    let tenant_id = authenticated_tenant(&shared, &headers, "evidence:read").await?;
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

/// The address a guarded wallet must be constructed around.
///
/// Public and unauthenticated: it is a public key, the contract that
/// checks it is public, and a deployer needs it before there is a session
/// to authenticate against. Says so plainly when this gateway has none,
/// rather than 404, so the answer to "can this Moat co-sign?" is one call.
async fn cosigner(State(shared): State<Arc<Shared>>) -> Json<Value> {
    Json(match shared.cosign() {
        Some(key) => json!({ "cosign_address": key.address_hex(), "enabled": true }),
        None => json!({ "cosign_address": Value::Null, "enabled": false }),
    })
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
        .route("/v1/session/{id}/outcomes", get(get_outcomes))
        .route(
            "/v1/session/{id}/outcomes/{evidence_id}/reconcile",
            post(reconcile_outcome),
        )
        .route("/v1/session/{id}/cosign", post(cosign_verdict))
        .route("/v1/session/{id}/workflow", get(get_workflow))
        .route("/v1/session/{id}/evidence", get(get_evidence))
        .route("/v1/outcomes", get(get_tenant_outcomes))
        .route("/v1/authorizations/{id}", get(get_tenant_authorization))
        .route("/v1/cosigner", get(cosigner))
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
    tracing::info!(%local, "intent API listening");
    axum::serve(listener, router(shared))
        .await
        .context("intent API server")
}
