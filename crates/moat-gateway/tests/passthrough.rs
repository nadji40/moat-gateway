//! The gateway as a passthrough: one upstream, a policy that declares its
//! read-only tool, and a tools/call reply that reaches the client byte for
//! byte. A tool the policy does not classify is hidden and refused.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use common::{fake_server_path, gateway_path, policy_for_fake, write_config, yaml_path, Peer};
use moat_mcp::types::{method, InitializeResult, ListToolsResult, PROTOCOL_VERSION_2025_11_25};
use moat_mcp::{Message, Notification, Request};
use serde_json::json;

fn init_params() -> serde_json::Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION_2025_11_25,
        "capabilities": {},
        "clientInfo": {"name": "passthrough-test", "version": "0"}
    })
}

#[tokio::test]
async fn tools_call_reply_is_byte_identical() {
    let fake = fake_server_path();
    let policy = policy_for_fake("passthrough-policy", "default.yaml");
    let cfg = write_config(
        "passthrough",
        &format!(
            r#"
upstreams:
  - name: fake
    transport: stdio
    command: [{}]
    env: {{ FAKE_MCP_PRETTY: "1" }}
policy: {}
evidence: ./evidence.jsonl
"#,
            yaml_path(&fake),
            yaml_path(&policy)
        ),
    );

    // Direct: the same call straight to the fake server, for the expected bytes.
    let mut direct = Peer::spawn(&fake, &[], &[("FAKE_MCP_PRETTY", "1")]);
    let (expected_raw, _) = direct
        .call(Request::new(
            "call-42",
            method::TOOLS_CALL,
            Some(json!({"name": "echo", "arguments": {"payee": "ProMon Billing Ltd", "amount": 480}})),
        ))
        .await;
    direct.close_and_wait().await;
    assert!(
        expected_raw.contains("\": "),
        "pretty mode should make the bytes distinctive"
    );

    // Through the gateway.
    let mut gw = Peer::spawn(
        &gateway_path(),
        &["--config", cfg.to_str().unwrap()],
        &[("RUST_LOG", "moat_gateway=debug,moat_mcp=debug")],
    );

    let (_, reply) = gw
        .call(Request::new(1, method::INITIALIZE, Some(init_params())))
        .await;
    let Message::Response(r) = reply else {
        panic!("initialize failed: {reply:?}");
    };
    let init: InitializeResult = serde_json::from_value(r.result).unwrap();
    assert_eq!(init.protocol_version, PROTOCOL_VERSION_2025_11_25);
    assert_eq!(init.server_info.name, "moat-gateway");
    assert!(init.instructions.unwrap().starts_with("[fake] "));

    gw.notify(Notification::new(method::INITIALIZED, None))
        .await;

    let (_, reply) = gw.call(Request::new(2, method::TOOLS_LIST, None)).await;
    let Message::Response(r) = reply else {
        panic!("tools/list failed: {reply:?}");
    };
    let list: ListToolsResult = serde_json::from_value(r.result).unwrap();
    let names: Vec<&str> = list.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        ["fake__echo", "fake__pay"],
        "the unclassified transfer is hidden"
    );
    // By name rather than by position: the fixture gains tools over time
    // and what is being asserted is that this one's schema is untouched.
    let pay = list
        .tools
        .iter()
        .find(|tool| tool.name == "fake__pay")
        .expect("the pay tool is advertised");
    assert_eq!(
        pay.input_schema["required"],
        json!(["payee", "amount"]),
        "tool schemas must pass through untouched"
    );

    let (raw, reply) = gw
        .call(Request::new(
            "call-42",
            method::TOOLS_CALL,
            Some(json!({"name": "fake__echo", "arguments": {"payee": "ProMon Billing Ltd", "amount": 480}})),
        ))
        .await;
    assert!(matches!(reply, Message::Response(_)), "{reply:?}");
    assert_eq!(
        raw, expected_raw,
        "gateway must relay the upstream reply byte for byte"
    );

    // A tool the policy does not classify is refused, not forwarded: a
    // server that gains a way to move money cannot use it around Moat.
    let (_, reply) = gw
        .call(Request::new(
            5,
            method::TOOLS_CALL,
            Some(json!({"name": "fake__transfer", "arguments": {"payee": "ProMon Billing Ltd", "amount": 480}})),
        ))
        .await;
    let Message::Error(e) = reply else {
        panic!("an unclassified tool must be refused: {reply:?}");
    };
    assert_eq!(e.error.code, moat_core::verdict::code::DENY);
    assert_eq!(
        e.error.data.unwrap()["moat"]["reasons"][0],
        "unclassified-tool"
    );

    // Unknown namespace is a protocol error, not a crash.
    let (_, reply) = gw
        .call(Request::new(
            3,
            method::TOOLS_CALL,
            Some(json!({"name": "nope__echo", "arguments": {}})),
        ))
        .await;
    let Message::Error(e) = reply else {
        panic!("expected error: {reply:?}");
    };
    assert_eq!(e.error.code, moat_mcp::jsonrpc::code::INVALID_PARAMS);

    // Unaggregated methods are forwarded raw and the upstream's error comes back raw.
    let (_, reply) = gw.call(Request::new(4, "resources/list", None)).await;
    let Message::Error(e) = reply else {
        panic!("expected error: {reply:?}");
    };
    assert_eq!(e.error.code, moat_mcp::jsonrpc::code::METHOD_NOT_FOUND);

    let status = gw.close_and_wait().await;
    assert!(status.success(), "gateway exit: {status:?}");
}

