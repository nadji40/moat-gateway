//! The service end to end, with a stand-in model and a stand-in gateway.
//!
//! The model is replaced by a server that answers each message with a fixed
//! reading, so what is tested is everything around the model: what it is
//! shown, what of its answer is kept, and what reaches the gateway under
//! whose key.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use moat_intent::reader::Reader;
use moat_intent::server::{router, AppState};
use serde_json::{json, Value};

/// What the stand-in model saw, and what the stand-in gateway was sent.
#[derive(Default)]
struct Seen {
    model: Vec<String>,
    model_requests: Vec<String>,
    gateway: Vec<(Option<String>, Value)>,
}

async fn serve(app: Router) -> String {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
    format!("http://{addr}")
}

/// A model that answers with `answer` for whatever it is asked.
async fn model(seen: Arc<Mutex<Seen>>, answer: Value) -> String {
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(
                |State((seen, answer)): State<(Arc<Mutex<Seen>>, Value)>, raw: String| async move {
                    let body: Value = serde_json::from_str(&raw).unwrap();
                    let message = body["messages"][1]["content"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    let mut seen = seen.lock().unwrap();
                    seen.model.push(message);
                    seen.model_requests.push(raw);
                    Json(json!({"choices": [{"message": {"content": answer.to_string()}}]}))
                },
            ),
        )
        .with_state((seen, answer));
    serve(app).await
}

/// A gateway that records what it was sent and answers like the real one.
async fn gateway(seen: Arc<Mutex<Seen>>) -> String {
    let app = Router::new()
        .route(
            "/v1/session/{id}/intent",
            post(
                |State(seen): State<Arc<Mutex<Seen>>>,
                 headers: HeaderMap,
                 Json(body): Json<Value>| async move {
                    let key = headers
                        .get("authorization")
                        .map(|v| v.to_str().unwrap().to_owned());
                    seen.lock().unwrap().gateway.push((key, body));
                    Json(json!({"turn": 1, "structured": true}))
                },
            ),
        )
        .with_state(seen);
    serve(app).await
}

async fn reader_service(llm: &str, gw: Option<String>) -> String {
    let state = Arc::new(AppState {
        reader: Reader::new(llm, "stand-in", Duration::from_secs(5)).unwrap(),
        gateway: gw,
        http: reqwest::Client::new(),
    });
    serve(router(state)).await
}

#[tokio::test]
async fn a_message_is_read_checked_and_registered_under_the_callers_key() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    // The model gets the payee right, invents a second one, and names the
    // account by its placeholder.
    let llm = model(
        Arc::clone(&seen),
        json!({
            "pay": ["Monitoring Pro Inc", "Monitoring Pro Holdings"],
            "refused": [],
            "amount": "100",
            "currency": "EUR",
            "destinations": ["DEST_1"],
            "references": [],
            "cancels_previous": false
        }),
    )
    .await;
    let gw = gateway(Arc::clone(&seen)).await;
    let service = reader_service(&llm, Some(gw)).await;

    let text = concat!(
        "Pay Monitoring Pro Inc 100 EUR to DE89 3704 0044 0532 0130 00, ",
        "my card is 4111 1111 1111 1111"
    );
    let response = reqwest::Client::new()
        .post(format!("{service}/v1/session/s_1/intent"))
        .bearer_auth("approver-key")
        .json(&json!({ "text": text }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "read");
    assert_eq!(body["cards_removed"], 1);
    assert_eq!(body["dropped"].as_array().unwrap().len(), 1, "{body}");

    let seen = seen.lock().unwrap();
    // The model never saw the account or the card.
    assert!(!seen.model[0].contains("DE89"));
    assert!(!seen.model[0].contains("4111"));
    assert!(seen.model[0].contains("DEST_1"));
    // Property order controls the constrained model's generation order.
    // Check the actual HTTP body, before parsing into an order-losing Value.
    let request = &seen.model_requests[0];
    let properties = request.split_once("\"properties\":").unwrap().1;
    let mut previous = 0;
    for field in [
        "pay",
        "refused",
        "amount",
        "currency",
        "destinations",
        "references",
        "cancels_previous",
    ] {
        let at = properties.find(&format!("\"{field}\":")).unwrap();
        assert!(at > previous, "schema property order changed: {request}");
        previous = at;
    }
    // The gateway got the caller's key, the fields, and no card.
    let (key, sent) = &seen.gateway[0];
    assert_eq!(key.as_deref(), Some("Bearer approver-key"));
    assert!(!sent["text"].as_str().unwrap().contains("4111"));
    assert_eq!(sent["fields"]["pay"], json!(["Monitoring Pro Inc"]));
    assert_eq!(sent["fields"]["amounts"], json!(["100"]));
    assert_eq!(sent["fields"]["currencies"], json!(["EUR"]));
    assert_eq!(
        sent["fields"]["destinations"],
        json!(["DE89 3704 0044 0532 0130 00"])
    );
    assert!(sent["fields"]["reader"]
        .as_str()
        .unwrap()
        .starts_with("moat-intent"));
}

#[tokio::test]
async fn a_model_that_cannot_be_reached_registers_nothing_as_asked_for() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let gw = gateway(Arc::clone(&seen)).await;
    // Nothing listens here.
    let service = reader_service("http://127.0.0.1:9", Some(gw)).await;
    let response = reqwest::Client::new()
        .post(format!("{service}/v1/session/s_1/intent"))
        .bearer_auth("approver-key")
        .json(&json!({ "text": "Pay Orbit Labs Srl 480 USD" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "unavailable");
    let seen = seen.lock().unwrap();
    let fields = &seen.gateway[0].1["fields"];
    assert_eq!(fields["pay"], json!([]));
    assert_eq!(fields["amounts"], json!([]));
    assert!(fields["reader"].as_str().unwrap().ends_with("unavailable"));
}

#[tokio::test]
async fn without_a_key_nothing_is_read_or_forwarded() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let llm = model(Arc::clone(&seen), json!({})).await;
    let gw = gateway(Arc::clone(&seen)).await;
    let service = reader_service(&llm, Some(gw)).await;
    let response = reqwest::Client::new()
        .post(format!("{service}/v1/session/s_1/intent"))
        .json(&json!({ "text": "Pay Orbit Labs Srl 480 USD" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let seen = seen.lock().unwrap();
    assert!(seen.model.is_empty() && seen.gateway.is_empty());
}

#[tokio::test]
async fn read_only_returns_the_fields_for_the_host_to_confirm() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let llm = model(
        Arc::clone(&seen),
        json!({
            "pay": ["Vega Cloud Srl"], "refused": ["Orbit Labs Srl"], "amount": "480",
            "currency": "EUR", "destinations": [], "references": [], "cancels_previous": false
        }),
    )
    .await;
    let service = reader_service(&llm, None).await;
    let body: Value = reqwest::Client::new()
        .post(format!("{service}/v1/read"))
        .json(&json!({ "text": "Non pagare Orbit Labs Srl, paga 480 euro a Vega Cloud Srl" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["fields"]["pay"], json!(["Vega Cloud Srl"]));
    assert_eq!(body["fields"]["refused"], json!(["Orbit Labs Srl"]));
    assert!(seen.lock().unwrap().gateway.is_empty());
}
