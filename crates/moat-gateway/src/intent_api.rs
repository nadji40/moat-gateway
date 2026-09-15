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
use moat_core::session::lock;
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
