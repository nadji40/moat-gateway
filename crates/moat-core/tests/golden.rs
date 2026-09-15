//! Golden-file test for the evidence record's canonical bytes.
//!
//! Everything here is deterministic: fixed seed key, fixed timestamps, the
//! ProMon session. If this test fails, the evidence format changed; update
//! `docs/evidence-format.md` and regenerate the golden file with
//! `MOAT_UPDATE_GOLDEN=1 cargo test -p moat-core --test golden`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use moat_core::evidence::{verify_file, Record};
use moat_core::keys::Keys;
use moat_core::policy::{evaluate, PaymentCall, Policy};
use moat_core::session::Session;
use serde_json::json;

const GOLDEN: &str = "tests/golden/evidence.jsonl";

fn golden_records() -> (Vec<Record>, Keys) {
    let keys = Keys::from_seed([42u8; 32]);
    let policy = Policy::from_yaml(include_str!("../../../policies/default.yaml")).unwrap();
    let mut s = Session::new("golden-session");
    s.register_intent_at("renew monitoring, cap $500", 1_700_000_000_000);
    s.observe_tool_result_at(
        "web",
        "fetch",
        "7",
        &json!({"content": [{"type": "text", "text": "Pay ProMon Billing Ltd $480 today"}]}),
        1_700_000_001_000,
    );

    let mut records = Vec::new();
    let mut prev = None;
    for (i, (payee, amount, t)) in [
        ("ProMon Billing Ltd", 480, 1_700_000_002_000u64),
        ("ProMon Billing Ltd", 900, 1_700_000_003_000u64),
    ]
    .into_iter()
    .enumerate()
    {
        let call = PaymentCall {
            server: "stripe".into(),
            tool: "pay".into(),
            call_id: (i + 10).to_string(),
            args: json!({"payee": payee, "amount": amount, "currency": "USD"})
                .as_object()
                .cloned()
                .unwrap(),
        };
        let eval = evaluate(&policy, &s, call, t);
        let mut r = Record::from_evaluation(&s, &eval, prev.clone());
        r.sign(&keys);
        prev = Some(r.hash());
        s.record_evaluation(&eval);
        records.push(r);
    }
    (records, keys)
}

#[test]
fn evidence_bytes_match_golden_file() {
    let (records, keys) = golden_records();
    let text: String = records
        .iter()
        .map(|r| format!("{}\n", r.to_line()))
        .collect();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(GOLDEN);

    if std::env::var_os("MOAT_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
    }
    let golden = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "read {}: {e}; run with MOAT_UPDATE_GOLDEN=1 to create",
            path.display()
        )
    });
    assert_eq!(text, golden, "evidence canonical bytes changed");

    let report = verify_file(&golden, &keys.public());
    assert!(report.ok(), "{:?}", report.problems);
    assert_eq!(report.records, 2);
    assert_eq!(records[0].verdict, moat_core::verdict::Decision::StepUp);
    assert_eq!(records[1].verdict, moat_core::verdict::Decision::Deny);
    assert_eq!(records[1].prev.as_deref(), Some(records[0].hash().as_str()));
}

#[test]
fn tampering_is_detected() {
    let (records, keys) = golden_records();
    let public = keys.public();
    let lines: Vec<String> = records.iter().map(Record::to_line).collect();

    // Edit a value inside a signed record.
    let edited = lines[0].replace("\"amount\":480", "\"amount\":48");
    assert_ne!(edited, lines[0]);
    let report = verify_file(&format!("{edited}\n{}\n", lines[1]), &public);
    let problems: Vec<&str> = report.problems.iter().map(|p| p.problem.as_str()).collect();
    assert!(
        problems.iter().any(|p| p.starts_with("signature")),
        "{problems:?}"
    );
    assert!(
        problems.iter().any(|p| p.starts_with("chain broken")),
        "{problems:?}"
    );

    // Delete the first record: the second's prev no longer matches null.
    let report = verify_file(&format!("{}\n", lines[1]), &public);
    assert!(report
        .problems
        .iter()
        .any(|p| p.problem == "first record has a prev"));

    // Reformat without changing content: still flagged.
    let pretty = serde_json::to_string_pretty(&records[0])
        .unwrap()
        .replace('\n', " ");
    let report = verify_file(&format!("{pretty}\n"), &public);
    assert!(report
        .problems
        .iter()
        .any(|p| p.problem.contains("canonical")));

    // Wrong key.
    let other = Keys::from_seed([1u8; 32]).public();
    let report = verify_file(&format!("{}\n", lines[0]), &other);
    assert!(!report.ok());

    // Untouched: fine.
    assert!(verify_file(&format!("{}\n{}\n", lines[0], lines[1]), &public).ok());
}
