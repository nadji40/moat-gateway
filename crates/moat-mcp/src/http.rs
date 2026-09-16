//! Streamable HTTP client for upstreams.
//!
//! Speaks the transport as the `2025-11-25` revision (and the TypeScript SDK
//! that today's servers use) defines it: every message is a POST to the MCP
//! endpoint, the reply is either a JSON body or an SSE stream ending with the
//! response, `Mcp-Session-Id` is captured from `initialize` and echoed, and
//! `MCP-Protocol-Version` is sent once a version has been negotiated. The
//! standalone GET stream for server-initiated messages is not opened: a proxy
//! only needs replies to what it sent.
//!
//! The `2026-07-28` shape (no sessions, mirrored `Mcp-Method`/`Mcp-Name`
//! headers) is not implemented here; see ADR 0002.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::jsonrpc::Message;
use crate::stdio::Frame;
use crate::types::{method, InitializeResult};

/// Header carrying the legacy session id.
pub const SESSION_HEADER: &str = "mcp-session-id";
/// Header carrying the negotiated protocol version.
pub const PROTOCOL_VERSION_HEADER: &str = "mcp-protocol-version";

/// How long to wait for one reply.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// A client for one MCP endpoint.
pub struct HttpClient {
    url: String,
    client: reqwest::Client,
    session_id: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
}

impl HttpClient {
    /// Build a client for `url`.
    pub fn new(url: &str) -> Result<HttpClient> {
        let client = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|e| Error::Process(format!("building http client: {e}")))?;
        Ok(HttpClient {
            url: url.to_owned(),
            client,
            session_id: Mutex::new(None),
            protocol_version: Mutex::new(None),
        })
    }

    /// The endpoint.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The session id the server assigned, if any.
    pub async fn session_id(&self) -> Option<String> {
        self.session_id.lock().await.clone()
    }

    /// POST one raw JSON-RPC line. Returns the reply frame for a request, or
    /// `None` for a notification the server accepted.
    pub async fn post_raw(&self, line: &str) -> Result<Option<Frame>> {
        let sent = Message::parse(line)?;
        let is_initialize = sent.method() == Some(method::INITIALIZE);

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        if let Some(sid) = self.session_id.lock().await.as_deref() {
            if let Ok(v) = HeaderValue::from_str(sid) {
                headers.insert(SESSION_HEADER, v);
            }
        }
        if let Some(pv) = self.protocol_version.lock().await.as_deref() {
            if let Ok(v) = HeaderValue::from_str(pv) {
                headers.insert(PROTOCOL_VERSION_HEADER, v);
            }
        }

        let resp = self
            .client
            .post(&self.url)
            .headers(headers)
            .body(line.to_owned())
            .send()
            .await
            .map_err(|e| Error::Process(format!("POST {}: {e}", self.url)))?;

        if let Some(sid) = resp
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().await = Some(sid.to_owned());
        }

        let status = resp.status();
        let content_type = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = resp
            .text()
            .await
            .map_err(|e| Error::Process(format!("reading reply from {}: {e}", self.url)))?;

        if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !status.is_success() {
            // Servers put a JSON-RPC error in the body of a 4xx; relay it if
            // it parses, otherwise surface the status.
            if let Ok(msg) = Message::parse(body.trim()) {
                return Ok(Some(Frame {
                    raw: compact(body.trim(), &msg)?,
                    message: msg,
                }));
            }
            return Err(Error::Process(format!(
                "POST {} returned {status}: {}",
                self.url,
                body.chars().take(200).collect::<String>()
            )));
        }

        let frame = if content_type.starts_with("text/event-stream") {
            match reply_from_sse(&body, &sent)? {
                Some(f) => f,
                None => return Ok(None),
            }
        } else {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            let msg = Message::parse(trimmed)?;
            Frame {
                raw: compact(trimmed, &msg)?,
                message: msg,
            }
        };

        if is_initialize {
            if let Message::Response(r) = &frame.message {
                if let Ok(init) = serde_json::from_value::<InitializeResult>(r.result.clone()) {
                    *self.protocol_version.lock().await = Some(init.protocol_version);
                }
            }
        }
        Ok(Some(frame))
    }

    /// Best-effort session teardown: DELETE with the session id, if we have
    /// one. Errors are ignored; the server may not support it.
    pub async fn close(&self) {
        let Some(sid) = self.session_id.lock().await.take() else {
            return;
        };
        let _ = self
            .client
            .delete(&self.url)
            .header(SESSION_HEADER, sid)
            .send()
            .await;
    }
}

/// A raw line for relaying: the body as-is when it is already one line,
/// otherwise the compact re-serialization.
fn compact(body: &str, msg: &Message) -> Result<String> {
    if body.contains('\n') {
        msg.to_line()
    } else {
        Ok(body.to_owned())
    }
}

/// Find the response to `sent` in an SSE body. Other messages on the stream
/// (progress notifications, server requests) are logged and dropped.
fn reply_from_sse(body: &str, sent: &Message) -> Result<Option<Frame>> {
    let want = sent.id();
    let mut data: Vec<String> = Vec::new();
    let mut found: Option<Frame> = None;

    let flush = |data: &mut Vec<String>, found: &mut Option<Frame>| -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let payload = data.join("\n");
        data.clear();
        let msg = match Message::parse(payload.trim()) {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!(error = %e, "ignoring non-message SSE event");
                return Ok(());
            }
        };
        match &msg {
            Message::Response(_) | Message::Error(_) if msg.id() == want && found.is_none() => {
                *found = Some(Frame {
                    raw: compact(payload.trim(), &msg)?,
                    message: msg,
                });
            }
            other => {
                tracing::debug!(method = ?other.method(), id = ?other.id(), "dropped in-stream message from http upstream");
            }
        }
        Ok(())
    };

    for line in body.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            flush(&mut data, &mut found)?;
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
        }
        // `event:`, `id:`, `retry:` and comments carry nothing we need.
    }
    flush(&mut data, &mut found)?;
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::Request;

    #[test]
    fn sse_picks_the_matching_response_and_skips_the_rest() {
        let sent = Message::Request(Request::new(7, "tools/call", None));
        let body = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\r\n\r\n\
                    data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"content\":[]}}\r\n\r\n";
        let f = reply_from_sse(body, &sent).unwrap().unwrap();
        assert_eq!(f.raw, r#"{"jsonrpc":"2.0","id":7,"result":{"content":[]}}"#);
        assert!(reply_from_sse(
            "data: {\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{}}\n\n",
            &sent
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn multiline_data_is_joined() {
        let sent = Message::Request(Request::new("a", "ping", None));
        let body = "data: {\"jsonrpc\":\"2.0\",\ndata: \"id\":\"a\",\"result\":{}}\n\n";
        let f = reply_from_sse(body, &sent).unwrap().unwrap();
        assert!(matches!(f.message, Message::Response(_)));
        assert!(!f.raw.contains('\n'));
    }
}
