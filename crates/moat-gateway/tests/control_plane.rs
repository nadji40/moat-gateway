//! The control plane: issuing and withdrawing credentials over HTTP.
//!
//! Runs against a real gateway process with no database behind it, which is
//! the configuration these tests exist for. `auth.required` is off by default
//! and `authenticate_bearer` hands back the `local` tenant when it is off, so
//! without an explicit guard the key endpoints would be reachable by anyone
//! who could open a socket to a developer gateway. Every call must refuse,
//! and say why.
//!
//! The queries themselves need PostgreSQL and belong with the storage tests.
//! What is checked here is the order of the gates: a malformed body or a role
//! that does not exist is rejected before storage is consulted, so a gateway
//! that does have a database never opens a connection for a request that was
//! never going to succeed.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::process::Stdio;
use std::time::Duration;

use common::{fake_server_path, gateway_path, write_config, yaml_path};

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// A gateway listening on HTTP with no durable storage configured.
struct Gateway {
    _child: tokio::process::Child,
    base: String,
    http: reqwest::Client,
}

impl Gateway {
    /// `name` must differ per test. `write_config` keys its directory on the
    /// name and the process id, and every test in this file shares one
    /// process, so two tests with the same name write the same `moat.yaml`
    /// and each gateway binds whichever port won the race.
    async fn start(name: &str) -> Self {
        let fake = fake_server_path();
        let port = free_port();
        let api_port = free_port();
        let policy = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../policies/default.yaml")
            .canonicalize()
            .unwrap();
        let cfg = write_config(
            name,
            &format!(
                r#"
listen: {{ transport: http, addr: "127.0.0.1:{port}" }}
upstreams:
  - name: stripe
    transport: stdio
    command: [{}]
policy: {}
evidence: ./evidence.jsonl
intent_api: {{ addr: "127.0.0.1:{api_port}" }}
"#,
                yaml_path(&fake),
                yaml_path(&policy)
            ),
        );

        let child = tokio::process::Command::new(gateway_path())
            .args(["--config", cfg.to_str().unwrap()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();

        for _ in 0..100 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        Self {
            _child: child,
            base: format!("http://127.0.0.1:{port}"),
            http: reqwest::Client::new(),
        }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<&str>) -> (u16, String) {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header("authorization", "Bearer whatever");
        if let Some(body) = body {
            req = req
                .header("content-type", "application/json")
                .body(body.to_owned());
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.text().await.unwrap())
    }

    async fn post_key(&self, body: &str) -> (u16, String) {
        self.send(reqwest::Method::POST, "/v1/keys", Some(body))
            .await
    }
}

#[tokio::test]
async fn every_key_call_refuses_without_durable_storage() {
    let gw = Gateway::start("cp-no-storage").await;

    let cases: [(reqwest::Method, &str, Option<&str>); 3] = [
        (
            reqwest::Method::POST,
            "/v1/keys",
            Some(r#"{"label":"ci","access_role":"agent"}"#),
        ),
        (reqwest::Method::GET, "/v1/keys", None),
        (reqwest::Method::DELETE, "/v1/keys/key_abc", None),
    ];

    for (method, path, body) in cases {
        let (status, text) = gw.send(method.clone(), path, body).await;
        assert_eq!(
            status, 400,
            "{method} {path} must refuse without storage, got {status}: {text}"
        );
        assert!(
            text.contains("durable storage"),
            "{method} {path} must say why: {text}"
        );
    }
}

#[tokio::test]
async fn rejects_a_role_that_is_not_one_of_the_three() {
    let gw = Gateway::start("cp-role").await;
    let (status, text) = gw.post_key(r#"{"label":"ci","access_role":"root"}"#).await;
    assert_eq!(status, 400, "{text}");
    assert!(text.contains("agent, approver or admin"), "{text}");
}

#[tokio::test]
async fn rejects_an_empty_or_oversized_label() {
    let gw = Gateway::start("cp-label").await;
    let long = "x".repeat(121);
    for label in ["", "   ", long.as_str()] {
        let body = format!(
            r#"{{"label":{},"access_role":"agent"}}"#,
            serde_json::to_string(label).unwrap()
        );
        let (status, text) = gw.post_key(&body).await;
        assert_eq!(status, 400, "label {label:?}: {text}");
        assert!(text.contains("120 characters"), "label {label:?}: {text}");
    }
}

#[tokio::test]
async fn rejects_a_body_that_is_not_the_expected_shape() {
    let gw = Gateway::start("cp-body").await;
    for body in ["", "{}", "[]", r#"{"label":"ci"}"#, "not json at all"] {
        let (status, text) = gw.post_key(body).await;
        assert_eq!(status, 400, "body {body:?}: {text}");
    }
}

/// The gates run in a deliberate order, and this is the test that pins it:
/// the body is checked, then the label, then the role, and storage last. A
/// request that fails validation must never reach the database.
#[tokio::test]
async fn validates_the_request_before_consulting_storage() {
    let gw = Gateway::start("cp-order").await;
    let (_, text) = gw.post_key(r#"{"label":"","access_role":"nope"}"#).await;
    assert!(
        text.contains("120 characters"),
        "label is checked before the role, and both before storage: {text}"
    );
}

/// Signup writes a row for a caller holding no credential, so it is the one
/// endpoint that must be invisible unless a deployment asked for it. A 404
/// rather than a 403: a gateway that has not enabled it should not advertise
/// that the feature exists.
#[tokio::test]
async fn signup_is_absent_unless_the_config_enables_it() {
    let gw = Gateway::start("cp-signup-off").await;
    let (status, text) = gw
        .send(
            reqwest::Method::POST,
            "/v1/signup",
            Some(r#"{"id":"acme","name":"Acme"}"#),
        )
        .await;
    assert_eq!(status, 404, "{text}");
    assert!(text.contains("not enabled"), "{text}");
}

/// A scope is checked against the role it is being written on, at the only
/// moment anyone is looking. A key that carried a scope its role can never
/// reach would sit in the list reading as restricted and behave as though it
/// were not, and nothing afterwards would ever say so.
#[tokio::test]
async fn refuses_a_scope_the_role_cannot_carry() {
    let gw = Gateway::start("cp-scope-role").await;

    let (status, text) = gw
        .post_key(r#"{"label":"ci","access_role":"agent","scopes":["keys:write"]}"#)
        .await;
    assert_eq!(status, 400, "{text}");
    assert!(
        text.contains("rail:card"),
        "it must list what is allowed: {text}"
    );

    let (status, text) = gw
        .post_key(r#"{"label":"ci","access_role":"admin","scopes":["rail:card"]}"#)
        .await;
    assert_eq!(status, 400, "{text}");
    assert!(
        text.contains("keys:read"),
        "it must list what is allowed: {text}"
    );
}

/// This gateway checks no approver scope, because releasing a held payment
/// goes through the intent API on its own listener. Accepting one here would
/// write a restriction on a key that nothing applies.
#[tokio::test]
async fn an_approver_key_takes_no_scopes() {
    let gw = Gateway::start("cp-scope-approver").await;
    let (status, text) = gw
        .post_key(r#"{"label":"ci","access_role":"approver","scopes":["holds:release"]}"#)
        .await;
    assert_eq!(status, 400, "{text}");
    assert!(text.contains("takes no scopes"), "{text}");
}

/// Scopes are validated before storage, like everything else in this handler.
/// A request that names a scope its role cannot carry must not reach the
/// database to find that out.
#[tokio::test]
async fn validates_scopes_before_consulting_storage() {
    let gw = Gateway::start("cp-scope-order").await;
    let (_, text) = gw
        .post_key(r#"{"label":"ci","access_role":"agent","scopes":["keys:write"]}"#)
        .await;
    assert!(
        !text.contains("durable storage"),
        "the scope is checked before storage: {text}"
    );
}

/// Omitting scopes is how every caller before this feature asked for a key,
/// and it still means the whole role rather than nothing at all. The proof
/// that it is accepted is that the request gets as far as storage.
#[tokio::test]
async fn a_key_with_no_scopes_named_is_still_a_key() {
    let gw = Gateway::start("cp-scope-none").await;
    for body in [
        r#"{"label":"ci","access_role":"agent"}"#,
        r#"{"label":"ci","access_role":"agent","scopes":[]}"#,
    ] {
        let (status, text) = gw.post_key(body).await;
        assert_eq!(status, 400, "{body}: {text}");
        assert!(
            text.contains("durable storage"),
            "{body} must pass validation and stop at storage: {text}"
        );
    }
}
