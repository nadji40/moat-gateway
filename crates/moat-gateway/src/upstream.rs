//! A connected upstream MCP server, over stdio (a child process with
//! request/response correlation) or Streamable HTTP (one POST per message).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use moat_core::rail::Rail;
use moat_mcp::http::HttpClient;
use moat_mcp::jsonrpc::code;
use moat_mcp::process::ChildTransport;
use moat_mcp::stdio::{Frame, FrameWriter};
use moat_mcp::{ErrorObject, ErrorResponse, Message, Request, RequestId};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::config::{Upstream as UpstreamConfig, UpstreamTransport};

/// Something an upstream sent that was not a reply to us.
#[derive(Debug)]
pub enum UpstreamEvent {
    /// A notification, to be relayed to the client.
    Notification(Frame),
    /// A request (legacy era: sampling, elicitation), to be relayed to the
    /// client so it can answer.
    Request(Frame),
    /// The upstream's stdout closed.
    Closed,
}

struct StdioLink {
    writer: Mutex<FrameWriter<ChildStdin>>,
    pending: Mutex<HashMap<RequestId, oneshot::Sender<Frame>>>,
    process: Mutex<Option<ChildTransport>>,
    alive: AtomicBool,
}

enum Link {
    Stdio(Box<StdioLink>),
    Http(Box<HttpClient>),
}

/// Handle to one running upstream.
pub struct Upstream {
    /// The configured name; also the tool namespace.
    pub name: String,
    /// The settlement rail this upstream moves money on, from the config.
    pub rail: Rail,
    link: Link,
    next_id: AtomicU64,
}

impl Upstream {
    /// Connect the upstream. For stdio this spawns the process and starts a
    /// reader task; unsolicited messages go to `events` tagged with the
    /// upstream name. For HTTP nothing is sent until the first message.
    pub async fn spawn(
        cfg: &UpstreamConfig,
        events: mpsc::Sender<(String, UpstreamEvent)>,
    ) -> Result<Arc<Upstream>> {
        match &cfg.transport {
            UpstreamTransport::Stdio { command, env } => {
                let mut cmd = command.clone();
                // Environment is applied by wrapping in `env` so ChildTransport
                // stays a plain "command + args" spawner.
                if !env.is_empty() {
                    let mut wrapped = vec!["env".to_owned()];
                    wrapped.extend(env.iter().map(|(k, v)| format!("{k}={v}")));
                    wrapped.extend(cmd);
                    cmd = wrapped;
                }
                let mut transport = ChildTransport::spawn(&cmd, &cfg.name)
                    .with_context(|| format!("starting upstream {:?}", cfg.name))?;
                let (mut reader, writer) = transport
                    .split()
                    .ok_or_else(|| anyhow!("upstream {:?}: transport already split", cfg.name))?;
                let pid = transport.id();

                let up = Arc::new(Upstream {
                    name: cfg.name.clone(),
                    rail: cfg.rail,
                    link: Link::Stdio(Box::new(StdioLink {
                        writer: Mutex::new(writer),
                        pending: Mutex::new(HashMap::new()),
                        process: Mutex::new(Some(transport)),
                        alive: AtomicBool::new(true),
                    })),
                    next_id: AtomicU64::new(1),
                });

                let reader_up = Arc::clone(&up);
                tokio::spawn(async move {
                    loop {
                        let raw = match reader.next_line().await {
                            Ok(Some(raw)) => raw,
                            Ok(None) => break,
                            Err(e) => {
                                tracing::error!(upstream = %reader_up.name, error = %e, "upstream read failed");
                                break;
                            }
                        };
                        match Message::parse(&raw) {
                            Ok(message) => {
                                reader_up.dispatch(Frame { raw, message }, &events).await
                            }
                            Err(e) => reader_up.refuse_unparseable(&raw, &e).await,
                        }
                    }
                    if let Link::Stdio(s) = &reader_up.link {
                        s.alive.store(false, Ordering::SeqCst);
                        s.pending.lock().await.clear();
                    }
                    let _ = events
                        .send((reader_up.name.clone(), UpstreamEvent::Closed))
                        .await;
                    tracing::warn!(upstream = %reader_up.name, "upstream closed its stdout");
                });

                tracing::info!(upstream = %cfg.name, ?pid, "upstream started");
                Ok(up)
            }
            UpstreamTransport::Http { url } => {
                let client = HttpClient::new(url)
                    .with_context(|| format!("upstream {:?}: http client", cfg.name))?;
                tracing::info!(upstream = %cfg.name, %url, "http upstream configured");
                Ok(Arc::new(Upstream {
                    name: cfg.name.clone(),
                    rail: cfg.rail,
                    link: Link::Http(Box::new(client)),
                    next_id: AtomicU64::new(1),
                }))
            }
        }
    }

    async fn dispatch(&self, frame: Frame, events: &mpsc::Sender<(String, UpstreamEvent)>) {
        match &frame.message {
            Message::Response(_) | Message::Error(_) => {
                let waiter = match (&self.link, frame.message.id()) {
                    (Link::Stdio(s), Some(id)) => s.pending.lock().await.remove(id),
                    _ => None,
                };
                match waiter {
                    Some(tx) => {
                        let _ = tx.send(frame);
                    }
                    None => tracing::warn!(
                        upstream = %self.name,
                        id = ?frame.message.id(),
                        "response with no pending request; dropped"
                    ),
                }
            }
            Message::Notification(_) => {
                let _ = events
                    .send((self.name.clone(), UpstreamEvent::Notification(frame)))
                    .await;
            }
            Message::Request(_) => {
                let _ = events
                    .send((self.name.clone(), UpstreamEvent::Request(frame)))
                    .await;
            }
        }
    }

