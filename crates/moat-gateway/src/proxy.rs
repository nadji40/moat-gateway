//! The proxy session: one MCP client on one side, N upstreams on the other.
//!
//! Everything the gateway does not explicitly understand is forwarded raw.
//! What it understands, it understands only enough to present N servers as
//! one: `initialize` and `server/discover` are fanned out and merged,
//! `tools/list` is fanned out and the names are namespaced, `tools/call` is
//! routed by namespace. The reply to a `tools/call` is relayed byte for byte.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use moat_core::money::Minor;
use moat_core::outcome::OutcomeStatus;
use moat_core::policy::ToolClass;
use moat_core::rail::Rail;
use moat_mcp::jsonrpc::code;
use moat_mcp::stdio::{Frame, FrameReader, FrameWriter};
use moat_mcp::types::{
    method, CallToolParams, DiscoverResult, Implementation, InitializeResult, ListToolsResult,
};
use moat_mcp::{ErrorObject, ErrorResponse, Message, Request, RequestId, Response};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::config::Config;
use crate::state::{PendingResume, PolicyState, Shared};
use crate::upstream::{Upstream, UpstreamEvent};

const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
struct AuthorizedPayment {
    evidence_id: String,
    authorization_id: Option<String>,
    invoice_id: Option<String>,
    invoice_fingerprint: Option<String>,
    amount_minor: Minor,
    reservation_fingerprint: Option<String>,
    /// How the money is leaving. Decided by the deployment at authorize
    /// time and carried here, because it is what says whether an ambiguous
    /// reply from the provider may be retried.
    rail: Rail,
}

/// How long an HTTP caller waits for the reply to one request before the
/// gateway gives up on it. Upstream tool calls can be slow; this is a
/// backstop, not a budget.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(300);

/// The most pages of one upstream's tool list that are walked. A server
/// that keeps handing out cursors past this is looping, not listing.
const MAX_TOOL_PAGES: usize = 64;

/// A running proxy session.
pub struct Gateway {
    upstreams: Vec<Arc<Upstream>>,
    separator: String,
    shared: Arc<Shared>,
    session_id: String,
    tenant_id: String,
    /// Raw lines destined for the client that no caller is waiting on: on
    /// stdio, everything; on HTTP, server notifications for the GET stream.
    /// One consumer drains this so concurrent handlers never interleave.
    out: mpsc::Sender<String>,
    /// Replies a transport caller is waiting for by id. Used by the HTTP
    /// listener, where each request is its own HTTP exchange. Empty on stdio.
    pending: Mutex<HashMap<RequestId, oneshot::Sender<String>>>,
    /// Upstream-originated request ids (legacy sampling/elicitation) mapped
    /// to the upstream index, so the client's reply can be routed back.
    upstream_requests: Mutex<HashMap<RequestId, usize>>,
    relay_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Gateway {
    /// Start every upstream for one session. Returns the gateway and the
    /// receiver for lines the transport must deliver to the client on its
    /// own initiative (everything on stdio; notifications on HTTP).
    pub async fn start(
        cfg: &Config,
        shared: Arc<Shared>,
        session_id: String,
    ) -> Result<(Arc<Gateway>, mpsc::Receiver<String>)> {
        Self::start_for_tenant(cfg, shared, session_id, "local".to_owned()).await
    }

    /// Start every upstream for one authenticated tenant session.
    pub async fn start_for_tenant(
        cfg: &Config,
        shared: Arc<Shared>,
        session_id: String,
        tenant_id: String,
    ) -> Result<(Arc<Gateway>, mpsc::Receiver<String>)> {
        let (events_tx, mut events_rx) = mpsc::channel(256);
        let mut upstreams = Vec::with_capacity(cfg.upstreams.len());
        for u in &cfg.upstreams {
            upstreams.push(Upstream::spawn(u, events_tx.clone()).await?);
        }
        drop(events_tx);

        let (out_tx, out_rx) = mpsc::channel::<String>(256);

        // Create the session up front so the intent API can find it even
        // before the first message arrives.
        shared
            .session_for_tenant(&tenant_id, &session_id, true)
            .await?
            .ok_or_else(|| anyhow::anyhow!("session belongs to another tenant"))?;
        let gw = Arc::new(Gateway {
            upstreams,
            separator: cfg.separator.clone(),
            shared,
            session_id,
            tenant_id,
            out: out_tx,
            pending: Mutex::new(HashMap::new()),
            upstream_requests: Mutex::new(HashMap::new()),
            relay_task: Mutex::new(None),
        });

        // Relay unsolicited upstream traffic to the client.
        let relay_gw = Arc::clone(&gw);
        let relay = tokio::spawn(async move {
            while let Some((name, ev)) = events_rx.recv().await {
                match ev {
                    UpstreamEvent::Notification(frame) => relay_gw.emit_raw(frame.raw).await,
                    UpstreamEvent::Request(frame) => {
                        if let Some(idx) = relay_gw.index_of(&name) {
                            if let Some(id) = frame.message.id() {
                                relay_gw
                                    .upstream_requests
                                    .lock()
                                    .await
                                    .insert(id.clone(), idx);
                            }
                        }
                        relay_gw.emit_raw(frame.raw).await;
                    }
                    UpstreamEvent::Closed => {
                        tracing::error!(upstream = %name, "upstream is gone; its tools will fail until restart");
                    }
                }
            }
        });
        *gw.relay_task.lock().await = Some(relay);
        Ok((gw, out_rx))
    }

    /// The session id this gateway serves.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Run a session over stdio-style streams until the client closes its
    /// side, then shut the upstreams down.
    pub async fn run<R, W>(
        cfg: Config,
        shared: Arc<Shared>,
        session_id: String,
        client_in: R,
        client_out: W,
    ) -> Result<()>
    where
        R: AsyncBufRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (gw, mut out_rx) = Gateway::start(&cfg, shared, session_id).await?;
        let writer_task = tokio::spawn(async move {
            let mut w = FrameWriter::new(client_out);
            while let Some(line) = out_rx.recv().await {
                if let Err(e) = w.write_raw(&line).await {
                    tracing::error!(error = %e, "writing to client failed");
                    break;
                }
            }
        });

        let mut reader = FrameReader::new(client_in);
        loop {
            match reader.next_frame().await {
                Ok(Some(frame)) => {
                    let gw = Arc::clone(&gw);
                    tokio::spawn(async move { gw.handle(frame).await });
                }
                Ok(None) => {
                    tracing::info!("client closed stdin; shutting down");
                    break;
                }
                Err(moat_mcp::Error::Json { .. }) => {
                    gw.emit(
                        ErrorResponse::new(
                            None,
                            ErrorObject::new(code::PARSE_ERROR, "Parse error", None),
                        )
                        .into(),
                    )
                    .await;
                }
                Err(moat_mcp::Error::Malformed(m)) => {
                    gw.emit(
                        ErrorResponse::new(None, ErrorObject::new(code::INVALID_REQUEST, m, None))
                            .into(),
                    )
                    .await;
                }
                Err(e) => {
                    tracing::error!(error = %e, "reading from client failed");
                    break;
                }
            }
        }

        gw.shutdown().await;
        drop(gw);
        let _ = writer_task.await;
        Ok(())
    }

