//! Who reads what the user typed.
//!
//! An intent arrives as fields, as text, or as both. Fields from the caller
//! are taken as given. Text alone goes to the `moat-intent` reader when the
//! gateway is configured with one, and what the model read is registered as
//! fields; when the reader is down, slow, or its model is, the text is
//! registered as text and the core's rules read it. Through a real gateway
//! process and a reader that is a few lines of axum.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use common::{fake_server_path, gateway_path, http, write_config, yaml_path, Peer};
use moat_mcp::types::{method, PROTOCOL_VERSION_2025_11_25};
use moat_mcp::{Notification, Request};
use serde_json::{json, Value};

const ITALIAN: &str = "Non pagare Orbit Labs Srl, paga Vega Cloud Srl 480 euro";

/// A reader that answers like `moat-intent`: a reading for most messages,
/// "unavailable" when the message says so, and late when it says "slow".
async fn read(State(calls): State<Arc<AtomicUsize>>, Json(body): Json<Value>) -> Json<Value> {
    calls.fetch_add(1, Ordering::SeqCst);
    let text = body["text"].as_str().unwrap_or_default().to_owned();
    if text.contains("slow") {
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    let empty = json!({"pay": [], "refused": [], "amounts": [], "currencies": [],
                       "destinations": [], "cancels_previous": false, "reader": "fake unavailable"});
    if text.contains("unavailable") {
        return Json(
            json!({"status": "unavailable", "fields": empty, "dropped": [],
                           "record": text, "cards_removed": 0, "error": "no model"}),
        );
    }
    Json(json!({
        "status": "read",
        "fields": {"pay": ["Vega Cloud Srl"], "refused": ["Orbit Labs Srl"], "amounts": ["480"],
                   "currencies": ["EUR"], "destinations": [], "cancels_previous": false,
                   "reader": "fake model"},
        "dropped": ["currency \"euro\": not a code the core knows"],
        "record": text,
        "cards_removed": 0
    }))
}

struct Harness {
    _gw: Peer,
    api: String,
    session: String,
    reader_calls: Arc<AtomicUsize>,
}

impl Harness {
    /// A gateway whose intent API points at a reader. `reader_up` false
    /// points it at a port nobody listens on.
    async fn start(session: &str, reader_up: bool) -> Harness {
        let reader_calls = Arc::new(AtomicUsize::new(0));
        let reader_port = free_port();
        if reader_up {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", reader_port))
                .await
                .unwrap();
            let app = Router::new()
                .route("/v1/read", post(read))
                .with_state(Arc::clone(&reader_calls));
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        }
        let api = format!("127.0.0.1:{}", free_port());
        let cfg = write_config(
            &format!("intent-reader-{session}"),
            &format!(
                r#"
session_id: "{session}"
upstreams:
  - name: bank
    transport: stdio
    command: [{}]
evidence: ./evidence.jsonl
intent_api:
  addr: "{api}"
  reader: "http://127.0.0.1:{reader_port}"
  reader_timeout_secs: 1
"#,
                yaml_path(&fake_server_path()),
            ),
        );
        let mut gw = Peer::spawn(&gateway_path(), &["--config", cfg.to_str().unwrap()], &[]);
        gw.call(Request::new(
            1,
            method::INITIALIZE,
            Some(json!({
                "protocolVersion": PROTOCOL_VERSION_2025_11_25,
                "capabilities": {},
                "clientInfo": {"name": "intent-reader-test", "version": "0.1.0"}
            })),
        ))
        .await;
        gw.notify(Notification::new(method::INITIALIZED, None))
            .await;
        wait_for_api(&api).await;
        Harness {
            _gw: gw,
            api,
            session: session.to_owned(),
            reader_calls,
        }
    }

    async fn intent(&self, body: Value) -> Value {
        let (status, reply) = http::post(
            &self.api,
            &format!("/v1/session/{}/intent", self.session),
            &body,
        )
        .await;
        assert_eq!(status, 200, "{reply}");
        reply
    }

    fn reads(&self) -> usize {
        self.reader_calls.load(Ordering::SeqCst)
    }
}

fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

async fn wait_for_api(addr: &str) {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("intent API never came up on {addr}");
}

#[tokio::test]
async fn text_alone_is_read_by_the_model_and_registered_as_fields() {
    let h = Harness::start("reader-model", true).await;
    let reply = h.intent(json!({ "text": ITALIAN })).await;
    assert_eq!(reply["read_by"], "model", "{reply}");
    assert_eq!(reply["structured"], true);
    assert_eq!(reply["fields"]["pay"], json!(["Vega Cloud Srl"]));
    assert_eq!(reply["fields"]["refused"], json!(["Orbit Labs Srl"]));
    assert_eq!(reply["dropped"].as_array().unwrap().len(), 1);
    assert_eq!(h.reads(), 1);
}

#[tokio::test]
async fn fields_from_the_caller_never_reach_the_model() {
    let h = Harness::start("reader-caller", true).await;
    let reply = h
        .intent(json!({
            "text": ITALIAN,
            "fields": {"pay": ["Vega Cloud Srl"], "amounts": ["480"], "currencies": ["EUR"]}
        }))
        .await;
    assert_eq!(reply["read_by"], "caller", "{reply}");
    assert_eq!(reply["structured"], true);
    assert!(
        reply.get("fields").is_none(),
        "the caller knows what it sent"
    );
    assert_eq!(h.reads(), 0);
}

#[tokio::test]
async fn a_model_that_is_unavailable_or_slow_leaves_the_text_to_the_rules() {
    let h = Harness::start("reader-degraded", true).await;
    for text in [
        "Pay Vega Cloud Srl 480 EUR, the model is unavailable",
        "Pay Vega Cloud Srl 480 EUR, the model is slow",
    ] {
        let reply = h.intent(json!({ "text": text })).await;
        assert_eq!(reply["read_by"], "rules", "{text}: {reply}");
        assert_eq!(reply["structured"], false, "{text}");
        assert!(reply.get("fields").is_none(), "{text}");
    }
    assert_eq!(h.reads(), 2);
}

#[tokio::test]
async fn a_reader_that_is_down_leaves_the_text_to_the_rules() {
    let h = Harness::start("reader-down", false).await;
    let reply = h.intent(json!({ "text": ITALIAN })).await;
    assert_eq!(reply["read_by"], "rules", "{reply}");
    assert_eq!(reply["structured"], false);
}