    /// A line from the upstream that is not a message. The spec forbids it,
    /// and a proxy has no one to report it to except the log.
    ///
    /// If the line carries the id of a request that is waiting, that request
    /// is answered with an error now. Left alone, its caller would wait the
    /// whole reply timeout for a reply that has already come and gone. A
    /// line with no usable id is dropped: a server that logs to stdout by
    /// mistake is a nuisance, and failing whatever happened to be in flight
    /// would make it a breakage.
    async fn refuse_unparseable(&self, raw: &str, error: &moat_mcp::Error) {
        let id = serde_json::from_str::<serde_json::Value>(raw)
            .ok()
            .and_then(|value| value.get("id").cloned())
            .filter(|id| !id.is_null())
            .and_then(|id| serde_json::from_value::<RequestId>(id).ok());
        let waiter = match (&self.link, &id) {
            (Link::Stdio(s), Some(id)) => s.pending.lock().await.remove(id),
            _ => None,
        };
        let (Some(id), Some(tx)) = (id, waiter) else {
            tracing::warn!(upstream = %self.name, %error, "dropped unparseable line from upstream");
            return;
        };
        tracing::warn!(
            upstream = %self.name, %id, %error,
            "unparseable reply from upstream; its caller is told"
        );
        let message = Message::from(ErrorResponse::new(
            Some(id),
            ErrorObject::new(
                code::INTERNAL_ERROR,
                format!(
                    "upstream {:?} sent an unparseable reply: {error}",
                    self.name
                ),
                None,
            ),
        ));
        if let Ok(raw) = message.to_line() {
            let _ = tx.send(Frame { raw, message });
        }
    }

    /// Whether the upstream can still be talked to. HTTP upstreams are
    /// assumed alive; a failed POST surfaces per request.
    pub fn is_alive(&self) -> bool {
        match &self.link {
            Link::Stdio(s) => s.alive.load(Ordering::SeqCst),
            Link::Http(_) => true,
        }
    }

    /// A fresh id for a gateway-originated request, prefixed so it can never
    /// collide with a client id.
    pub fn own_id(&self) -> RequestId {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        RequestId::String(format!("moat:{}:{n}", self.name))
    }

    /// Send a request built by the gateway and wait for its reply.
    pub async fn request(&self, req: Request) -> Result<Frame> {
        let line = Message::Request(req.clone()).to_line()?;
        self.request_raw(req.id, &line).await
    }

    /// Forward a raw request line as-is (client id preserved) and wait for
    /// the reply frame, whose raw bytes the caller can relay untouched.
    pub async fn request_raw(&self, id: RequestId, line: &str) -> Result<Frame> {
        match &self.link {
            Link::Stdio(s) => {
                if !self.is_alive() {
                    anyhow::bail!("upstream {:?} is not running", self.name);
                }
                let (tx, rx) = oneshot::channel();
                s.pending.lock().await.insert(id.clone(), tx);
                if let Err(e) = self.write_line(line).await {
                    s.pending.lock().await.remove(&id);
                    return Err(e);
                }
                rx.await
                    .map_err(|_| anyhow!("upstream {:?} closed before answering {id}", self.name))
            }
            Link::Http(client) => client
                .post_raw(line)
                .await
                .with_context(|| format!("http upstream {:?}", self.name))?
                .ok_or_else(|| anyhow!("http upstream {:?} sent no reply to {id}", self.name)),
        }
    }

    /// Send a line that expects no reply (a notification or a response to an
    /// upstream-originated request).
    pub async fn send_raw(&self, line: &str) -> Result<()> {
        match &self.link {
            Link::Stdio(_) => self.write_line(line).await,
            Link::Http(client) => {
                if let Some(frame) = client
                    .post_raw(line)
                    .await
                    .with_context(|| format!("http upstream {:?}", self.name))?
                {
                    tracing::debug!(upstream = %self.name, id = ?frame.message.id(), "unexpected reply to a notification; dropped");
                }
                Ok(())
            }
        }
    }

    async fn write_line(&self, line: &str) -> Result<()> {
        match &self.link {
            Link::Stdio(s) => s
                .writer
                .lock()
                .await
                .write_raw(line)
                .await
                .with_context(|| format!("writing to upstream {:?}", self.name)),
            Link::Http(_) => Ok(()),
        }
    }

    /// Stdio: close stdin and wait for the process to exit. HTTP: end the
    /// session if the server gave us one.
    pub async fn shutdown(&self, grace: Duration) {
        match &self.link {
            Link::Stdio(s) => {
                // Closing our writer closes the child's stdin.
                if let Err(e) = s.writer.lock().await.shutdown().await {
                    tracing::debug!(upstream = %self.name, error = %e, "stdin already closed");
                }
                if let Some(p) = s.process.lock().await.take() {
                    match p.shutdown(grace).await {
                        Ok(status) => {
                            tracing::info!(upstream = %self.name, %status, "upstream exited")
                        }
                        Err(e) => {
                            tracing::warn!(upstream = %self.name, error = %e, "upstream shutdown failed")
                        }
                    }
                }
            }
            Link::Http(client) => client.close().await,
        }
    }
}