/// A reply the upstream mangles is answered with an error at once. Before,
/// the line was dropped and the caller waited the whole reply timeout for
/// an answer that had already arrived.
#[tokio::test]
async fn an_unparseable_reply_from_the_upstream_is_an_error_not_a_wait() {
    let fake = fake_server_path();
    let policy = policy_for_fake("unparseable-policy", "default.yaml");
    let cfg = write_config(
        "unparseable",
        &format!(
            "upstreams:\n  - {{ name: fake, transport: stdio, command: [{}] }}\npolicy: {}\n",
            yaml_path(&fake),
            yaml_path(&policy)
        ),
    );
    let mut gw = Peer::spawn(&gateway_path(), &["--config", cfg.to_str().unwrap()], &[]);
    let (_, reply) = gw
        .call(Request::new(
            1,
            method::TOOLS_CALL,
            Some(json!({"name": "fake__echo", "arguments": {"simulate_malformed": true}})),
        ))
        .await;
    let Message::Error(e) = reply else {
        panic!("expected an error: {reply:?}");
    };
    assert_eq!(e.error.code, moat_mcp::jsonrpc::code::INTERNAL_ERROR);
    assert!(
        e.error.message.contains("unparseable reply"),
        "{}",
        e.error.message
    );

    // The upstream is still there, and the next call is unaffected.
    let (_, reply) = gw
        .call(Request::new(
            2,
            method::TOOLS_CALL,
            Some(json!({"name": "fake__echo", "arguments": {"hello": "again"}})),
        ))
        .await;
    assert!(matches!(reply, Message::Response(_)), "{reply:?}");
    gw.close_and_wait().await;
}

/// An upstream that pages its tool list is walked to the end, so a tool on
/// the second page is as reachable as one on the first.
#[tokio::test]
async fn every_page_of_an_upstreams_tools_is_listed() {
    let fake = fake_server_path();
    let policy = policy_for_fake("pages-policy", "default.yaml");
    let cfg = write_config(
        "pages",
        &format!(
            r#"
upstreams:
  - name: fake
    transport: stdio
    command: [{}]
    env: {{ FAKE_MCP_TOOL_PAGES: "1" }}
policy: {}
"#,
            yaml_path(&fake),
            yaml_path(&policy)
        ),
    );
    let mut gw = Peer::spawn(&gateway_path(), &["--config", cfg.to_str().unwrap()], &[]);
    let (_, reply) = gw.call(Request::new(1, method::TOOLS_LIST, None)).await;
    let Message::Response(r) = reply else {
        panic!("expected a response: {reply:?}");
    };
    let list: ListToolsResult = serde_json::from_value(r.result).unwrap();
    let names: Vec<&str> = list.tools.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"fake__echo"), "first page: {names:?}");
    assert!(names.contains(&"fake__pay"), "second page: {names:?}");
    assert!(list.next_cursor.is_none(), "the merged list is whole");
    gw.close_and_wait().await;
}

/// An HTTP upstream nobody is listening for stops the gateway at start,
/// the way a stdio upstream that cannot be spawned does.
#[tokio::test]
async fn an_http_upstream_nobody_listens_for_stops_the_gateway() {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let cfg = write_config(
        "unreachable",
        &format!(
            "upstreams:\n  - {{ name: web, transport: http, url: \"http://127.0.0.1:{port}/mcp\" }}\n"
        ),
    );
    let gw = Peer::spawn(&gateway_path(), &["--config", cfg.to_str().unwrap()], &[]);
    let status = gw.close_and_wait().await;
    assert!(!status.success(), "the gateway ran without its upstream");
}

#[tokio::test]
async fn garbage_from_client_gets_parse_error() {
    let fake = fake_server_path();
    let cfg = write_config(
        "garbage",
        &format!(
            "upstreams:\n  - {{ name: fake, transport: stdio, command: [{}] }}\n",
            yaml_path(&fake)
        ),
    );
    let mut gw = Peer::spawn(&gateway_path(), &["--config", cfg.to_str().unwrap()], &[]);
    gw.writer.write_raw("{not json").await.unwrap();
    let frame = gw.reader.next_frame().await.unwrap().unwrap();
    let Message::Error(e) = frame.message else {
        panic!("expected parse error");
    };
    assert_eq!(e.error.code, moat_mcp::jsonrpc::code::PARSE_ERROR);
    gw.close_and_wait().await;
}
