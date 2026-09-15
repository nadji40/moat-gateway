//! A connected upstream MCP server: request/response correlation over one
//! stdio child, plus a channel for the messages it sends on its own.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use moat_mcp::process::ChildTransport;
use moat_mcp::stdio::{Frame, FrameWriter};
use moat_mcp::{Message, Request, RequestId};
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

/// Handle to one running upstream.
pub struct Upstream {
    /// The configured name; also the tool namespace.
    pub name: String,
    writer: Mutex<FrameWriter<ChildStdin>>,
    pending: Mutex<HashMap<RequestId, oneshot::Sender<Frame>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    process: Mutex<Option<ChildTransport>>,
}

impl Upstream {
    /// Spawn the upstream and start its reader task. Unsolicited messages go
    /// to `events` tagged with the upstream name.
    pub async fn spawn(
        cfg: &UpstreamConfig,
        events: mpsc::Sender<(String, UpstreamEvent)>,
    ) -> Result<Arc<Upstream>> {
        let mut transport = match &cfg.transport {
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
                ChildTransport::spawn(&cmd, &cfg.name)
                    .with_context(|| format!("starting upstream {:?}", cfg.name))?
            }
            UpstreamTransport::Http { url } => {
                anyhow::bail!(
                    "upstream {:?}: http transport ({url}) is not implemented yet (work order step 9)",
                    cfg.name
                )
            }
        };
        let (mut reader, writer) = transport
            .split()
            .ok_or_else(|| anyhow!("upstream {:?}: transport already split", cfg.name))?;

        let up = Arc::new(Upstream {
            name: cfg.name.clone(),
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            process: Mutex::new(Some(transport)),
        });

        let reader_up = Arc::clone(&up);
        tokio::spawn(async move {
            loop {
                match reader.next_frame().await {
                    Ok(Some(frame)) => reader_up.dispatch(frame, &events).await,
                    Ok(None) => break,
                    Err(moat_mcp::Error::Json { .. }) | Err(moat_mcp::Error::Malformed(_)) => {
                        // A bad line from an upstream is dropped, not fatal:
                        // the spec forbids it, but a proxy has no one to
                        // report it to except the log.
                        tracing::warn!(upstream = %reader_up.name, "dropped unparseable line from upstream");
                    }
                    Err(e) => {
                        tracing::error!(upstream = %reader_up.name, error = %e, "upstream read failed");
                        break;
                    }
                }
            }
            reader_up.alive.store(false, Ordering::SeqCst);
            reader_up.pending.lock().await.clear();
            let _ = events
                .send((reader_up.name.clone(), UpstreamEvent::Closed))
                .await;
            tracing::warn!(upstream = %reader_up.name, "upstream closed its stdout");
        });

        tracing::info!(upstream = %cfg.name, pid = ?up.pid().await, "upstream started");
        Ok(up)
    }

    async fn dispatch(&self, frame: Frame, events: &mpsc::Sender<(String, UpstreamEvent)>) {
        match &frame.message {
            Message::Response(_) | Message::Error(_) => {
                let waiter = match frame.message.id() {
                    Some(id) => self.pending.lock().await.remove(id),
                    None => None,
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

    /// Whether the reader task still sees an open stdout.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// OS pid, if running.
    pub async fn pid(&self) -> Option<u32> {
        self.process.lock().await.as_ref().and_then(|p| p.id())
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
        if !self.is_alive() {
            anyhow::bail!("upstream {:?} is not running", self.name);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        if let Err(e) = self.write_line(line).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        rx.await
            .map_err(|_| anyhow!("upstream {:?} closed before answering {id}", self.name))
    }

    /// Send a line that expects no reply (a notification or a response to an
    /// upstream-originated request).
    pub async fn send_raw(&self, line: &str) -> Result<()> {
        self.write_line(line).await
    }

    async fn write_line(&self, line: &str) -> Result<()> {
        self.writer
            .lock()
            .await
            .write_raw(line)
            .await
            .with_context(|| format!("writing to upstream {:?}", self.name))
    }

    /// Close stdin and wait for the process to exit.
    pub async fn shutdown(&self, grace: Duration) {
        // Closing our writer closes the child's stdin.
        if let Err(e) = self.writer.lock().await.shutdown().await {
            tracing::debug!(upstream = %self.name, error = %e, "stdin already closed");
        }
        if let Some(p) = self.process.lock().await.take() {
            match p.shutdown(grace).await {
                Ok(status) => tracing::info!(upstream = %self.name, %status, "upstream exited"),
                Err(e) => {
                    tracing::warn!(upstream = %self.name, error = %e, "upstream shutdown failed")
                }
            }
        }
    }
}
