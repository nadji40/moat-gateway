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

use std::collections::{HashMap, HashSet};
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
    tenant_id: String,
    /// Server-initiated lines, taken by the GET stream when a client opens
    /// one. `None` once taken.
    notifications: Mutex<Option<mpsc::Receiver<String>>>,
}

struct Listener {
    cfg: Config,
    shared: Arc<Shared>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Sessions explicitly terminated during this process lifetime. Durable
    /// state remains available for audit/recovery after a process restart, but
    /// DELETE must not immediately resurrect the session in the same process.
    ended_sessions: Mutex<HashSet<String>>,
    default_session: Mutex<Option<Arc<Session>>>,
}

impl Listener {
    async fn new_session(&self, tenant_id: String, id: String) -> Result<Arc<Session>> {
        let (gw, rx) = Gateway::start_for_tenant(
            &self.cfg,
            Arc::clone(&self.shared),
            id.clone(),
            tenant_id.clone(),
        )
        .await?;
        tracing::info!(session = %id, "http session started");
        let s = Arc::new(Session {
            gw,
            tenant_id,
            notifications: Mutex::new(Some(rx)),
        });
        self.sessions.lock().await.insert(id, Arc::clone(&s));
        Ok(s)
    }

    async fn session(&self, tenant_id: &str, id: &str) -> Result<Option<Arc<Session>>> {
        if self.ended_sessions.lock().await.contains(id) {
            return Ok(None);
        }
        if let Some(session) = self.sessions.lock().await.get(id).cloned() {
            return Ok((session.tenant_id == tenant_id).then_some(session));
        }
        if self
            .shared
            .session_for_tenant(tenant_id, id, false)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.new_session(tenant_id.to_owned(), id.to_owned())
            .await
            .map(Some)
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
        let s = self.new_session("local".to_owned(), id).await?;
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
                self.ended_sessions.lock().await.insert(id.to_owned());
                tracing::info!(session = %id, "http session ended");
                true
            }
            None => false,
        }
    }
}

fn generate_id(prefix: &str) -> String {
    let random: [u8; 24] = rand::random();
    format!("{prefix}_{}", moat_core::hash::sha256_hex(&random))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        "valid Moat bearer token required",
    )
        .into_response()
}

