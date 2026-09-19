//! What happens to a payment Moat cannot account for.
//!
//! A transfer is instructed, the provider answers with nothing usable, and
//! Moat does not know whether the money left. On a card that is safe to
//! treat as "it did not": the authorization either never took or can be
//! reversed, and the agent may try again. On a bank transfer it is not
//! safe, and the whole of this file is that difference, end to end through
//! a real gateway process.
//!
//!   1. A transfer is allowed and forwarded. The provider errors.
//!   2. Moat holds it: counted, and quarantined because it is unaccounted for.
//!   3. The retry is refused, naming the hold.
//!   4. Somebody checks with the bank and reconciles the outcome.
//!   5. The mandate works again, and what it allows depends on what they found.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::Duration;

use common::{fake_server_path, gateway_path, http, write_config, yaml_path, Peer};
use moat_core::verdict::code as moat_code;
use moat_mcp::types::{method, PROTOCOL_VERSION_2025_11_25};
use moat_mcp::{Message, Notification, Request};
use serde_json::{json, Value};

const IBAN: &str = "DE63 1133 5142 2523 8085 09";

/// A bank-shaped policy: the tool is `transfer`, the destination is a
/// declared field, and the cap is high enough that nothing here is refused
/// for its amount.
const BANK_POLICY: &str = r#"
version: 1
payment_tools:
  - server: "*"
    tool: "transfer"
fields:
  payee:       { args: ["beneficiary_name"] }
  amount:      { args: ["amount"] }
  currency:    { args: ["currency"] }
  destination: { kind: destination, args: ["beneficiary_iban"] }
allowlist:
  payees: ["Monitoring Pro Inc"]
  accounts: ["DE63 1133 5142 2523 8085 09"]
rules:
  - id: amount-cap
    when: field == amount
    max: 5000
    on_fail: deny
no_human_available: deny
"#;

/// A gateway under test: the peer to talk MCP to, and where its intent API
/// listens.
struct Harness {
    gw: Peer,
    api: String,
    session: String,
}

