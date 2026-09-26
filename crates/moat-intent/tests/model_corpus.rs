//! The reader against a real model, on 36 messages in 12 languages.
//!
//! Skipped unless `MOAT_INTENT_LLM_URL` names a running `llama-server`, so
//! `cargo test` stays green on a machine without one. To run it:
//!
//!   llama-server -hf unsloth/gemma-4-E4B-it-GGUF:Q4_K_M --jinja -c 4096 --port 8092
//!   MOAT_INTENT_LLM_URL=http://127.0.0.1:8092 cargo test -p moat-intent --test model_corpus -- --nocapture
//!
//! The assertion that matters is that nothing fails open: no message yields
//! a payee the user refused or never named. That is checked on what survives
//! grounding, which is what the gateway would register. Everything else is
//! reported, and a reading that is merely incomplete costs a confirmation.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::{Duration, Instant};

use moat_core::normalize::spelling_key;
use moat_intent::reader::{Reader, Status};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    id: String,
    text: String,
    pay: Option<String>,
    refused: Vec<String>,
    amount: Option<String>,
    currencies: Vec<String>,
    cancels: bool,
    references: Vec<String>,
}

fn same(a: &str, b: &str) -> bool {
    spelling_key(a) == spelling_key(b)
}

#[tokio::test]
async fn the_reader_never_asks_for_a_payee_the_user_did_not() {
    let Ok(url) = std::env::var("MOAT_INTENT_LLM_URL") else {
        eprintln!("skipped: set MOAT_INTENT_LLM_URL to a running llama-server");
        return;
    };
    let model =
        std::env::var("MOAT_INTENT_MODEL").unwrap_or_else(|_| "gemma-4-E4B-it-Q4_K_M".into());
    let reader = Reader::new(&url, &model, Duration::from_secs(120)).unwrap();
    let cases: Vec<Case> = serde_json::from_str(include_str!("corpus.json")).unwrap();

    let (mut fail_open, mut payee_ok, mut refused_ok, mut amount_ok, mut currency_ok) =
        (0, 0, 0, 0, 0);
    let mut cancel_ok = 0;
    let mut references_ok = 0;
    let mut times = Vec::new();
    for case in &cases {
        let started = Instant::now();
        let reading = reader.read(&case.text).await;
        times.push(started.elapsed());
        assert_eq!(
            reading.status,
            Status::Read,
            "{}: {:?}",
            case.id,
            reading.error
        );
        let f = &reading.fields;

        let wanted: Vec<&str> = case.pay.iter().map(String::as_str).collect();
        let unasked: Vec<&String> = f
            .pay
            .iter()
            .filter(|p| !wanted.iter().any(|w| same(p, w)))
            .collect();
        if !unasked.is_empty() {
            fail_open += 1;
        }
        let payee_right =
            unasked.is_empty() && wanted.iter().all(|w| f.pay.iter().any(|p| same(p, w)));
        payee_ok += usize::from(payee_right);
        let refusals_right = case
            .refused
            .iter()
            .all(|r| f.refused.iter().any(|x| same(x, r)));
        refused_ok += usize::from(refusals_right);
        let expected_amount = case
            .amount
            .as_deref()
            .filter(|_| case.pay.is_some())
            .map(|a| {
                moat_core::normalize::normalize_number(&moat_core::normalize::ascii_digits(
                    &a.replace(',', ""),
                ))
            });
        let amount_right = match expected_amount {
            None => f.amounts.is_empty(),
            Some(expected) => f.amounts.first().cloned() == expected || f.amounts.is_empty(),
        };
        amount_ok += usize::from(amount_right);
        let currency_right = case.pay.is_none()
            || f.currencies.is_empty()
            || f.currencies.iter().all(|c| case.currencies.contains(c));
        currency_ok += usize::from(currency_right);
        cancel_ok += usize::from(f.cancels_previous == case.cancels);
        references_ok += usize::from(case.references.iter().all(|r| f.references.contains(r)));

        println!(
            "{:18} {}{} pay={:?} refused={:?} amounts={:?} cur={:?} refs={:?} cancel={} dropped={:?} {:.1}s",
            case.id,
            if unasked.is_empty() { "" } else { "FAIL-OPEN " },
            if payee_right && refusals_right {
                "ok"
            } else {
                "--"
            },
            f.pay,
            f.refused,
            f.amounts,
            f.currencies,
            f.references,
            f.cancels_previous,
            reading.dropped,
            started.elapsed().as_secs_f32()
        );
    }
    times.sort();
    let n = cases.len();
    println!(
        "\n{model}: fail-open {fail_open}  payee {payee_ok}/{n}  refused {refused_ok}/{n}  \
         amount {amount_ok}/{n}  currency {currency_ok}/{n}  cancel {cancel_ok}/{n}  references {references_ok}/{n}  median {:.1}s",
        times[n / 2].as_secs_f32()
    );
    assert_eq!(
        fail_open, 0,
        "the reader asked for a payee the user refused or never named"
    );
}