async fn authenticated_tenant(
    listener: &Listener,
    headers: &HeaderMap,
) -> Result<String, Box<Response>> {
    match listener
        .shared
        .authenticate_bearer(bearer(headers), "agent")
        .await
    {
        Ok(Some(tenant)) => Ok(tenant),
        Ok(None) => Err(Box::new(unauthorized())),
        Err(error) => {
            tracing::error!(%error, "authentication storage unavailable");
            Err(Box::new(
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "authentication unavailable",
                )
                    .into_response(),
            ))
        }
    }
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
    let tenant_id = match authenticated_tenant(&l, &headers).await {
        Ok(tenant) => tenant,
        Err(response) => return *response,
    };
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
        match l.new_session(tenant_id.clone(), generate_id("s")).await {
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
        match l.session(&tenant_id, &id).await {
            Ok(Some(s)) => s,
            Err(error) => {
                tracing::error!(%error, session = %id, "could not restore session");
                return jsonrpc_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    code::INTERNAL_ERROR,
                    "session storage unavailable",
                );
            }
            Ok(None) => {
                return jsonrpc_error(
                    StatusCode::NOT_FOUND,
                    code::INVALID_REQUEST,
                    "unknown session",
                )
            }
        }
    } else if l.shared.auth_required() {
        return jsonrpc_error(
            StatusCode::BAD_REQUEST,
            code::INVALID_REQUEST,
            "Mcp-Session-Id required after initialize",
        );
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
    let tenant_id = match authenticated_tenant(&l, &headers).await {
        Ok(tenant) => tenant,
        Err(response) => return *response,
    };
    let Some(id) = session_header(&headers) else {
        return (StatusCode::BAD_REQUEST, "Mcp-Session-Id required").into_response();
    };
    let session = match l.session(&tenant_id, &id).await {
        Ok(Some(session)) => session,
        Ok(None) => return (StatusCode::NOT_FOUND, "unknown session").into_response(),
        Err(error) => {
            tracing::error!(%error, session = %id, "could not restore session");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
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
    let tenant_id = match authenticated_tenant(&l, &headers).await {
        Ok(tenant) => tenant,
        Err(response) => return *response,
    };
    let Some(id) = session_header(&headers) else {
        return (StatusCode::BAD_REQUEST, "Mcp-Session-Id required").into_response();
    };
    match l.session(&tenant_id, &id).await {
        Ok(Some(_)) if l.end_session(&id).await => StatusCode::OK.into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, "unknown session").into_response(),
        Err(error) => {
            tracing::error!(%error, session = %id, "could not restore session");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

async fn live() -> StatusCode {
    StatusCode::OK
}

async fn ready(State(listener): State<Arc<Listener>>) -> StatusCode {
    match listener.shared.storage_ready().await {
        Ok(()) => StatusCode::OK,
        Err(error) => {
            tracing::error!(%error, "readiness check failed");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

/// Build the router. Exposed for tests.
pub fn router(cfg: Config, shared: Arc<Shared>) -> Router {
    let l = Arc::new(Listener {
        cfg,
        shared,
        sessions: Mutex::new(HashMap::new()),
        ended_sessions: Mutex::new(HashSet::new()),
        default_session: Mutex::new(None),
    });
    Router::new()
        .route(MCP_PATH, get(get_mcp).post(post_mcp).delete(delete_mcp))
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/keys", get(list_keys).post(create_key))
        .route("/v1/keys/{id}", axum::routing::delete(revoke_key))
        .route("/v1/signup", axum::routing::post(signup))
        .with_state(l)
}

/// What a stranger sends to get a workspace.
#[derive(serde::Deserialize)]
struct Signup {
    /// The workspace id, and the only thing the caller picks. Lowercase,
    /// 3 to 64 characters; the table enforces the same pattern.
    id: String,
    /// A display name for their own benefit.
    name: String,
}

/// Create a tenant and hand back its first `admin` key.
///
/// The only endpoint that writes for a caller holding no credential, so it is
/// off unless `auth.self_signup` says otherwise, and it refuses when the
/// gateway has no database rather than pretending to have made something.
async fn signup(State(listener): State<Arc<Listener>>, body: Bytes) -> Response {
    if !listener.cfg.auth.self_signup {
        return (
            StatusCode::NOT_FOUND,
            "self-service signup is not enabled on this gateway",
        )
            .into_response();
    }
    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no tenants");
    };
    let Ok(request) = serde_json::from_slice::<Signup>(&body) else {
        return bad_request("body must be {\"id\": string, \"name\": string}");
    };

    let id = request.id.trim().to_lowercase();
    // The same shape the tenants table checks, applied here so the caller gets
    // a sentence instead of a constraint violation.
    let shaped = id.len() >= 3
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        && id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !shaped {
        return bad_request(
            "id must be 3 to 64 characters of lowercase letters, digits, _ or -, \
             and start with a letter or digit",
        );
    }
    let name = request.name.trim();
    if name.is_empty() || name.len() > 120 {
        return bad_request("name must be 1 to 120 characters");
    }

    let secret_bytes: [u8; 32] = rand::random();
    let secret = format!("moat_{}", moat_core::hash::sha256_hex(&secret_bytes));
    let hash = moat_core::hash::sha256_hex(secret.as_bytes());

    match storage.create_tenant(&id, name, &hash).await {
        Ok(Some(key)) => {
            tracing::info!(tenant = %id, "tenant created through self-service signup");
            (StatusCode::CREATED, axum::Json(MintedKey { key, secret })).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            format!("the workspace id {id} is taken"),
        )
            .into_response(),
        Err(error) => storage_unavailable(&error),
    }
}

// ---- the control plane ----
//
// Three calls, all requiring an `admin` key and all scoped to the tenant that
// key belongs to. There is no tenant parameter anywhere: a caller can only
// ever act on their own keys, so a wrong or guessed id cannot reach another
// tenant's credentials.
//
// This deliberately does not create tenants. A tenant is still provisioned by
// somebody with database access, because that is the step that decides who is
// a customer; the control plane only manages credentials inside one.

/// What a caller asks for when minting a key.
#[derive(serde::Deserialize)]
struct NewKey {
    /// Whatever the tenant wants to call it, for their own listing.
    label: String,
    /// `agent`, `approver` or `admin`.
    access_role: String,
}

/// The one and only time the raw key is returned.
#[derive(serde::Serialize)]
struct MintedKey {
    #[serde(flatten)]
    key: crate::storage::ApiKey,
    /// Store this now; it is not recoverable afterwards.
    secret: String,
}

/// Roles a key may be minted with. `admin` is here on purpose: a tenant that
/// cannot mint a second admin key has no way to rotate the first one without
/// calling us.
const ROLES: [&str; 3] = ["agent", "approver", "admin"];

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, message.to_owned()).into_response()
}

fn storage_unavailable(error: &anyhow::Error) -> Response {
    tracing::error!(%error, "control plane storage unavailable");
    (StatusCode::SERVICE_UNAVAILABLE, "storage unavailable").into_response()
}

/// Authenticate an `admin` key and return both the tenant and the key id that
/// authenticated, so a minted key records who minted it.
async fn admin_caller(
    listener: &Listener,
    headers: &HeaderMap,
) -> Result<(String, Option<String>), Box<Response>> {
    match listener
        .shared
        .authenticate_bearer(bearer(headers), "admin")
        .await
    {
        Ok(Some(tenant)) => {
            let id = listener
                .shared
                .key_id_for_bearer(bearer(headers))
                .await
                .unwrap_or(None);
            Ok((tenant, id))
        }
        Ok(None) => Err(Box::new(unauthorized())),
        Err(error) => Err(Box::new(storage_unavailable(&error))),
    }
}

async fn create_key(
    State(listener): State<Arc<Listener>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (tenant, by) = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    let Ok(request) = serde_json::from_slice::<NewKey>(&body) else {
        return bad_request("body must be {\"label\": string, \"access_role\": string}");
    };
    let label = request.label.trim();
    if label.is_empty() || label.len() > 120 {
        return bad_request("label must be 1 to 120 characters");
    }
    if !ROLES.contains(&request.access_role.as_str()) {
        return bad_request("access_role must be agent, approver or admin");
    }

    // 32 bytes from the OS, rendered as hex. The database never sees this.
    let secret_bytes: [u8; 32] = rand::random();
    let secret = format!("moat_{}", moat_core::hash::sha256_hex(&secret_bytes));
    let hash = moat_core::hash::sha256_hex(secret.as_bytes());

    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no keys");
    };
    match storage
        .create_api_key(&tenant, label, &request.access_role, &hash, by.as_deref())
        .await
    {
        Ok(key) => {
            tracing::info!(tenant = %tenant, key = %key.id, role = %key.access_role, "key minted");
            (StatusCode::CREATED, axum::Json(MintedKey { key, secret })).into_response()
        }
        Err(error) => storage_unavailable(&error),
    }
}

async fn list_keys(State(listener): State<Arc<Listener>>, headers: HeaderMap) -> Response {
    let (tenant, _) = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no keys");
    };
    match storage.list_api_keys(&tenant).await {
        Ok(keys) => axum::Json(keys).into_response(),
        Err(error) => storage_unavailable(&error),
    }
}

async fn revoke_key(
    State(listener): State<Arc<Listener>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Response {
    let (tenant, _) = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no keys");
    };
    match storage.revoke_api_key(&tenant, &id).await {
        Ok(Some(key)) => {
            tracing::info!(tenant = %tenant, key = %key.id, "key revoked");
            axum::Json(key).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "no such key").into_response(),
        Err(error) => storage_unavailable(&error),
    }
}

/// Bind and serve until the process exits.
pub async fn serve(addr: &str, cfg: Config, shared: Arc<Shared>) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding MCP listener on {addr}"))?;
    let local = listener
        .local_addr()
        .context("MCP listener local address")?;
    if !local.ip().is_loopback() && !shared.auth_required() {
        tracing::warn!(%local, "MCP listener is not loopback and authentication is disabled");
    }
    tracing::info!(%local, path = MCP_PATH, "streamable http listener ready");
    axum::serve(listener, router(cfg, shared))
        .await
        .context("MCP http server")
}
