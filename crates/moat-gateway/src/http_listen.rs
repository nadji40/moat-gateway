//! Streamable HTTP on the listen side, for hosts that cannot spawn a process.
//!
//! Serves the transport in the `2025-11-25` shape, because that is what the
//! MCP TypeScript SDK's `StreamableHTTPClientTransport` speaks today (ADR
//! 0002): `POST /mcp` carries one JSON-RPC message; a request gets its reply
//! as a JSON body, a notification gets `202`; `initialize` mints a session
//! and returns it in `Mcp-Session-Id`, which later requests echo; `GET /mcp`
//! opens an SSE stream for server-initiated notifications; `DELETE /mcp`
//! ends the session.
//!
//! Each MCP session is its own [`Gateway`], with its own upstream processes
//! and its own Moat session id — the `Mcp-Session-Id` value — which is what
//! the host uses with the intent API. A request that arrives with no session
//! header and is not `initialize` is served by a lazily created default
//! session, so a modern-era client (no handshake) still works in a degraded,
//! single-session way.
//!
//! `Origin` is validated as the spec requires: absent is fine (non-browser
//! clients), loopback is fine, anything else is refused.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures::stream::StreamExt;
use moat_mcp::jsonrpc::code;
use moat_mcp::stdio::Frame;
use moat_mcp::types::method;
use moat_mcp::{ErrorObject, ErrorResponse, Message};
use tokio::sync::{mpsc, Mutex};

use crate::config::Config;
use crate::proxy::Gateway;
use crate::state::Shared;

/// Header carrying the session id, both directions.
pub const SESSION_HEADER: &str = "mcp-session-id";
/// The one path served.
pub const MCP_PATH: &str = "/mcp";

struct Session {
    gw: Arc<Gateway>,
    /// Server-initiated lines, taken by the GET stream when a client opens
    /// one. `None` once taken.
    notifications: Mutex<Option<mpsc::Receiver<String>>>,
}

struct Listener {
    cfg: Config,
    shared: Arc<Shared>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    default_session: Mutex<Option<Arc<Session>>>,
}

impl Listener {
    async fn new_session(&self, id: String) -> Result<Arc<Session>> {
        let (gw, rx) = Gateway::start(&self.cfg, Arc::clone(&self.shared), id.clone()).await?;
        tracing::info!(session = %id, "http session started");
        let s = Arc::new(Session {
            gw,
            notifications: Mutex::new(Some(rx)),
        });
        self.sessions.lock().await.insert(id, Arc::clone(&s));
        Ok(s)
    }

    async fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().await.get(id).cloned()
    }

    async fn default_session(&self) -> Result<Arc<Session>> {
        let mut slot = self.default_session.lock().await;
        if let Some(s) = slot.as_ref() {
            return Ok(Arc::clone(s));
        }
        let id = self
            .cfg
            .session_id
            .clone()
            .unwrap_or_else(|| generate_id("s"));
        tracing::warn!(session = %id, "request without Mcp-Session-Id; serving from the default session");
        let s = self.new_session(id).await?;
        *slot = Some(Arc::clone(&s));
        Ok(s)
    }

    async fn end_session(&self, id: &str) -> bool {
        let removed = self.sessions.lock().await.remove(id);
        let mut slot = self.default_session.lock().await;
        if slot.as_ref().is_some_and(|s| s.gw.session_id() == id) {
            slot.take();
        }
        drop(slot);
        match removed {
            Some(s) => {
                s.gw.shutdown().await;
                tracing::info!(session = %id, "http session ended");
                true
            }
            None => false,
        }
    }
}

fn generate_id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let h = moat_core::hash::sha256_hex(format!("{nanos}|{}", std::process::id()).as_bytes());
    format!("{prefix}_{}", &h[..24])
}