#[derive(Clone, Copy)]
enum Simulate {
    /// The provider answers with an error. Moat learns nothing about the money.
    Error,
    /// The provider answers with this status.
    Status(&'static str),
}

impl Harness {
    /// Start a gateway whose one upstream is on `rail`, with an
    /// authorization good for two payments, so a refused retry is refused
    /// by the hold rather than by the usage limit.
    async fn start(session: &str, rail: &str) -> Harness {
        let fake = fake_server_path();
        let port = free_port();
        let api = format!("127.0.0.1:{port}");
        let policy_path = std::env::temp_dir().join(format!("moat-hold-{session}.yaml"));
        std::fs::write(&policy_path, BANK_POLICY).unwrap();
        let cfg = write_config(
            &format!("hold-{session}"),
            &format!(
                r#"
session_id: "{session}"
upstreams:
  - name: bank
    rail: {rail}
    transport: stdio
    command: [{}]
policy: {}
evidence: ./evidence.jsonl
intent_api: {{ addr: "{api}" }}
"#,
                yaml_path(&fake),
                yaml_path(&policy_path)
            ),
        );
        let _ = std::fs::remove_file(cfg.parent().unwrap().join("evidence.jsonl"));

        let mut gw = Peer::spawn(&gateway_path(), &["--config", cfg.to_str().unwrap()], &[]);
        gw.call(Request::new(
            1,
            method::INITIALIZE,
            Some(json!({
                "protocolVersion": PROTOCOL_VERSION_2025_11_25,
                "capabilities": {},
                "clientInfo": {"name": "hold-test", "version": "0.1.0"}
            })),
        ))
        .await;
        gw.notify(Notification::new(method::INITIALIZED, None))
            .await;
        wait_for_api(&api).await;

        let harness = Harness {
            gw,
            api,
            session: session.to_owned(),
        };
        let (status, body) = harness
            .post(
                "intent",
                json!({"text": format!("Pay Monitoring Pro Inc 100 EUR to {IBAN}")}),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        let (status, body) = harness
            .post(
                "authorizations",
                json!({
                    "authorization_id": "auth-hold",
                    "invoice_id": "INV-1",
                    "payee": "Monitoring Pro Inc",
                    "recipient_account_id": IBAN,
                    "amount": 100,
                    "tolerance": 0,
                    "currency": "EUR",
                    "repeat_payments": true,
                    "max_payments": 2,
                    "aggregate_limit": 500,
                    "expires_at": "2099-01-01T00:00:00Z"
                }),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        harness
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        http::post(
            &self.api,
            &format!("/v1/session/{}/{path}", self.session),
            &body,
        )
        .await
    }

    async fn get(&self, path: &str) -> Value {
        let (status, body) =
            http::get(&self.api, &format!("/v1/session/{}/{path}", self.session)).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    /// Instruct one transfer through the gateway.
    async fn transfer(&mut self, id: i64, invoice: &str, simulate: Simulate) -> Message {
        let mut args = json!({
            "authorization_id": "auth-hold",
            "invoice_id": invoice,
            "beneficiary_name": "Monitoring Pro Inc",
            "beneficiary_iban": IBAN,
            "amount": 100,
            "currency": "EUR"
        });
        match simulate {
            Simulate::Error => args["simulate_error"] = json!(true),
            Simulate::Status(status) => args["simulate_status"] = json!(status),
        }
        self.gw
            .call(Request::new(
                id,
                method::TOOLS_CALL,
                Some(json!({"name": "bank__transfer", "arguments": args})),
            ))
            .await
            .1
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

/// The rule ids a denial gave, read off the error the client received.
fn denial_reasons(message: &Message) -> Vec<String> {
    let Message::Error(error) = message else {
        panic!("expected a denial, got {message:?}");
    };
    assert_eq!(error.error.code, moat_code::DENY, "{error:?}");
    error
        .error
        .data
        .as_ref()
        .and_then(|data| data.pointer("/moat/reasons").cloned())
        .and_then(|reasons| reasons.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|reason| reason.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// Whether the client was told the call failed, by any route.
fn is_error_reply(message: &Message) -> bool {
    matches!(message, Message::Error(_))
}

#[tokio::test]
async fn an_unaccounted_transfer_is_held_and_reconciliation_releases_it() {
    let mut h = Harness::start("hold-bank", "bank").await;

    // 1. Allowed, forwarded, and the provider answers with nothing usable.
    let first = h.transfer(10, "INV-1", Simulate::Error).await;
    assert!(is_error_reply(&first), "the client is told: {first:?}");

    // 2. Moat is holding it, and says so.
    let open = h.get("outcomes").await;
    assert_eq!(open["open_count"], json!(1), "{open}");
    let held = &open["open"][0];
    assert_eq!(held["status_kind"], json!("unknown"), "{held}");
    assert_eq!(
        held["committed"],
        json!(true),
        "a transfer may already be gone"
    );
    assert_eq!(
        held["quarantined"],
        json!(true),
        "and nobody knows whether it is"
    );
    let evidence_id = held["evidence_id"].as_str().unwrap().to_owned();

    // 3. The retry is refused, for the reason that is true.
    let retry = h.transfer(11, "INV-2", Simulate::Status("settled")).await;
    let reasons = denial_reasons(&retry);
    assert!(
        reasons.contains(&"authorization-quarantine".to_owned()),
        "{reasons:?}"
    );

    // 4. Somebody rings the bank. The transfer never went out.
    let (status, body) = h
        .post(
            &format!("outcomes/{evidence_id}/reconcile"),
            json!({"status": "failed"}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["outcome"]["status_kind"], json!("failed"));
    assert_eq!(body["outcome"]["quarantined"], json!(false));
    assert_eq!(
        body["outcome"]["committed"],
        json!(false),
        "a transfer that never went out moved no money"
    );
    assert_eq!(h.get("outcomes").await["open_count"], json!(0));

    // 5. And the mandate works again.
    let allowed = h.transfer(12, "INV-2", Simulate::Status("settled")).await;
    assert!(
        !is_error_reply(&allowed),
        "the payment should go through once the hold is resolved: {allowed:?}"
    );
}

/// Reconciled the other way: the money did leave. The mandate is spent, and
/// the refusal changes from "unaccounted for" to "already paid".
#[tokio::test]
async fn a_transfer_reconciled_as_settled_spends_the_mandate() {
    let mut h = Harness::start("hold-settled", "bank").await;

    h.transfer(10, "INV-1", Simulate::Error).await;
    let evidence_id = h.get("outcomes").await["open"][0]["evidence_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, body) = h
        .post(
            &format!("outcomes/{evidence_id}/reconcile"),
            json!({"status": "settled", "receipt": "bank_real_0001"}),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let retry = h.transfer(11, "INV-1", Simulate::Status("settled")).await;
    let reasons = denial_reasons(&retry);
    assert!(
        !reasons.contains(&"authorization-quarantine".to_owned()),
        "nothing is unaccounted for any more: {reasons:?}"
    );
    assert!(
        reasons.contains(&"authorization-duplicate".to_owned()),
        "the invoice has been paid: {reasons:?}"
    );
}

/// The constraint the whole phase works under. The identical failure on a
/// card leaves the mandate usable, because a card authorization that took
/// can be reversed and a lost response is safe to retry.
#[tokio::test]
async fn the_same_failure_on_a_card_stays_retryable() {
    let mut h = Harness::start("hold-card", "card").await;

    h.transfer(10, "INV-1", Simulate::Error).await;
    let open = h.get("outcomes").await;
    assert_eq!(
        open["open_count"],
        json!(0),
        "a card rail holds nothing: {open}"
    );

    let retry = h.transfer(11, "INV-1", Simulate::Status("succeeded")).await;
    assert!(
        !is_error_reply(&retry),
        "the card retry must still work: {retry:?}"
    );
}

/// Reconciliation reports what a provider says. It is not a way to rewrite
/// a final answer into a more convenient one.
#[tokio::test]
async fn reconciliation_will_not_contradict_a_final_answer() {
    let mut h = Harness::start("hold-conflict", "bank").await;

    h.transfer(10, "INV-1", Simulate::Status("settled")).await;
    let evidence_id = h.get("workflow").await["payment_outcomes"][0]["evidence_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (status, body) = h
        .post(
            &format!("outcomes/{evidence_id}/reconcile"),
            json!({"status": "pending"}),
        )
        .await;
    assert_eq!(
        status, 409,
        "a settled payment cannot become pending again: {body}"
    );

    // A reversal is the one thing that can still happen to settled money.
    let (status, body) = h
        .post(
            &format!("outcomes/{evidence_id}/reconcile"),
            json!({"status": "returned"}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["outcome"]["status_kind"], json!("reversed"), "{body}");
    assert_eq!(body["outcome"]["committed"], json!(false));

    let (status, body) = h
        .post(
            &format!("outcomes/{evidence_id}/reconcile"),
            json!({"status": "no idea"}),
        )
        .await;
    assert_eq!(
        status, 400,
        "reconciling to a state nobody recognises reports nothing: {body}"
    );

    let (status, body) = h
        .post(
            "outcomes/ev_nothing_here/reconcile",
            json!({"status": "failed"}),
        )
        .await;
    assert_eq!(status, 404, "{body}");
}