    /// Handle one message from an HTTP caller. For a request, waits for and
    /// returns its reply line; for anything else, returns `None` once it has
    /// been dispatched. A request whose reply never comes gets an error
    /// response after [`REPLY_TIMEOUT`].
    pub async fn call(self: &Arc<Self>, frame: Frame) -> Option<String> {
        let Message::Request(req) = &frame.message else {
            self.handle(frame).await;
            return None;
        };
        let id = req.id.clone();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let gw = Arc::clone(self);
        tokio::spawn(async move { gw.handle(frame).await });

        match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
            Ok(Ok(line)) => Some(line),
            _ => {
                self.pending.lock().await.remove(&id);
                let err = ErrorResponse::new(
                    Some(id),
                    ErrorObject::new(code::INTERNAL_ERROR, "no reply from gateway", None),
                );
                Message::from(err).to_line().ok()
            }
        }
    }

    /// Stop every upstream and the relay. Idempotent.
    pub async fn shutdown(&self) {
        for u in &self.upstreams {
            u.shutdown(SHUTDOWN_GRACE).await;
        }
        if let Some(t) = self.relay_task.lock().await.take() {
            t.abort();
        }
    }

    fn index_of(&self, name: &str) -> Option<usize> {
        self.upstreams.iter().position(|u| u.name == name)
    }

    /// Deliver a line to the client: to a caller waiting on that reply id if
    /// there is one, otherwise to the transport's own channel.
    async fn emit_raw(&self, line: String) {
        {
            let mut pending = self.pending.lock().await;
            if !pending.is_empty() {
                if let Ok(msg) = Message::parse(&line) {
                    if let Some(id) = msg.id() {
                        if matches!(msg, Message::Response(_) | Message::Error(_)) {
                            if let Some(tx) = pending.remove(id) {
                                let _ = tx.send(line);
                                return;
                            }
                        }
                    }
                }
            }
        }
        if self.out.send(line).await.is_err() {
            tracing::debug!("no client consumer for a server-initiated line; dropped");
        }
    }

    async fn emit(&self, msg: Message) {
        match msg.to_line() {
            Ok(line) => self.emit_raw(line).await,
            Err(e) => tracing::error!(error = %e, "could not serialize reply"),
        }
    }

    async fn emit_error(
        &self,
        id: RequestId,
        code: i64,
        message: impl Into<String>,
        data: Option<Value>,
    ) {
        self.emit(ErrorResponse::new(Some(id), ErrorObject::new(code, message, data)).into())
            .await;
    }

    async fn handle(&self, frame: Frame) {
        match frame.message {
            Message::Request(ref req) => {
                let req = req.clone();
                match req.method.as_str() {
                    method::INITIALIZE => self.fan_out_initialize(req).await,
                    method::SERVER_DISCOVER => self.fan_out_discover(req).await,
                    method::TOOLS_LIST => self.fan_out_tools_list(req).await,
                    method::TOOLS_CALL => self.route_tools_call(req, &frame.raw).await,
                    method::PING => self.emit(Response::new(req.id, json!({})).into()).await,
                    _ => self.forward_other_request(req, &frame.raw).await,
                }
            }
            Message::Notification(_) => {
                // Notifications fan out to every upstream. `notifications/cancelled`
                // for a request only one upstream saw is ignored by the others.
                for u in &self.upstreams {
                    if u.is_alive() {
                        if let Err(e) = u.send_raw(&frame.raw).await {
                            tracing::warn!(upstream = %u.name, error = %e, "notification not delivered");
                        }
                    }
                }
            }
            Message::Response(_) | Message::Error(_) => {
                // The client answering a legacy upstream-originated request.
                let target = match frame.message.id() {
                    Some(id) => self.upstream_requests.lock().await.remove(id),
                    None => None,
                };
                match target.and_then(|i| self.upstreams.get(i)) {
                    Some(u) => {
                        if let Err(e) = u.send_raw(&frame.raw).await {
                            tracing::warn!(upstream = %u.name, error = %e, "client response not delivered");
                        }
                    }
                    None => {
                        tracing::warn!(id = ?frame.message.id(), "client response matches no upstream request; dropped")
                    }
                }
            }
        }
    }

    /// Send the client's request to every live upstream under a gateway id
    /// and collect `(upstream, reply)` pairs.
    async fn fan_out(&self, req: &Request) -> Vec<(Arc<Upstream>, Result<Frame>)> {
        let futures = self.upstreams.iter().filter(|u| u.is_alive()).map(|u| {
            let u = Arc::clone(u);
            let forwarded = Request::new(u.own_id(), req.method.clone(), req.params.clone());
            async move {
                let r = u.request(forwarded).await;
                (u, r)
            }
        });
        futures::future::join_all(futures).await
    }

    async fn fan_out_initialize(&self, req: Request) {
        let replies = self.fan_out(&req).await;
        let mut results: Vec<(String, InitializeResult)> = Vec::new();
        let mut first_error: Option<ErrorObject> = None;
        for (u, r) in replies {
            match r {
                Ok(Frame {
                    message: Message::Response(resp),
                    ..
                }) => match serde_json::from_value::<InitializeResult>(resp.result) {
                    Ok(init) => results.push((u.name.clone(), init)),
                    Err(e) => {
                        tracing::error!(upstream = %u.name, error = %e, "initialize result has an unexpected shape")
                    }
                },
                Ok(Frame {
                    message: Message::Error(e),
                    ..
                }) => {
                    tracing::error!(upstream = %u.name, code = e.error.code, message = %e.error.message, "initialize rejected");
                    first_error.get_or_insert(e.error);
                }
                Ok(_) => {}
                Err(e) => tracing::error!(upstream = %u.name, error = %e, "initialize failed"),
            }
        }
        if results.is_empty() {
            let err = first_error.unwrap_or_else(|| {
                ErrorObject::new(
                    code::INTERNAL_ERROR,
                    "no upstream completed initialize",
                    None,
                )
            });
            self.emit(ErrorResponse::new(Some(req.id), err).into())
                .await;
            return;
        }

        let version = results[0].1.protocol_version.clone();
        for (name, r) in &results[1..] {
            if r.protocol_version != version {
                tracing::warn!(
                    upstream = %name, theirs = %r.protocol_version, chosen = %version,
                    "upstreams negotiated different protocol versions; using the first"
                );
            }
        }
        let list_changed = results
            .iter()
            .any(|(_, r)| r.capabilities.pointer("/tools/listChanged") == Some(&Value::Bool(true)));
        let instructions = join_instructions(
            results
                .iter()
                .map(|(n, r)| (n.as_str(), r.instructions.as_deref())),
        );

        let merged = InitializeResult {
            protocol_version: version,
            capabilities: json!({ "tools": { "listChanged": list_changed } }),
            server_info: gateway_info(),
            instructions,
            extra: Map::new(),
        };
        match serde_json::to_value(merged) {
            Ok(v) => self.emit(Response::new(req.id, v).into()).await,
            Err(e) => {
                self.emit_error(req.id, code::INTERNAL_ERROR, e.to_string(), None)
                    .await
            }
        }
    }

    async fn fan_out_discover(&self, req: Request) {
        let replies = self.fan_out(&req).await;
        let mut results: Vec<(String, DiscoverResult)> = Vec::new();
        let mut first_error: Option<ErrorObject> = None;
        for (u, r) in replies {
            match r {
                Ok(Frame {
                    message: Message::Response(resp),
                    ..
                }) => match serde_json::from_value::<DiscoverResult>(resp.result) {
                    Ok(d) => results.push((u.name.clone(), d)),
                    Err(e) => {
                        tracing::error!(upstream = %u.name, error = %e, "discover result has an unexpected shape")
                    }
                },
                Ok(Frame {
                    message: Message::Error(e),
                    ..
                }) => {
                    first_error.get_or_insert(e.error);
                }
                Ok(_) => {}
                Err(e) => tracing::error!(upstream = %u.name, error = %e, "discover failed"),
            }
        }
        if results.is_empty() {
            // A legacy-only upstream answers server/discover with some error;
            // relay the first one so a dual-era client falls back correctly.
            let err = first_error.unwrap_or_else(|| {
                ErrorObject::new(
                    code::METHOD_NOT_FOUND,
                    "Method not found: server/discover",
                    None,
                )
            });
            self.emit(ErrorResponse::new(Some(req.id), err).into())
                .await;
            return;
        }
        // Versions every upstream supports; fall back to the first's list.
        let mut versions = results[0].1.supported_versions.clone();
        for (_, r) in &results[1..] {
            versions.retain(|v| r.supported_versions.contains(v));
        }
        if versions.is_empty() {
            versions = results[0].1.supported_versions.clone();
            tracing::warn!("upstreams share no protocol version; advertising the first upstream's");
        }
        let instructions = join_instructions(
            results
                .iter()
                .map(|(n, r)| (n.as_str(), r.instructions.as_deref())),
        );
        let merged = DiscoverResult {
            result_type: Some("complete".to_owned()),
            supported_versions: versions,
            capabilities: json!({ "tools": {} }),
            instructions,
            extra: {
                let mut m = Map::new();
                m.insert(
                    "_meta".to_owned(),
                    json!({ moat_mcp::types::meta::SERVER_INFO: gateway_info() }),
                );
                m
            },
        };
        match serde_json::to_value(merged) {
            Ok(v) => self.emit(Response::new(req.id, v).into()).await,
            Err(e) => {
                self.emit_error(req.id, code::INTERNAL_ERROR, e.to_string(), None)
                    .await
            }
        }
    }

    /// One further page of an upstream's tool list.
    async fn tools_page(&self, u: &Arc<Upstream>, cursor: &str) -> Result<ListToolsResult> {
        let frame = u
            .request(Request::new(
                u.own_id(),
                method::TOOLS_LIST,
                Some(json!({"cursor": cursor})),
            ))
            .await?;
        match frame.message {
            Message::Response(resp) => serde_json::from_value(resp.result)
                .map_err(|e| anyhow::anyhow!("tools/list page has an unexpected shape: {e}")),
            Message::Error(e) => anyhow::bail!(
                "tools/list page rejected: {} ({})",
                e.error.message,
                e.error.code
            ),
            _ => anyhow::bail!("tools/list page was answered with something other than a response"),
        }
    }

    async fn fan_out_tools_list(&self, req: Request) {
        // A client's cursor is ignored: cursors are per upstream and cannot
        // be aggregated. Every upstream's pages are walked here instead, so
        // the merged list is the whole list and never carries a cursor.
        let mut params = req.params_object();
        if params.remove("cursor").is_some() {
            tracing::warn!(
                "tools/list cursor ignored: pagination is not aggregated across upstreams"
            );
        }
        let stripped = Request::new(
            req.id.clone(),
            req.method.clone(),
            Some(Value::Object(params)),
        );
        let replies = self.fan_out(&stripped).await;

        let mut tools = Vec::new();
        let mut any_ok = false;
        let mut first_error: Option<ErrorObject> = None;
        for (u, r) in replies {
            match r {
                Ok(Frame {
                    message: Message::Response(resp),
                    ..
                }) => match serde_json::from_value::<ListToolsResult>(resp.result) {
                    Ok(first) => {
                        any_ok = true;
                        let mut all = first.tools;
                        let mut cursor = first.next_cursor;
                        let mut pages = 1;
                        while let Some(next) = cursor.take() {
                            pages += 1;
                            if pages > MAX_TOOL_PAGES {
                                tracing::error!(upstream = %u.name, pages, "tools/list keeps paging; stopping here");
                                break;
                            }
                            match self.tools_page(&u, &next).await {
                                Ok(page) => {
                                    all.extend(page.tools);
                                    cursor = page.next_cursor;
                                }
                                Err(e) => {
                                    tracing::error!(upstream = %u.name, error = %e, "a later page of tools/list failed; listing what was read");
                                    break;
                                }
                            }
                        }
                        for mut t in all {
                            if self.shared.policies.classify(&u.name, &t.name)
                                == ToolClass::Unclassified
                            {
                                tracing::warn!(upstream = %u.name, tool = %t.name, "tool is in neither payment_tools nor non_payment_tools; hidden and refused");
                                continue;
                            }
                            t.name = format!("{}{}{}", u.name, self.separator, t.name);
                            tools.push(t);
                        }
                    }
                    Err(e) => {
                        tracing::error!(upstream = %u.name, error = %e, "tools/list result has an unexpected shape")
                    }
                },
                Ok(Frame {
                    message: Message::Error(e),
                    ..
                }) => {
                    tracing::error!(upstream = %u.name, code = e.error.code, message = %e.error.message, "tools/list rejected");
                    first_error.get_or_insert(e.error);
                }
                Ok(_) => {}
                Err(e) => tracing::error!(upstream = %u.name, error = %e, "tools/list failed"),
            }
        }
        if !any_ok {
            let err = first_error.unwrap_or_else(|| {
                ErrorObject::new(
                    code::INTERNAL_ERROR,
                    "no upstream answered tools/list",
                    None,
                )
            });
            self.emit(ErrorResponse::new(Some(req.id), err).into())
                .await;
            return;
        }
        let merged = ListToolsResult {
            tools,
            next_cursor: None,
            extra: Map::new(),
        };
        match serde_json::to_value(merged) {
            Ok(v) => self.emit(Response::new(req.id, v).into()).await,
            Err(e) => {
                self.emit_error(req.id, code::INTERNAL_ERROR, e.to_string(), None)
                    .await
            }
        }
    }

    /// Split `upstream__tool` into its parts.
    fn resolve_tool<'a>(&self, namespaced: &'a str) -> Option<(Arc<Upstream>, &'a str)> {
        let (prefix, tool) = namespaced.split_once(self.separator.as_str())?;
        let u = self.upstreams.iter().find(|u| u.name == prefix)?;
        Some((Arc::clone(u), tool))
    }

    async fn route_tools_call(&self, req: Request, _raw: &str) {
        let params: CallToolParams = match req.params.clone().map(serde_json::from_value) {
            Some(Ok(p)) => p,
            Some(Err(e)) => {
                self.emit_error(
                    req.id,
                    code::INVALID_PARAMS,
                    format!("invalid tools/call params: {e}"),
                    None,
                )
                .await;
                return;
            }
            None => {
                self.emit_error(
                    req.id,
                    code::INVALID_PARAMS,
                    "tools/call requires params",
                    None,
                )
                .await;
                return;
            }
        };
        let Some((upstream, tool)) = self
            .resolve_tool(&params.name)
            .map(|(u, t)| (u, t.to_owned()))
        else {
            self.emit_error(
                req.id,
                code::INVALID_PARAMS,
                format!("Unknown tool: {}", params.name),
                None,
            )
            .await;
            return;
        };

        let mut forwarded = params;
        forwarded.name = tool.clone();

        // Payment tools go through policy before anything is forwarded. Both
        // which policy applies and which rail the money leaves on come from
        // the upstream, never from the call.
        let class = self.shared.policies.classify(&upstream.name, &tool);
        if class == ToolClass::Unclassified {
            tracing::warn!(upstream = %upstream.name, %tool, "refused a tool the policy does not classify");
            self.emit_error(
                req.id,
                moat_core::verdict::code::DENY,
                format!(
                    "Moat refused {}{}{tool}: the policy lists it neither as a payment nor as moving no money",
                    upstream.name, self.separator
                ),
                Some(json!({"moat": {
                    "verdict": "deny",
                    "reasons": ["unclassified-tool"],
                    "evidence_id": null,
                }})),
            )
            .await;
            return;
        }
        let authorization = if class == ToolClass::Payment {
            let args = forwarded.arguments.clone().unwrap_or_default();
            match self
                .authorize(&req.id, &upstream.name, &tool, upstream.rail, args)
                .await
            {
                Some(authorized) => Some(authorized),
                None => return,
            }
        } else {
            None
        };

        let line = match serde_json::to_value(&forwarded)
            .map_err(anyhow::Error::from)
            .and_then(|p| {
                Message::Request(Request::new(req.id.clone(), req.method.clone(), Some(p)))
                    .to_line()
                    .map_err(anyhow::Error::from)
            }) {
            Ok(l) => l,
            Err(e) => {
                if let Some(authorization) = &authorization {
                    self.release_provider_reservation(authorization).await;
                }
                self.emit_error(req.id, code::INTERNAL_ERROR, e.to_string(), None)
                    .await;
                return;
            }
        };

        // The reply is relayed exactly as the upstream wrote it, after every
        // value in it has been registered as observed.
        match upstream.request_raw(req.id.clone(), &line).await {
            Ok(frame) => {
                if let Message::Response(resp) = &frame.message {
                    self.observe(&upstream.name, &tool, &req.id, &resp.result)
                        .await;
                    if let Some(authorization) = &authorization {
                        self.record_provider_response(authorization, &upstream.name, &resp.result)
                            .await;
                    }
                } else if let Some(authorization) = &authorization {
                    self.record_provider_failure(authorization, &upstream.name, "provider_error")
                        .await;
                }
                self.emit_raw(frame.raw).await
            }
            Err(e) => {
                if let Some(authorization) = &authorization {
                    self.record_provider_failure(authorization, &upstream.name, "transport_error")
                        .await;
                }
                self.emit_error(req.id, code::INTERNAL_ERROR, e.to_string(), None)
                    .await;
            }
        }
    }

    /// Register every string and number in a tool result as observed.
    async fn observe(&self, server: &str, tool: &str, call_id: &RequestId, result: &Value) {
        let session = self.shared.store.get_or_create(&self.session_id);
        let leaves = {
            moat_core::session::lock(&session).observe_tool_result(
                server,
                tool,
                &call_id.to_string(),
                result,
            )
        };
        let sha = moat_core::hash::sha256_hex(moat_core::hash::canonical_json(result).as_bytes());
        tracing::info!(
            session = %self.session_id, server, tool, call_id = %call_id, leaves,
            result_sha256 = %sha, "tool result observed"
        );
        if let Err(error) = self
            .shared
            .persist_session(&self.tenant_id, &self.session_id)
            .await
        {
            tracing::error!(%error, session = %self.session_id, "tool observation was not persisted");
        }
    }

    /// Record the provider-side result for a structured authorization.
    async fn record_provider_response(
        &self,
        authorized: &AuthorizedPayment,
        provider: &str,
        result: &Value,
    ) {
        let Some(authorization_id) = &authorized.authorization_id else {
            return;
        };
        let Some(invoice_id) = &authorized.invoice_id else {
            return;
        };
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = result
            .pointer("/structuredContent/status")
            .and_then(Value::as_str)
            .unwrap_or(if is_error {
                "provider_error"
            } else {
                "unknown"
            });
        let receipt = result
            .pointer("/structuredContent/receipt")
            .and_then(Value::as_str)
            .map(str::to_owned);
        // An error reply tells Moat nothing about the money, whatever
        // status string came with it.
        let kind = if is_error {
            OutcomeStatus::Unknown
        } else {
            OutcomeStatus::from_provider(status)
        };
        let succeeded = kind == OutcomeStatus::Succeeded;
        let disposition = kind.disposition(authorized.rail);
        let session = self.shared.store.get_or_create(&self.session_id);
        let outcome = moat_core::session::PaymentOutcome {
            authorization_id: authorization_id.clone(),
            invoice_id: invoice_id.clone(),
            invoice_fingerprint: authorized.invoice_fingerprint.clone(),
            amount_minor: authorized.amount_minor,
            evidence_id: authorized.evidence_id.clone(),
            provider: provider.to_owned(),
            receipt,
            status: status.to_owned(),
            succeeded,
            status_kind: kind,
            committed: disposition.committed,
            quarantined: disposition.quarantined,
            rail: authorized.rail,
            unix_ms: now_unix_ms(),
            reconciled_unix_ms: None,
        };
        {
            let mut session = moat_core::session::lock(&session);
            if let Some(fingerprint) = &authorized.reservation_fingerprint {
                session.finish_reserved_payment(fingerprint, outcome);
            } else {
                session.record_payment_outcome(outcome);
            }
        }
        tracing::info!(
            session = %self.session_id,
            %authorization_id,
            %invoice_id,
            evidence_id = %authorized.evidence_id,
            provider,
            status,
            succeeded,
            kind = %kind,
            committed = disposition.committed,
            quarantined = disposition.quarantined,
            rail = authorized.rail.as_str(),
            "payment provider outcome recorded"
        );
        if let Err(error) = self
            .shared
            .persist_session(&self.tenant_id, &self.session_id)
            .await
        {
            tracing::error!(%error, session = %self.session_id, "provider outcome was not persisted");
        }
    }

    /// Record the absence of an answer.
    ///
    /// A transport error or a malformed reply means Moat asked a provider
    /// to move money and does not know whether it did. On a card that is
    /// safe to treat as "it did not": the authorization either never took
    /// or can be reversed, and the agent may try again. On a rail where
    /// nothing comes back it is not safe, so the payment is counted and
    /// quarantined, and no further payment goes out under that
    /// authorization until somebody reconciles it.
    async fn record_provider_failure(
        &self,
        authorized: &AuthorizedPayment,
        provider: &str,
        status: &str,
    ) {
        let Some(authorization_id) = &authorized.authorization_id else {
            return;
        };
        let Some(invoice_id) = &authorized.invoice_id else {
            return;
        };
        let disposition = OutcomeStatus::Unknown.disposition(authorized.rail);
        let session = self.shared.store.get_or_create(&self.session_id);
        let outcome = moat_core::session::PaymentOutcome {
            authorization_id: authorization_id.clone(),
            invoice_id: invoice_id.clone(),
            invoice_fingerprint: authorized.invoice_fingerprint.clone(),
            amount_minor: authorized.amount_minor,
            evidence_id: authorized.evidence_id.clone(),
            provider: provider.to_owned(),
            receipt: None,
            status: status.to_owned(),
            succeeded: false,
            status_kind: OutcomeStatus::Unknown,
            committed: disposition.committed,
            quarantined: disposition.quarantined,
            rail: authorized.rail,
            unix_ms: now_unix_ms(),
            reconciled_unix_ms: None,
        };
        {
            let mut session = moat_core::session::lock(&session);
            if let Some(fingerprint) = &authorized.reservation_fingerprint {
                session.finish_reserved_payment(fingerprint, outcome);
            } else {
                session.record_payment_outcome(outcome);
            }
        }
        if disposition.quarantined {
            tracing::warn!(
                session = %self.session_id,
                %authorization_id,
                %invoice_id,
                evidence_id = %authorized.evidence_id,
                provider,
                status,
                rail = authorized.rail.as_str(),
                "payment outcome is unknown on an irreversible rail; held and \
                 quarantined, and this authorization is blocked until it is reconciled"
            );
        } else {
            tracing::warn!(
                session = %self.session_id,
                %authorization_id,
                %invoice_id,
                evidence_id = %authorized.evidence_id,
                provider,
                status,
                rail = authorized.rail.as_str(),
                "payment provider failure recorded; authorization remains retryable"
            );
        }
        if let Err(error) = self
            .shared
            .persist_session(&self.tenant_id, &self.session_id)
            .await
        {
            tracing::error!(%error, session = %self.session_id, "provider failure was not persisted");
        }
    }

    async fn release_provider_reservation(&self, authorized: &AuthorizedPayment) {
        let Some(fingerprint) = &authorized.reservation_fingerprint else {
            return;
        };
        let session = self.shared.store.get_or_create(&self.session_id);
        {
            moat_core::session::lock(&session).release_payment_reservation(fingerprint);
        }
        if let Err(error) = self
            .shared
            .persist_session(&self.tenant_id, &self.session_id)
            .await
        {
            tracing::error!(%error, session = %self.session_id, "reservation release was not persisted");
        }
    }

    /// Release a reservation from the session and from the tenant ledger.
    ///
    /// Both, always. A reservation released in only one of the two leaves
    /// the mandate holding value against a payment that is not happening --
    /// in the session it blocks this agent, and in the ledger it blocks
    /// every other session under the tenant, which is worse and harder to
    /// see.
    async fn release_reservation_everywhere(
        &self,
        session: &std::sync::Arc<std::sync::Mutex<moat_core::session::Session>>,
        fingerprint: &str,
    ) {
        moat_core::session::lock(session).release_payment_reservation(fingerprint);
        if let Some(storage) = self.shared.storage() {
            if let Err(error) = storage
                .release_reservation(&self.tenant_id, fingerprint)
                .await
            {
                tracing::error!(
                    %error, tenant = %self.tenant_id, fingerprint,
                    concat!(
                        "could not release the ledger reservation; it will ",
                        "hold against the mandate until it is cleared",
                    )
                );
            }
        }
    }

    /// Whether the tenant's ledger has room for this payment, taking the
    /// reservation if it does.
    ///
    /// Returns the refusal to record when it does not. The limit is
    /// computed the way `policy.rs` computes it -- the declared aggregate
    /// limit, or the maximum single payment times the permitted count --
    /// so the two agree about what the mandate is worth.
    ///
    /// Without durable storage there is nothing to contend over and this
    /// is a no-op: a single process with one document in memory is already
    /// serialised by the session lock.
    async fn refuse_beyond_tenant_aggregate(
        &self,
        session: &std::sync::Arc<std::sync::Mutex<moat_core::session::Session>>,
        eval: &moat_core::policy::Evaluation,
        fingerprint: &str,
        amount: moat_core::money::Minor,
    ) -> Option<String> {
        let storage = self.shared.storage()?;
        let authorization_id = eval
            .call
            .args
            .get("authorization_id")
            .and_then(Value::as_str)?
            .to_owned();
        let limit = {
            let s = moat_core::session::lock(session);
            let authorization = s.payment_authorization(&authorization_id)?;
            authorization.aggregate_limit_minor.unwrap_or_else(|| {
                authorization
                    .amount_minor
                    .saturating_add(authorization.tolerance_minor)
                    .saturating_mul(u128::from(authorization.max_payments))
            })
        };
        match storage
            .reserve_if_within(
                &self.tenant_id,
                &authorization_id,
                fingerprint,
                &self.session_id,
                amount,
                limit,
            )
            .await
        {
            Ok(Some(_before)) => None,
            Ok(None) => Some(format!(
                concat!(
                    "this tenant's committed and in-flight payments under {} already ",
                    "reach the mandate's limit of {}; another session may hold what ",
                    "this one is asking for"
                ),
                authorization_id, limit.0
            )),
            Err(error) => {
                // Fail closed. The ledger is the only thing that can see
                // what other sessions are doing, and an allow issued
                // without it is an allow issued without the check.
                tracing::error!(
                    %error, tenant = %self.tenant_id, authorization_id,
                    "could not reserve against the payment ledger; denying"
                );
                Some("the payment ledger could not be reached to check the mandate".to_owned())
            }
        }
    }

    /// Evaluate a payment call. Returns its evidence context if it may be
    /// forwarded; on `step_up` or `deny` the error has already been sent to
    /// the client.
    async fn authorize(
        &self,
        id: &RequestId,
        server: &str,
        tool: &str,
        rail: Rail,
        args: Map<String, Value>,
    ) -> Option<AuthorizedPayment> {
        use moat_core::policy::{
            evaluate_with, payment_amount, payment_fingerprint, EvalContext, PaymentCall,
        };
        use moat_core::session::PaymentReservation;
        use moat_core::verdict::{code as moat_code, Decision};

        let call = PaymentCall {
            server: server.to_owned(),
            tool: tool.to_owned(),
            call_id: id.to_string(),
            args,
        };
        let session = self.shared.store.get_or_create(&self.session_id);
        let now = now_unix_ms();
        {
            let expired = moat_core::session::lock(&session).expire_payment_reservations(now);
            if expired > 0 {
                tracing::warn!(
                    session = %self.session_id, expired,
                    "dropped reservations no payment could still be in flight for"
                );
            }
        }
        // A mandate registered in an earlier session lives in the ledger,
        // not in this session's document. Fetch it before evaluating, or
        // this call is judged against an authorization Moat has simply not
        // looked for -- which fails closed, but fails closed on a mandate
        // the user really did grant.
        let mut ledger_failure = None;
        if let Some(authorization_id) = call.args.get("authorization_id").and_then(Value::as_str) {
            if let Err(error) = self
                .shared
                .hydrate_authorization(&self.tenant_id, &session, authorization_id)
                .await
            {
                tracing::error!(
                    %error, tenant = %self.tenant_id, authorization_id,
                    "could not read the payment ledger; denying"
                );
                ledger_failure = Some(format!("{error:#}"));
            }
        }

        let (eval, reservation_fingerprint, proposed_minor) =
            match self.shared.policies.for_upstream(server) {
                PolicyState::Loaded(_) if ledger_failure.is_some() => (
                    refused_evaluation(
                        call,
                        "ledger-unavailable",
                        format!(
                        "the payment ledger could not be reached to look up the authorization: {}",
                        ledger_failure.unwrap_or_default()
                    ),
                        now,
                        rail,
                    ),
                    None,
                    None,
                ),
                PolicyState::Loaded(policy) => {
                    let mut s = moat_core::session::lock(&session);
                    let mut eval =
                        evaluate_with(policy, &s, call, now, &EvalContext::for_rail(rail));
                    let amount = payment_amount(policy, &eval.call).map(|(_, minor)| minor);
                    let mut reservation_fingerprint = None;
                    if eval.verdict.decision == Decision::Allow {
                        let authorization_id = eval
                            .call
                            .args
                            .get("authorization_id")
                            .and_then(Value::as_str);
                        let invoice_id = eval.call.args.get("invoice_id").and_then(Value::as_str);
                        if let (Some(authorization_id), Some(invoice_id)) =
                            (authorization_id, invoice_id)
                        {
                            let fingerprint = payment_fingerprint(&eval.call);
                            let reservation = amount.map(|amount_minor| PaymentReservation {
                                fingerprint: fingerprint.clone(),
                                authorization_id: authorization_id.to_owned(),
                                invoice_id: invoice_id.to_owned(),
                                invoice_fingerprint: eval
                                    .call
                                    .args
                                    .get("invoice_fingerprint")
                                    .and_then(Value::as_str)
                                    .map(|value| value.trim().to_ascii_lowercase()),
                                amount_minor,
                                reserved_unix_ms: now,
                            });
                            // Two different failures used to share one message
                            // here, and the shared message named neither. A
                            // payment with no readable amount cannot be
                            // reserved, and saying "could not be reserved" about
                            // it sent the reader to the reservation code when
                            // the fault was in the field mapping.
                            let reserved = match reservation {
                                Some(reservation) => s.reserve_payment(reservation),
                                None => false,
                            };
                            if reserved {
                                reservation_fingerprint = Some(fingerprint);
                            } else {
                                let message = if amount.is_none() {
                                    concat!(
                                        "amount or currency could not be read through ",
                                        "the policy's field mapping, so nothing could be reserved",
                                    )
                                } else {
                                    concat!(
                                        "an identical payment is already in flight; ",
                                        "it could not be reserved a second time",
                                    )
                                };
                                eval.verdict.decision = Decision::Deny;
                                eval.verdict.reasons.push(moat_core::verdict::RuleOutcome {
                                    id: "authorization-reservation".to_owned(),
                                    field: None,
                                    passed: false,
                                    source: None,
                                    on_fail: Decision::Deny,
                                    message: message.to_owned(),
                                });
                            }
                        }
                    }
                    (eval, reservation_fingerprint, amount)
                }
                PolicyState::Missing(why) => {
                    tracing::error!(
                        server,
                        tool,
                        %rail,
                        "payment tool called with no usable policy: DENIED ({why})"
                    );
                    (policy_missing_evaluation(call, why, now, rail), None, None)
                }
            };

        // The same reservation again, this time against the tenant's ledger
        // rather than this session's document.
        //
        // The in-session reservation above stops one session sending the
        // same payment twice. It cannot stop two sessions each spending the
        // whole allowance, because each reads its own document and both see
        // it unspent. This does, by computing the aggregate and taking the
        // reservation inside one row lock on the authorization.
        //
        // Only reached on an allow that already reserved locally, so the
        // common path costs one statement and the contended path is the one
        // that pays for the lock.
        let mut eval = eval;
        let mut reservation_fingerprint = reservation_fingerprint;
        if let (Some(fingerprint), Some(amount)) = (&reservation_fingerprint, proposed_minor) {
            if let Some(refusal) = self
                .refuse_beyond_tenant_aggregate(&session, &eval, fingerprint, amount)
                .await
            {
                self.release_reservation_everywhere(&session, fingerprint)
                    .await;
                reservation_fingerprint = None;
                eval.verdict.decision = Decision::Deny;
                eval.verdict.reasons.push(moat_core::verdict::RuleOutcome {
                    id: "authorization-tenant-aggregate".to_owned(),
                    field: None,
                    passed: false,
                    source: None,
                    on_fail: Decision::Deny,
                    message: refusal,
                });
            }
        }

        let record = match self.shared.record(&session, &eval) {
            Ok(r) => r,
            Err(e) => {
                if let Some(fingerprint) = &reservation_fingerprint {
                    self.release_reservation_everywhere(&session, fingerprint)
                        .await;
                }
                // No verdict without evidence: if evidence cannot be written,
                // the payment does not happen.
                tracing::error!(error = %e, "evidence write failed; denying");
                self.emit_error(
                    id.clone(),
                    moat_code::DENY,
                    "Moat could not write evidence; payment refused",
                    Some(json!({"moat": {"verdict": "deny", "reasons": [format!("evidence: {e}")], "evidence_id": null}})),
                )
                .await;
                return None;
            }
        };

        let durable_result = async {
            self.shared
                .persist_evidence(&self.tenant_id, &record)
                .await?;
            self.shared
                .persist_session(&self.tenant_id, &self.session_id)
                .await
        }
        .await;
        if let Err(error) = durable_result {
            if let Some(fingerprint) = &reservation_fingerprint {
                {
                    self.release_reservation_everywhere(&session, fingerprint)
                        .await;
                }
                let _ = self
                    .shared
                    .persist_session(&self.tenant_id, &self.session_id)
                    .await;
            }
            tracing::error!(%error, "durable decision write failed; denying");
            self.emit_error(
                id.clone(),
                moat_code::DENY,
                "Moat could not persist the decision; payment refused",
                Some(json!({"moat": {
                    "verdict": "deny",
                    "reasons": [format!("durable storage: {error}")],
                    "evidence_id": record.id,
                }})),
            )
            .await;
            return None;
        }

        let verdict = &eval.verdict;
        let failing: Vec<&str> = verdict.failures().map(|r| r.message.as_str()).collect();
        tracing::info!(
            session = %self.session_id, server, tool, call_id = %id,
            verdict = %verdict.decision, evidence_id = %record.id,
            failing = ?failing, "payment evaluated"
        );

        match verdict.decision {
            Decision::Allow => Some(AuthorizedPayment {
                evidence_id: record.id.clone(),
                authorization_id: eval
                    .call
                    .args
                    .get("authorization_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                invoice_id: eval
                    .call
                    .args
                    .get("invoice_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                invoice_fingerprint: eval
                    .call
                    .args
                    .get("invoice_fingerprint")
                    .and_then(Value::as_str)
                    .map(|value| value.trim().to_ascii_lowercase()),
                amount_minor: proposed_minor.unwrap_or(Minor::ZERO),
                reservation_fingerprint,
                rail,
            }),
            Decision::StepUp => {
                let values: Vec<(String, Value)> = eval
                    .provenance
                    .iter()
                    .map(|(field, p)| (field.clone(), p.resolution.value.clone()))
                    .collect();
                let token = match self
                    .shared
                    .new_resume(
                        &self.tenant_id,
                        PendingResume {
                            session: self.session_id.clone(),
                            evidence_id: record.id.clone(),
                            payment_fingerprint: moat_core::policy::payment_fingerprint(&eval.call),
                            values,
                        },
                    )
                    .await
                {
                    Ok(token) => token,
                    Err(error) => {
                        tracing::error!(%error, "approval token could not be persisted");
                        self.emit_error(
                            id.clone(),
                            moat_code::DENY,
                            "Moat could not persist approval state; payment refused",
                            Some(json!({"moat": {
                                "verdict": "deny",
                                "reasons": [format!("approval storage: {error}")],
                                "evidence_id": record.id,
                            }})),
                        )
                        .await;
                        return None;
                    }
                };
                self.emit_error(
                    id.clone(),
                    moat_code::STEP_UP,
                    "Moat: payment needs human approval",
                    Some(json!({"moat": {
                        "verdict": "step_up",
                        "prompt": verdict.step_up_prompt,
                        "evidence_id": record.id,
                        "resume_token": token,
                        "session": self.session_id,
                    }})),
                )
                .await;
                None
            }
            Decision::Deny => {
                self.emit_error(
                    id.clone(),
                    moat_code::DENY,
                    "Moat: payment denied",
                    Some(json!({"moat": {
                        "verdict": "deny",
                        "reasons": verdict.failures().collect::<Vec<_>>(),
                        "evidence_id": record.id,
                        "session": self.session_id,
                    }})),
                )
                .await;
                None
            }
        }
    }

    /// Anything not understood goes to the first live upstream, raw, and its
    /// reply comes back raw. With several upstreams this is a guess, and the
    /// log says so.
    async fn forward_other_request(&self, req: Request, raw: &str) {
        let Some(u) = self.upstreams.iter().find(|u| u.is_alive()) else {
            self.emit_error(req.id, code::INTERNAL_ERROR, "no live upstream", None)
                .await;
            return;
        };
        if self.upstreams.len() > 1 {
            tracing::warn!(method = %req.method, upstream = %u.name, "method is not aggregated; forwarded to the first upstream");
        }
        match u.request_raw(req.id.clone(), raw).await {
            Ok(frame) => self.emit_raw(frame.raw).await,
            Err(e) => {
                self.emit_error(req.id, code::INTERNAL_ERROR, e.to_string(), None)
                    .await
            }
        }
    }
}

fn gateway_info() -> Implementation {
    Implementation::new("moat-gateway", env!("CARGO_PKG_VERSION"))
}

/// Milliseconds since the Unix epoch. Shared with the intent API so the
/// two never disagree about what "now" is within a session.
pub(crate) fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The evaluation recorded when a payment tool is called and no policy could
/// be loaded: a single failing rule, verdict deny, so the refusal still has
/// evidence behind it.
fn policy_missing_evaluation(
    call: moat_core::policy::PaymentCall,
    why: &str,
    now: u64,
    rail: Rail,
) -> moat_core::policy::Evaluation {
    refused_evaluation(
        call,
        "policy-unavailable",
        format!("no usable policy: {why}"),
        now,
        rail,
    )
}

/// A deny that no rule produced: the gateway could not evaluate at all, and
/// says so with evidence rather than with silence.
fn refused_evaluation(
    call: moat_core::policy::PaymentCall,
    rule_id: &str,
    message: String,
    now: u64,
    rail: Rail,
) -> moat_core::policy::Evaluation {
    use moat_core::verdict::{Decision, RuleOutcome, Verdict};
    let seed = format!("{}|{}|{}|{now}", call.server, call.tool, call.call_id);
    let evidence_id = format!("ev_{}", &moat_core::hash::sha256_hex(seed.as_bytes())[..24]);
    moat_core::policy::Evaluation {
        call,
        provenance: std::collections::BTreeMap::new(),
        verdict: Verdict {
            decision: Decision::Deny,
            reasons: vec![RuleOutcome {
                id: rule_id.to_owned(),
                field: None,
                passed: false,
                source: None,
                on_fail: Decision::Deny,
                message,
            }],
            step_up_prompt: None,
            evidence_id,
        },
        unix_ms: now,
        rail,
    }
}

fn join_instructions<'a>(
    parts: impl Iterator<Item = (&'a str, Option<&'a str>)>,
) -> Option<String> {
    let joined: Vec<String> = parts
        .filter_map(|(name, text)| text.map(|t| format!("[{name}] {t}")))
        .collect();
    if joined.is_empty() {
        None
    } else {
        Some(joined.join("\n\n"))
    }
}