fn jsonrpc_error(status: StatusCode, code: i64, message: &str) -> Response {
    let body = Message::from(ErrorResponse::new(
        None,
        ErrorObject::new(code, message, None),
    ))
    .to_line()
    .unwrap_or_default();
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = origin
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split(':')
        .next()
        .unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

fn session_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

async fn post_mcp(State(l): State<Arc<Listener>>, headers: HeaderMap, body: Bytes) -> Response {
    if !origin_allowed(&headers) {
        return jsonrpc_error(
            StatusCode::FORBIDDEN,
            code::INVALID_REQUEST,
            "Origin not allowed",
        );
    }
    let text = match std::str::from_utf8(&body) {
        Ok(t) => t.trim(),
        Err(_) => {
            return jsonrpc_error(
                StatusCode::BAD_REQUEST,
                code::PARSE_ERROR,
                "body is not UTF-8",
            )
        }
    };
    if text.starts_with('[') {
        return jsonrpc_error(
            StatusCode::BAD_REQUEST,
            code::INVALID_REQUEST,
            "batches are not supported",
        );
    }
    let message = match Message::parse(text) {
        Ok(m) => m,
        Err(moat_mcp::Error::Json { .. }) => {
            return jsonrpc_error(StatusCode::BAD_REQUEST, code::PARSE_ERROR, "Parse error")
        }
        Err(e) => {
            return jsonrpc_error(
                StatusCode::BAD_REQUEST,
                code::INVALID_REQUEST,
                &e.to_string(),
            )
        }
    };
    let frame = Frame {
        raw: text.to_owned(),
        message,
    };

    // Resolve the session: initialize mints one; otherwise the header names
    // one; otherwise the default.
    let is_initialize = frame.message.method() == Some(method::INITIALIZE);
    let session = if is_initialize {
        match l.new_session(generate_id("s")).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "could not start session");
                return jsonrpc_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    code::INTERNAL_ERROR,
                    "could not start upstreams",
                );
            }
        }
    } else if let Some(id) = session_header(&headers) {
        match l.session(&id).await {
            Some(s) => s,
            None => {
                return jsonrpc_error(
                    StatusCode::NOT_FOUND,
                    code::INVALID_REQUEST,
                    "unknown session",
                )
            }
        }
    } else {
        match l.default_session().await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "could not start default session");
                return jsonrpc_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    code::INTERNAL_ERROR,
                    "could not start upstreams",
                );
            }
        }
    };

    let sid = session.gw.session_id().to_owned();
    match session.gw.call(frame).await {
        Some(line) => {
            let mut resp = (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                line,
            )
                .into_response();
            if let Ok(v) = HeaderValue::from_str(&sid) {
                resp.headers_mut().insert(SESSION_HEADER, v);
            }
            resp
        }
        None => {
            let mut resp = StatusCode::ACCEPTED.into_response();
            if let Ok(v) = HeaderValue::from_str(&sid) {
                resp.headers_mut().insert(SESSION_HEADER, v);
            }
            resp
        }
    }
}

/// The standalone stream for server-initiated notifications. One per
/// session; a second GET while the first is open gets 409.
async fn get_mcp(State(l): State<Arc<Listener>>, headers: HeaderMap) -> Response {
    if !origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(id) = session_header(&headers) else {
        return (StatusCode::BAD_REQUEST, "Mcp-Session-Id required").into_response();
    };
    let Some(session) = l.session(&id).await else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    let Some(rx) = session.notifications.lock().await.take() else {
        return (StatusCode::CONFLICT, "stream already open").into_response();
    };
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx).map(|line| {
        Ok::<Bytes, Infallible>(Bytes::from(format!("event: message\ndata: {line}\n\n")))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn delete_mcp(State(l): State<Arc<Listener>>, headers: HeaderMap) -> Response {
    let Some(id) = session_header(&headers) else {
        return (StatusCode::BAD_REQUEST, "Mcp-Session-Id required").into_response();
    };
    if l.end_session(&id).await {
        StatusCode::OK.into_response()
    } else {
        (StatusCode::NOT_FOUND, "unknown session").into_response()
    }
}

/// Build the router. Exposed for tests.
pub fn router(cfg: Config, shared: Arc<Shared>) -> Router {
    let l = Arc::new(Listener {
        cfg,
        shared,
        sessions: Mutex::new(HashMap::new()),
        default_session: Mutex::new(None),
    });
    Router::new()
        .route(MCP_PATH, get(get_mcp).post(post_mcp).delete(delete_mcp))
        .with_state(l)
}

/// Bind and serve until the process exits.
pub async fn serve(addr: &str, cfg: Config, shared: Arc<Shared>) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding MCP listener on {addr}"))?;
    let local = listener
        .local_addr()
        .context("MCP listener local address")?;
    if !local.ip().is_loopback() {
        tracing::warn!(%local, "MCP listener is not bound to loopback; there is no authentication");
    }
    tracing::info!(%local, path = MCP_PATH, "streamable http listener ready");
    axum::serve(listener, router(cfg, shared))
        .await
        .context("MCP http server")
}
