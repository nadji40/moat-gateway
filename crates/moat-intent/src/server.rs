//! The HTTP surface.
//!
//! `POST /v1/read` reads a message and returns the fields, and registers
//! nothing. It is for a host that shows the user what was understood and
//! asks them to confirm, then sends the confirmed fields to the gateway
//! itself. That is the strongest way to use this service.
//!
//! `POST /v1/session/{id}/intent` reads a message and registers it with the
//! gateway in one step, under the caller's own key. This service holds no
//! credential: the gateway checks the key it is given and the tenant it
//! belongs to, exactly as if the host had called it directly.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::reader::Reader;

/// The longest message read, the same limit the gateway applies.
pub const MAX_MESSAGE_CHARS: usize = 4000;

/// What the service needs.
pub struct AppState {
    /// The model.
    pub reader: Reader,
    /// The gateway's intent API, when this service registers intents.
    pub gateway: Option<String>,
    /// For talking to the gateway.
    pub http: reqwest::Client,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    text: String,
}

/// The routes.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/read", post(read))
        .route("/v1/session/{id}/intent", post(register))
        .with_state(state)
}

fn refuse(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn checked(text: &str) -> Result<&str, Box<Response>> {
    let text = text.trim();
    if text.is_empty() {
        return Err(Box::new(refuse(StatusCode::BAD_REQUEST, "text is empty")));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(Box::new(refuse(
            StatusCode::BAD_REQUEST,
            format!("text is over {MAX_MESSAGE_CHARS} characters"),
        )));
    }
    Ok(text)
}

async fn read(State(state): State<Arc<AppState>>, Json(body): Json<Message>) -> Response {
    let text = match checked(&body.text) {
        Ok(text) => text,
        Err(response) => return *response,
    };
    Json(state.reader.read(text).await).into_response()
}

async fn register(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Message>,
) -> Response {
    let Some(gateway) = &state.gateway else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "this reader is not connected to a gateway; start it with --gateway",
        );
    };
    let Some(authorization) = headers.get(header::AUTHORIZATION).cloned() else {
        return refuse(
            StatusCode::UNAUTHORIZED,
            "an approver key is required; it is passed to the gateway, which checks it",
        );
    };
    let text = match checked(&body.text) {
        Ok(text) => text,
        Err(response) => return *response,
    };
    let reading = state.reader.read(text).await;
    let url = format!(
        "{}/v1/session/{}/intent",
        gateway.trim_end_matches('/'),
        encode_path_segment(&id)
    );
    let forwarded = state
        .http
        .post(url)
        .header(header::AUTHORIZATION, authorization)
        .json(&json!({ "text": reading.record, "fields": reading.fields }))
        .send()
        .await;
    let (status, gateway_body) = match forwarded {
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (
                status,
                response.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
        Err(error) => {
            tracing::error!(%error, "the gateway could not be reached");
            return refuse(StatusCode::BAD_GATEWAY, "the gateway could not be reached");
        }
    };
    (
        status,
        Json(json!({
            "gateway": gateway_body,
            "status": reading.status,
            "fields": reading.fields,
            "dropped": reading.dropped,
            "cards_removed": reading.cards_removed,
        })),
    )
        .into_response()
}

/// Session ids are the gateway's own and are plain, but one that is not is
/// escaped rather than allowed to change the path.
fn encode_path_segment(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(b).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}
