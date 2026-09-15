//! Round-trips the legacy handshake and tool discovery against the
//! hand-written fake server, over a real subprocess.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use moat_mcp::jsonrpc::{Message, Request, RequestId};
use moat_mcp::process::ChildTransport;
use moat_mcp::types::{
    method, CallToolResult, InitializeResult, ListToolsResult, PROTOCOL_VERSION_2025_11_25,
};
use serde_json::json;

fn fake_server() -> Vec<String> {
    vec![env!("CARGO_BIN_EXE_moat-fake-mcp-server").to_owned()]
}

async fn call(t: &mut ChildTransport, req: Request) -> Message {
    let expected = req.id.clone();
    t.writer()
        .expect("writer")
        .write_message(&req.into())
        .await
        .expect("write");
    let frame = tokio::time::timeout(
        Duration::from_secs(5),
        t.reader().expect("reader").next_frame(),
    )
    .await
    .expect("timed out waiting for reply")
    .expect("read")
    .expect("stream ended");
    assert_eq!(frame.message.id(), Some(&expected), "reply id mismatch");
    frame.message
}

#[tokio::test]
async fn initialize_then_list_then_call() {
    let mut t = ChildTransport::spawn(&fake_server(), "fake").expect("spawn");

    // initialize
    let reply = call(
        &mut t,
        Request::new(
            1,
            method::INITIALIZE,
            Some(json!({
                "protocolVersion": PROTOCOL_VERSION_2025_11_25,
                "capabilities": {},
                "clientInfo": {"name": "moat-mcp-test", "version": "0"}
            })),
        ),
    )
    .await;
    let Message::Response(r) = reply else {
        panic!("initialize did not succeed: {reply:?}");
    };
    let init: InitializeResult = serde_json::from_value(r.result).expect("initialize shape");
    assert_eq!(init.protocol_version, PROTOCOL_VERSION_2025_11_25);
    assert_eq!(init.server_info.name, "moat-fake-mcp-server");
    assert!(init.capabilities.get("tools").is_some());

    // initialized (notification, no reply)
    t.writer()
        .expect("writer")
        .write_message(&moat_mcp::Notification::new(method::INITIALIZED, None).into())
        .await
        .expect("write");

    // tools/list
    let reply = call(&mut t, Request::new("list-1", method::TOOLS_LIST, None)).await;
    let Message::Response(r) = reply else {
        panic!("tools/list failed: {reply:?}");
    };
    assert_eq!(r.id, RequestId::from("list-1"));
    let list: ListToolsResult = serde_json::from_value(r.result).expect("list shape");
    let names: Vec<&str> = list.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["echo", "pay"]);

    // tools/call
    let reply = call(
        &mut t,
        Request::new(
            3,
            method::TOOLS_CALL,
            Some(json!({"name": "echo", "arguments": {"hello": "world"}})),
        ),
    )
    .await;
    let Message::Response(r) = reply else {
        panic!("tools/call failed: {reply:?}");
    };
    let result: CallToolResult = serde_json::from_value(r.result).expect("call shape");
    assert_eq!(result.is_error, Some(false));
    assert_eq!(
        result.content[0]["text"].as_str(),
        Some(r#"{"hello":"world"}"#)
    );

    // unknown method -> JSON-RPC error, not a crash
    let reply = call(&mut t, Request::new(4, "resources/list", None)).await;
    let Message::Error(e) = reply else {
        panic!("expected an error: {reply:?}");
    };
    assert_eq!(e.error.code, moat_mcp::jsonrpc::code::METHOD_NOT_FOUND);

    // shutdown: close stdin, server should exit on its own
    let status = t.shutdown(Duration::from_secs(5)).await.expect("shutdown");
    assert!(status.success(), "fake server exit: {status:?}");
}

#[tokio::test]
async fn garbage_line_gets_a_parse_error_reply() {
    let mut t = ChildTransport::spawn(&fake_server(), "fake").expect("spawn");
    t.writer()
        .expect("writer")
        .write_raw("this is not json")
        .await
        .expect("write");
    let frame = t
        .reader()
        .expect("reader")
        .next_frame()
        .await
        .expect("read")
        .expect("reply");
    let Message::Error(e) = frame.message else {
        panic!("expected parse error, got {:?}", frame.message);
    };
    assert_eq!(e.error.code, moat_mcp::jsonrpc::code::PARSE_ERROR);
    assert!(e.id.is_none());
    let _ = t.shutdown(Duration::from_secs(5)).await;
}
