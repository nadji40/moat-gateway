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
use std::pin::Pin;
use std::sync::{Arc, PoisonError};
use std::task::Poll;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures::Stream;
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
    /// Server-initiated lines, taken by the GET stream while a client holds
    /// one open and handed back when it goes away. `None` while taken.
    notifications: std::sync::Mutex<Option<mpsc::Receiver<String>>>,
    /// When a request last named this session.
    last_used: std::sync::Mutex<Instant>,
}

/// The notification stream for one session.
///
/// A client that drops its stream can open it again: the receiver goes back
/// to the session when this is dropped, and whatever arrived in between is
/// waiting in the channel for the next GET.
struct NotificationStream {
    rx: Option<mpsc::Receiver<String>>,
    session: Arc<Session>,
}

impl Stream for NotificationStream {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let Some(rx) = this.rx.as_mut() else {
            return Poll::Ready(None);
        };
        rx.poll_recv(cx).map(|line| {
            line.map(|line| Ok(Bytes::from(format!("event: message\ndata: {line}\n\n"))))
        })
    }
}

impl Drop for NotificationStream {
    fn drop(&mut self) {
        if let Some(rx) = self.rx.take() {
            *self
                .session
                .notifications
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(rx);
        }
    }
}

impl Session {
    fn touch(&self) {
        *self
            .last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed()
    }
}

struct Listener {
    cfg: Config,
    shared: Arc<Shared>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Sessions ended by DELETE in this process, and when. The durable row
    /// records the end too, and stays for audit; this is the answer for a
    /// gateway with no storage, and the fast one for a gateway with it.
    /// Forgotten after the idle timeout, like everything else here.
    ended_sessions: Mutex<HashMap<String, Instant>>,
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
            notifications: std::sync::Mutex::new(Some(rx)),
            last_used: std::sync::Mutex::new(Instant::now()),
        });
        self.sessions.lock().await.insert(id, Arc::clone(&s));
        Ok(s)
    }

    async fn session(&self, tenant_id: &str, id: &str) -> Result<Option<Arc<Session>>> {
        if self.ended_sessions.lock().await.contains_key(id) {
            return Ok(None);
        }
        if let Some(session) = self.sessions.lock().await.get(id).cloned() {
            session.touch();
            return Ok((session.tenant_id == tenant_id).then_some(session));
        }
        // Ended in another process, or in this one before the memory of it
        // was dropped: the row is still there for audit and must not come
        // back as a live session.
        if let Some(storage) = self.shared.storage() {
            if storage.session_ended(tenant_id, id).await? {
                return Ok(None);
            }
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
            s.touch();
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
                self.ended_sessions
                    .lock()
                    .await
                    .insert(id.to_owned(), Instant::now());
                if let Some(storage) = self.shared.storage() {
                    if let Err(error) = storage.end_session(&s.tenant_id, id).await {
                        tracing::error!(
                            %error, session = %id,
                            "session end was not recorded; a restart could bring it back"
                        );
                    }
                }
                tracing::info!(session = %id, "http session ended");
                true
            }
            None => false,
        }
    }

    /// Shut down and forget every session no request has named for `idle`,
    /// and forget ended sessions older than that.
    ///
    /// A session holds its upstream processes and its document in memory
    /// for as long as it exists, and an HTTP client that goes away does not
    /// say so. The durable snapshot is the session; what is dropped here is
    /// restored by the next request that names it. A session a request is
    /// using right now is left alone, however long ago it was last named.
    async fn evict_idle(&self, idle: Duration) -> usize {
        let mut evicted = Vec::new();
        {
            let mut sessions = self.sessions.lock().await;
            let stale: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| s.idle_for() >= idle && Arc::strong_count(s) == 1)
                .map(|(id, _)| id.clone())
                .collect();
            for id in stale {
                if let Some(s) = sessions.remove(&id) {
                    evicted.push((id, s));
                }
            }
        }
        for (id, s) in &evicted {
            s.gw.shutdown().await;
            self.shared.forget_session(&s.tenant_id, id).await;
            tracing::info!(session = %id, "idle http session dropped");
        }
        self.ended_sessions
            .lock()
            .await
            .retain(|_, ended| ended.elapsed() < idle);
        evicted.len()
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

