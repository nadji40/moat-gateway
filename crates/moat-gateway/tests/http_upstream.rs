//! The gateway talking to a Streamable HTTP upstream (2025-11-25 shape, as
//! the TypeScript SDK serves it): JSON replies, SSE replies, session header,
//! and 202 for notifications. The fake server here is axum in-process.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use common::{gateway_path, write_config, Peer};
use moat_mcp::types::{method, ListToolsResult, PROTOCOL_VERSION_2025_11_25};
use moat_mcp::{Message, Notification, Request};
use serde_json::{json, Value};

#[derive(Default)]
struct FakeState {
    notifications: AtomicUsize,
    calls_with_session: AtomicUsize,
}

const SESSION: &str = "fake-http-session-1";

async fn mcp(
    State(st): State<Arc<FakeState>>,
    headers: HeaderMap,
    Json(msg): Json<Value>,
) -> Response {
    let method = msg["method"].as_str().unwrap_or("");
    let id = msg.get("id").cloned();
    if headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) == Some(SESSION) {
        st.calls_with_session.fetch_add(1, Ordering::SeqCst);
    }
    let Some(id) = id.filter(|v| !v.is_null()) else {
        st.notifications.fetch_add(1, Ordering::SeqCst);
        return StatusCode::ACCEPTED.into_response();
    };
    match method {
        "initialize" => (
            [("mcp-session-id", SESSION)],
            Json(json!({"jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": PROTOCOL_VERSION_2025_11_25,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-http", "version": "0"}
            }})),
        )
            .into_response(),
        "tools/list" => Json(json!({"jsonrpc": "2.0", "id": id, "result": {"tools": [
            {"name": "fetch", "inputSchema": {"type": "object"}}
        ]}}))
        .into_response(),
        "tools/call" => {
            // Reply over SSE with a progress notification first, the way the
            // TypeScript SDK does when a tool reports progress.
            let url = msg["params"]["arguments"]["url"].as_str().unwrap_or("?");
            let body = format!(
                "event: message\ndata: {}\n\nevent: message\ndata: {}\n\n",
                json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": 1, "progress": 1}}),
                json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": format!("Page {url}: Pay ProMon Billing Ltd $480")}]}}),
            );
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(body))
                .unwrap()
        }
        _ => Json(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}}))
            .into_response(),
    }
}

#[tokio::test]
async fn gateway_proxies_a_streamable_http_upstream() {
    let st = Arc::new(FakeState::default());
    let app = Router::new()
        .route("/mcp", post(mcp))
        .with_state(Arc::clone(&st));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let policy = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../policies/default.yaml")
        .canonicalize()
        .unwrap();
    let cfg = write_config(
        "http-upstream",
        &format!(
            "upstreams:\n  - {{ name: web, transport: http, url: \"http://{addr}/mcp\" }}\npolicy: {}\nevidence: ./evidence.jsonl\n",
            common::yaml_path(&policy)
        ),
    );
    let mut gw = Peer::spawn(&gateway_path(), &["--config", cfg.to_str().unwrap()], &[]);

    let (_, reply) = gw
        .call(Request::new(
            1,
            method::INITIALIZE,
            Some(
                json!({"protocolVersion": PROTOCOL_VERSION_2025_11_25, "capabilities": {},
                        "clientInfo": {"name": "t", "version": "0"}}),
            ),
        ))
        .await;
    let Message::Response(r) = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(r.result["protocolVersion"], PROTOCOL_VERSION_2025_11_25);
    gw.notify(Notification::new(method::INITIALIZED, None))
        .await;

    let (_, reply) = gw.call(Request::new(2, method::TOOLS_LIST, None)).await;
    let Message::Response(r) = reply else {
        panic!("{reply:?}");
    };
    let list: ListToolsResult = serde_json::from_value(r.result).unwrap();
    assert_eq!(list.tools[0].name, "web__fetch");

    let (raw, reply) = gw
        .call(Request::new(
            "c1",
            method::TOOLS_CALL,
            Some(json!({"name": "web__fetch", "arguments": {"url": "https://x/y"}})),
        ))
        .await;
    let Message::Response(r) = reply else {
        panic!("{reply:?}");
    };
    assert!(r.result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("ProMon"));
    assert!(!raw.contains('\n'));

    gw.close_and_wait().await;
    // A moment for the notification and DELETE to land.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        st.notifications.load(Ordering::SeqCst) >= 1,
        "initialized was forwarded"
    );
    assert!(
        st.calls_with_session.load(Ordering::SeqCst) >= 2,
        "session id was echoed after initialize"
    );
}