async fn authenticated_caller(
    listener: &Listener,
    headers: &HeaderMap,
) -> Result<crate::storage::Caller, Box<Response>> {
    match listener
        .shared
        .authenticate_bearer(bearer(headers), "agent")
        .await
    {
        Ok(Some(caller)) => Ok(caller),
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

/// The scope a tool call needs, from the upstream its name is namespaced to.
///
/// `None` for anything that is not a `tools/call`, and for a name that resolves
/// to no upstream: an unroutable tool is the proxy's refusal to make, and
/// answering it here would report the wrong reason.
fn required_rail_scope(cfg: &Config, frame: &Frame) -> Option<String> {
    if frame.message.method() != Some(method::TOOLS_CALL) {
        return None;
    }
    let Message::Request(request) = &frame.message else {
        return None;
    };
    let name = request.params.as_ref()?.get("name")?.as_str()?;
    let (prefix, _) = name.split_once(cfg.separator.as_str())?;
    let upstream = cfg.upstreams.iter().find(|u| u.name == prefix)?;
    Some(format!("rail:{}", upstream.rail.as_str()))
}

/// The message to refuse a tool call with, or `None` to let it through.
fn rail_refusal(cfg: &Config, caller: &crate::storage::Caller, frame: &Frame) -> Option<String> {
    let needed = required_rail_scope(cfg, frame)?;
    if caller.may(&needed) {
        return None;
    }
    Some(format!(
        "this key is not scoped to {needed}. It carries: {}.",
        caller.scopes.join(", ")
    ))
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
    let caller = match authenticated_caller(&l, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    let tenant_id = caller.tenant_id.clone();
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

    // Rail scopes, checked here rather than deeper in, because a session
    // outlives the request that made it and may be reached by several of a
    // tenant's keys. What a key may do has to travel with the request, not
    // with the session it happens to be using.
    if let Some(refusal) = rail_refusal(&l.cfg, &caller, &frame) {
        return jsonrpc_error(StatusCode::FORBIDDEN, code::INVALID_REQUEST, &refusal);
    }

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
    let caller = match authenticated_caller(&l, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    let tenant_id = caller.tenant_id.clone();
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
    let taken = session
        .notifications
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    let Some(rx) = taken else {
        return (StatusCode::CONFLICT, "stream already open").into_response();
    };
    let stream = NotificationStream {
        rx: Some(rx),
        session: Arc::clone(&session),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn delete_mcp(State(l): State<Arc<Listener>>, headers: HeaderMap) -> Response {
    let caller = match authenticated_caller(&l, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    let tenant_id = caller.tenant_id.clone();
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

fn listener(cfg: Config, shared: Arc<Shared>) -> Arc<Listener> {
    Arc::new(Listener {
        cfg,
        shared,
        sessions: Mutex::new(HashMap::new()),
        ended_sessions: Mutex::new(HashMap::new()),
        default_session: Mutex::new(None),
    })
}

fn router_for(l: Arc<Listener>) -> Router {
    Router::new()
        .route(MCP_PATH, get(get_mcp).post(post_mcp).delete(delete_mcp))
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/keys", get(list_keys).post(create_key))
        .route("/v1/keys/{id}", axum::routing::delete(revoke_key))
        .route("/v1/signup", axum::routing::post(signup))
        .route("/v1/usage", get(usage))
        .route("/v1/verdicts", get(verdicts))
        .with_state(l)
}

/// How many verdicts this tenant's agents have produced, and how they went.
async fn usage(State(listener): State<Arc<Listener>>, headers: HeaderMap) -> Response {
    let caller = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    if let Some(refusal) = needs(&caller, "usage:read") {
        return refusal;
    }
    let tenant = caller.tenant_id.as_str();
    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it counts nothing");
    };
    match storage.usage_for(tenant).await {
        Ok(usage) => axum::Json(usage).into_response(),
        Err(error) => storage_unavailable(&error),
    }
}

/// The most recent verdicts, newest first.
///
/// A summary per line rather than the signed records themselves: the evidence
/// endpoint serves those, and a feed does not need a hundred of them to draw
/// a list.
async fn verdicts(State(listener): State<Arc<Listener>>, headers: HeaderMap) -> Response {
    let caller = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    if let Some(refusal) = needs(&caller, "verdicts:read") {
        return refusal;
    }
    let tenant = caller.tenant_id.as_str();
    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no verdicts");
    };
    match storage.recent_verdicts(tenant, 50).await {
        Ok(rows) => axum::Json(rows).into_response(),
        Err(error) => storage_unavailable(&error),
    }
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
    /// What the key may do inside that role. Absent or empty means all of it.
    #[serde(default)]
    scopes: Vec<String>,
    /// How many days the key works for, counted from now. Absent means it
    /// does not expire.
    #[serde(default)]
    expires_in_days: Option<i64>,
}

/// The longest a key may be issued for, in days: ten years. Longer than that
/// is "never" said with a number, and never is already on offer.
const MAX_EXPIRY_DAYS: i64 = 3650;

/// Check a requested expiry and turn it into what the database takes.
fn expiry_days(requested: Option<i64>) -> Result<Option<i32>, String> {
    match requested {
        None => Ok(None),
        Some(days) if (1..=MAX_EXPIRY_DAYS).contains(&days) => {
            Ok(Some(i32::try_from(days).map_err(|_| {
                "expires_in_days is out of range".to_owned()
            })?))
        }
        Some(_) => Err(format!(
            "expires_in_days must be a whole number of days from 1 to {MAX_EXPIRY_DAYS}, \
             or left out for a key that does not expire"
        )),
    }
}

/// The one and only time the raw key is returned.
#[derive(serde::Serialize)]
struct MintedKey {
    #[serde(flatten)]
    key: crate::storage::ApiKey,
    /// Store this now; it is not recoverable afterwards.
    secret: String,
}

/// A key as the control plane lists it: the record, plus whether it is the one
/// the caller is holding. The dashboard cannot work that out for itself, since
/// it has the secret and the list has only the id, and without the flag the
/// only way to find out is to revoke it and be locked out.
#[derive(serde::Serialize)]
struct ListedKey {
    #[serde(flatten)]
    key: crate::storage::ApiKey,
    /// True for the key that authenticated this request.
    current: bool,
}

/// Roles a key may be minted with. `admin` is here on purpose: a tenant that
/// cannot mint a second admin key has no way to rotate the first one without
/// calling us.
const ROLES: [&str; 3] = ["agent", "approver", "admin"];

/// What a key of each role may be narrowed to.
///
/// Only scopes this gateway actually checks are listed. A name that is
/// accepted at mint time and then never consulted is worse than no scope at
/// all: it reads on the key as a restriction that is not being applied.
///
/// The approver scopes are checked by the intent API, which is the trusted
/// side: what the user said and what a person approved arrive there, from
/// code the agent does not control. They split along a line that matters. A
/// harness that captures the user's words from the chat box and registers
/// them is a machine and needs `intent:write` and nothing more; releasing a
/// held payment is a person's decision, so `holds:release` belongs on the
/// approval screen's key and on no other. One approver key that did both let
/// the machine that registers intent also release holds.
fn scopes_for_role(role: &str) -> &'static [&'static str] {
    match role {
        "admin" => &["keys:read", "keys:write", "usage:read", "verdicts:read"],
        "agent" => &["rail:card", "rail:bank", "rail:crypto"],
        "approver" => &[
            "intent:write",
            "authorizations:write",
            "holds:release",
            "evidence:read",
        ],
        _ => &[],
    }
}

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
) -> Result<crate::storage::Caller, Box<Response>> {
    match listener
        .shared
        .authenticate_bearer(bearer(headers), "admin")
        .await
    {
        // The key id used to need a second query of its own. Authentication
        // already knows which key answered, so it says so.
        Ok(Some(caller)) => Ok(caller),
        Ok(None) => Err(Box::new(unauthorized())),
        Err(error) => Err(Box::new(storage_unavailable(&error))),
    }
}

/// Refuse a caller whose key was narrowed away from this endpoint.
///
/// Separate from the role check and always after it: a scope can only take
/// away. There is no scope that reaches a door the role does not open.
fn needs(caller: &crate::storage::Caller, scope: &str) -> Option<Response> {
    if caller.may(scope) {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            format!(
                "this key is not scoped to {scope}. It carries: {}.",
                caller.scopes.join(", ")
            ),
        )
            .into_response(),
    )
}

async fn create_key(
    State(listener): State<Arc<Listener>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let caller = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    if let Some(refusal) = needs(&caller, "keys:write") {
        return refusal;
    }
    let tenant = caller.tenant_id.as_str();
    let Ok(request) = serde_json::from_slice::<NewKey>(&body) else {
        return bad_request(
            "body must be {\"label\": string, \"access_role\": string, \"scopes\": [string], \"expires_in_days\": number}",
        );
    };
    let label = request.label.trim();
    if label.is_empty() || label.len() > 120 {
        return bad_request("label must be 1 to 120 characters");
    }
    if !ROLES.contains(&request.access_role.as_str()) {
        return bad_request("access_role must be agent, approver or admin");
    }
    let expires_in_days = match expiry_days(request.expires_in_days) {
        Ok(days) => days,
        Err(message) => return bad_request(&message),
    };

    // Scopes are checked against the role now, because this is the only moment
    // anyone is looking. A key minted with a scope its role can never reach
    // would sit in the list looking restricted and behave as though it were
    // not, and nothing later would ever say so.
    let allowed = scopes_for_role(&request.access_role);
    let mut scopes: Vec<String> = Vec::new();
    for scope in &request.scopes {
        let scope = scope.trim();
        if scope.is_empty() {
            continue;
        }
        if !allowed.contains(&scope) {
            return bad_request(&if allowed.is_empty() {
                format!(
                    "an {} key takes no scopes, because this gateway checks none for that role",
                    request.access_role
                )
            } else {
                format!(
                    "{scope:?} is not a scope an {} key can carry. Those are: {}.",
                    request.access_role,
                    allowed.join(", ")
                )
            });
        }
        if !scopes.iter().any(|held| held == scope) {
            scopes.push(scope.to_owned());
        }
    }
    // Naming every scope of a role is the same as naming none, and storing it
    // as none means one representation of "everything" rather than two that
    // have to be kept in step as the list of scopes grows.
    if scopes.len() == allowed.len() {
        scopes.clear();
    }

    // 32 bytes from the OS, rendered as hex. The database never sees this.
    let secret_bytes: [u8; 32] = rand::random();
    let secret = format!("moat_{}", moat_core::hash::sha256_hex(&secret_bytes));
    let hash = moat_core::hash::sha256_hex(secret.as_bytes());

    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no keys");
    };
    match storage
        .create_api_key(
            tenant,
            &crate::storage::NewApiKey {
                label,
                access_role: &request.access_role,
                key_hash: &hash,
                created_by: Some(caller.key_id.as_str()),
                scopes: &scopes,
                expires_in_days,
            },
        )
        .await
    {
        Ok(key) => {
            tracing::info!(tenant = %tenant, key = %key.id, role = %key.access_role, scopes = %key.scopes.join(","), expires_at = ?key.expires_at, "key minted");
            (StatusCode::CREATED, axum::Json(MintedKey { key, secret })).into_response()
        }
        Err(error) => storage_unavailable(&error),
    }
}

async fn list_keys(State(listener): State<Arc<Listener>>, headers: HeaderMap) -> Response {
    let caller = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    if let Some(refusal) = needs(&caller, "keys:read") {
        return refusal;
    }
    let tenant = caller.tenant_id.as_str();
    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no keys");
    };
    match storage.list_api_keys(tenant).await {
        Ok(keys) => {
            let listed: Vec<ListedKey> = keys
                .into_iter()
                .map(|key| ListedKey {
                    current: caller.key_id == key.id,
                    key,
                })
                .collect();
            axum::Json(listed).into_response()
        }
        Err(error) => storage_unavailable(&error),
    }
}

async fn revoke_key(
    State(listener): State<Arc<Listener>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Response {
    let caller = match admin_caller(&listener, &headers).await {
        Ok(caller) => caller,
        Err(response) => return *response,
    };
    if let Some(refusal) = needs(&caller, "keys:write") {
        return refusal;
    }
    let tenant = caller.tenant_id.as_str();
    // An admin key cannot withdraw itself. Revoking is an admin-only call, so
    // the caller would be destroying the one credential that reaches this
    // endpoint and would have no way to mint a replacement. Rotation still
    // works, in the order that leaves a way back: mint the new admin key
    // first, sign in with it, then revoke the old one.
    if caller.key_id == id {
        return (
            StatusCode::CONFLICT,
            "this is the key you are signed in with. Issue another admin key,              sign in with it, then revoke this one.",
        )
            .into_response();
    }
    let Some(storage) = listener.shared.storage() else {
        return bad_request("this gateway has no durable storage, so it has no keys");
    };
    match storage.revoke_api_key(tenant, &id).await {
        Ok(Some(key)) => {
            tracing::info!(tenant = %tenant, key = %key.id, "key revoked");
            axum::Json(key).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "no such key").into_response(),
        Err(error) => storage_unavailable(&error),
    }
}

/// Bind and serve until the process exits.
pub async fn serve(addr: &str, idle: Duration, cfg: Config, shared: Arc<Shared>) -> Result<()> {
    let socket = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding MCP listener on {addr}"))?;
    let local = socket.local_addr().context("MCP listener local address")?;
    tracing::info!(
        %local, path = MCP_PATH, idle_timeout_secs = idle.as_secs(),
        "streamable http listener ready"
    );
    let l = listener(cfg, shared);
    let sweeper = Arc::clone(&l);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(
            idle.min(Duration::from_secs(60))
                .max(Duration::from_secs(1)),
        );
        tick.tick().await;
        loop {
            tick.tick().await;
            sweeper.evict_idle(idle).await;
        }
    });
    axum::serve(socket, router_for(l))
        .await
        .context("MCP http server")
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::storage::Caller;

    fn cfg() -> Config {
        serde_norway::from_str(
            r#"
listen: { transport: http, addr: "127.0.0.1:0" }
upstreams:
  - { name: stripe, transport: http, url: "http://127.0.0.1:1/mcp", rail: card }
  - { name: chain, transport: http, url: "http://127.0.0.1:2/mcp", rail: crypto }
policy: policies/default.yaml
evidence: ./evidence.jsonl
keys: ./keys
"#,
        )
        .expect("test config parses")
    }

    fn frame(raw: &str) -> Frame {
        Frame {
            raw: raw.to_owned(),
            message: Message::parse(raw).expect("test frame parses"),
        }
    }

    fn call(tool: &str) -> Frame {
        frame(&format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{tool}","arguments":{{}}}}}}"#
        ))
    }

    fn key(scopes: &[&str]) -> Caller {
        Caller {
            tenant_id: "t".to_owned(),
            key_id: "key_1".to_owned(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// The scope comes from the upstream the tool is namespaced to, because
    /// that is where the rail is declared. Nothing about the call itself says
    /// which rail it settles on.
    #[test]
    fn the_rail_comes_from_the_upstream_the_tool_belongs_to() {
        let cfg = cfg();
        assert_eq!(
            required_rail_scope(&cfg, &call("stripe__create_payment")).as_deref(),
            Some("rail:card")
        );
        assert_eq!(
            required_rail_scope(&cfg, &call("chain__transfer")).as_deref(),
            Some("rail:crypto")
        );
    }

    /// An unroutable name is the proxy's refusal to make. Answering it here
    /// would tell the caller their key was wrong when the tool does not exist.
    #[test]
    fn a_tool_that_resolves_to_nothing_is_not_a_scope_failure() {
        let cfg = cfg();
        assert!(required_rail_scope(&cfg, &call("nosuch__tool")).is_none());
        assert!(required_rail_scope(&cfg, &call("unnamespaced")).is_none());
    }

    /// Only tool calls settle anything. Listing, initializing and notifying
    /// carry no rail and must not be gated by one.
    #[test]
    fn only_a_tool_call_needs_a_rail() {
        let cfg = cfg();
        for raw in [
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        ] {
            assert!(
                required_rail_scope(&cfg, &frame(raw)).is_none(),
                "{raw} carries no rail"
            );
        }
    }

    /// No expiry means a key that does not expire; a number of days in range
    /// is taken as given; zero, a negative number or more than ten years is
    /// refused rather than quietly clamped.
    #[test]
    fn an_expiry_is_a_whole_number_of_days_or_nothing() {
        assert_eq!(expiry_days(None), Ok(None));
        assert_eq!(expiry_days(Some(1)), Ok(Some(1)));
        assert_eq!(expiry_days(Some(30)), Ok(Some(30)));
        assert_eq!(expiry_days(Some(MAX_EXPIRY_DAYS)), Ok(Some(3650)));
        for bad in [0, -1, MAX_EXPIRY_DAYS + 1, i64::MAX] {
            assert!(expiry_days(Some(bad)).is_err(), "{bad} should be refused");
        }
    }

    /// A key with no scopes carries the whole of its role, which is what every
    /// key minted before scopes existed has.
    #[test]
    fn no_scopes_means_the_whole_role() {
        let cfg = cfg();
        assert!(rail_refusal(&cfg, &key(&[]), &call("chain__transfer")).is_none());
    }

    #[test]
    fn a_card_only_key_cannot_settle_on_chain() {
        let cfg = cfg();
        let k = key(&["rail:card"]);
        assert!(rail_refusal(&cfg, &k, &call("stripe__create_payment")).is_none());
        let refused = rail_refusal(&cfg, &k, &call("chain__transfer"))
            .expect("a card-only key must be refused the crypto rail");
        assert!(refused.contains("rail:crypto"), "{refused}");
        assert!(
            refused.contains("rail:card"),
            "the refusal says what the key does carry: {refused}"
        );
    }
}
