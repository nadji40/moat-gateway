//! Evidence records: one per verdict, no verdict without one.
//!
//! This module defines the record, how its bytes are fixed (`canonical_json`),
//! how records chain (`prev` is the SHA-256 of the previous line) and how they
//! are signed (ed25519 over the canonical JSON without `sig`). The format is
//! specified in `docs/evidence-format.md`, which must be kept in sync with
//! this file; the golden test in `tests/golden.rs` pins the bytes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hash::{canonical_json, sha256_hex};
use crate::keys::{KeyError, Keys, Public};
use crate::policy::{Evaluation, FieldProvenance};
use crate::rail::Rail;
use crate::session::Session;
use crate::verdict::{Decision, RuleOutcome};

/// The format version this build writes.
///
/// Version 1 records carry no `format_version` and no `rail`; they were all
/// card. Both fields are omitted when they hold those version 1 meanings, so
/// a version 1 record read by this build re-serializes to the same bytes and
/// its signature still verifies. See `docs/evidence-format.md`.
pub const FORMAT_VERSION: u32 = 2;

fn format_version_1() -> u32 {
    1
}

fn is_format_version_1(v: &u32) -> bool {
    *v == 1
}

/// The call as recorded in evidence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallRecord {
    /// Upstream name.
    pub server: String,
    /// Bare tool name.
    pub tool: String,
    /// JSON-RPC id of the call.
    pub call_id: String,
    /// The arguments as received.
    pub args: Map<String, Value>,
}

/// One evidence record. Serialized as one line of the evidence file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// `ev_` plus 24 hex characters.
    pub id: String,
    /// Which version of this format the record is in. Omitted when 1, which
    /// is what a record written before the field means.
    #[serde(
        default = "format_version_1",
        skip_serializing_if = "is_format_version_1"
    )]
    pub format_version: u32,
    /// The settlement rail the payment was evaluated on. Absent on version 1
    /// records, which predate rails and were all card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail: Option<Rail>,
    /// Session id.
    pub session: String,
    /// RFC 3339 timestamp of the evaluation.
    pub ts: String,
    /// The call.
    pub call: CallRecord,
    /// Provenance per logical field.
    pub provenance: BTreeMap<String, FieldProvenance>,
    /// Every rule evaluated.
    pub rules: Vec<RuleOutcome>,
    /// The decision.
    pub verdict: Decision,
    /// SHA-256 over the canonical JSON of the session's event log at the
    /// moment of evaluation, before this evaluation was logged.
    pub context_hash: String,
    /// Hash of the previous record in the file, or `null` for the first.
    pub prev: Option<String>,
    /// ed25519 signature over the canonical JSON of every field above.
    pub sig: Option<String>,
}

impl Record {
    /// Build a record from an evaluation. `prev` is the previous record's
    /// hash; signing is done separately.
    pub fn from_evaluation(session: &Session, eval: &Evaluation, prev: Option<String>) -> Record {
        Record {
            id: eval.verdict.evidence_id.clone(),
            format_version: FORMAT_VERSION,
            rail: Some(eval.rail),
            session: session.id.clone(),
            ts: rfc3339(eval.unix_ms),
            call: CallRecord {
                server: eval.call.server.clone(),
                tool: eval.call.tool.clone(),
                call_id: eval.call.call_id.clone(),
                args: eval.call.args.clone(),
            },
            provenance: eval.provenance.clone(),
            rules: eval.verdict.reasons.clone(),
            verdict: eval.verdict.decision,
            context_hash: context_hash(session),
            prev,
            sig: None,
        }
    }

    /// Canonical JSON of the record with `sig` removed. This is what gets
    /// signed.
    pub fn signing_bytes(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Value::Object(m) = &mut v {
            m.remove("sig");
        }
        canonical_json(&v)
    }

    /// Canonical JSON of the whole record, `sig` included. One line of the
    /// evidence file, and the input to the next record's `prev`.
    pub fn to_line(&self) -> String {
        canonical_json(&serde_json::to_value(self).unwrap_or(Value::Null))
    }

    /// SHA-256 of [`Record::to_line`].
    pub fn hash(&self) -> String {
        sha256_hex(self.to_line().as_bytes())
    }

    /// Sign the record in place.
    pub fn sign(&mut self, keys: &Keys) {
        self.sig = None;
        self.sig = Some(keys.sign_hex(self.signing_bytes().as_bytes()));
    }

    /// Check the signature against a public key.
    pub fn verify_signature(&self, public: &Public) -> Result<(), KeyError> {
        match &self.sig {
            Some(sig) => public.verify_hex(self.signing_bytes().as_bytes(), sig),
            None => Err(KeyError::MalformedSignature(
                "record is unsigned".to_owned(),
            )),
        }
    }
}

/// One problem found while verifying an evidence file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifyProblem {
    /// 1-based line number.
    pub line: usize,
    /// Record id if the line parsed.
    pub id: Option<String>,
    /// What is wrong.
    pub problem: String,
}

/// Outcome of verifying an evidence file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifyReport {
    /// Lines that parsed as records.
    pub records: usize,
    /// Hash of the last good record, i.e. what the next `prev` should be.
    pub head: Option<String>,
    /// Everything wrong, in file order. Empty means the file verifies.
    pub problems: Vec<VerifyProblem>,
}

impl VerifyReport {
    /// True when nothing is wrong.
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

/// Verify the chain and signatures of a whole evidence file.
///
/// Checks, per line: it parses as a record; `prev` equals the hash of the
/// previous line's record (`null` only on the first); the line's bytes are
/// exactly the record's canonical form (a reformatted line is a modified
/// line); and the signature verifies under `public`. Verification continues
/// past a bad line so the report shows everything, but the chain is
/// re-anchored at each parsed record so one edit does not cascade into
/// every later line being blamed.
pub fn verify_file(text: &str, public: &Public) -> VerifyReport {
    let mut report = VerifyReport {
        records: 0,
        head: None,
        problems: Vec::new(),
    };
    let mut prev_hash: Option<String> = None;
    let mut first = true;

    for (i, line) in text.lines().enumerate() {
        let n = i + 1;
        if line.trim().is_empty() {
            continue;
        }
        let record: Record = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                report.problems.push(VerifyProblem {
                    line: n,
                    id: None,
                    problem: format!("not an evidence record: {e}"),
                });
                continue;
            }
        };
        report.records += 1;
        let id = Some(record.id.clone());

        if record.to_line() != line {
            report.problems.push(VerifyProblem {
                line: n,
                id: id.clone(),
                problem: "line is not in canonical form (reformatted or edited)".to_owned(),
            });
        }
        match (&record.prev, &prev_hash, first) {
            (None, _, true) => {}
            (None, _, false) => report.problems.push(VerifyProblem {
                line: n,
                id: id.clone(),
                problem: "prev is null but this is not the first record".to_owned(),
            }),
            (Some(p), Some(expected), _) if p == expected => {}
            (Some(p), Some(expected), _) => report.problems.push(VerifyProblem {
                line: n,
                id: id.clone(),
                problem: format!("chain broken: prev {p} but previous record hashes to {expected}"),
            }),
            (Some(_), None, true) => report.problems.push(VerifyProblem {
                line: n,
                id: id.clone(),
                problem: "first record has a prev".to_owned(),
            }),
            (Some(_), None, false) => report.problems.push(VerifyProblem {
                line: n,
                id: id.clone(),
                problem: "prev set but the previous line was not a record".to_owned(),
            }),
        }
        if let Err(e) = record.verify_signature(public) {
            report.problems.push(VerifyProblem {
                line: n,
                id: id.clone(),
                problem: format!("signature: {e}"),
            });
        }
        // Hash of the line as written: that is what the next record's prev
        // must equal, whether or not this line was good.
        prev_hash = Some(sha256_hex(line.as_bytes()));
        report.head = prev_hash.clone();
        first = false;
    }
    report
}

/// SHA-256 over the canonical JSON of the session's event log.
pub fn context_hash(session: &Session) -> String {
    let events = serde_json::to_value(session.events()).unwrap_or(Value::Null);
    sha256_hex(canonical_json(&events).as_bytes())
}

/// Milliseconds since the epoch as RFC 3339 in UTC with millisecond precision.
pub fn rfc3339(unix_ms: u64) -> String {
    let nanos = i128::from(unix_ms) * 1_000_000;
    time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()
        .and_then(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_formats_utc_millis() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn signing_bytes_exclude_sig_and_line_includes_it() {
        let mut s = Session::new("s");
        s.register_intent("pay Acme 5");
        let policy =
            crate::policy::Policy::from_yaml(include_str!("../../../policies/default.yaml"))
                .unwrap();
        let eval = crate::policy::evaluate(
            &policy,
            &s,
            crate::policy::PaymentCall {
                server: "stripe".into(),
                tool: "pay".into(),
                call_id: "1".into(),
                args: serde_json::from_value(serde_json::json!({"payee": "Acme", "amount": 5}))
                    .unwrap(),
            },
            1_700_000_000_000,
        );
        let mut r = Record::from_evaluation(&s, &eval, None);
        let unsigned = r.signing_bytes();
        assert!(!unsigned.contains("\"sig\""));
        r.sig = Some("abc".into());
        assert_eq!(
            r.signing_bytes(),
            unsigned,
            "sig does not change signing bytes"
        );
        assert!(r.to_line().contains("\"sig\":\"abc\""));
        assert!(
            r.to_line().starts_with("{\"call\":{"),
            "keys sorted: {}",
            r.to_line()
        );
        assert_eq!(r.ts, "2023-11-14T22:13:20Z");
        assert_eq!(r.context_hash.len(), 64);
    }

    /// A record written before `format_version` and `rail` existed must come
    /// back out byte for byte, or every signature already on disk stops
    /// verifying. Both fields are omitted when they mean what version 1 meant.
    #[test]
    fn a_version_1_record_round_trips_byte_identically() {
        let line = concat!(
            r#"{"call":{"args":{"amount":480,"payee":"ProMon Billing Ltd"},"call_id":"10","#,
            r#""server":"stripe","tool":"pay"},"context_hash":"#,
            r#""ddbf141e8d944aad36d7ad9ddf8e3001c79fa79f57ffd49e602843a4d1c4fa91","#,
            r#""id":"ev_f7bab86d7ab458556471f134","prev":null,"provenance":{},"rules":[],"#,
            r#""session":"golden-session","sig":"99b1","ts":"2023-11-14T22:13:22Z","#,
            r#""verdict":"step_up"}"#
        );
        let parsed: Record = serde_json::from_str(line).expect("a version 1 record still parses");
        assert_eq!(parsed.format_version, 1, "absent format_version reads as 1");
        assert_eq!(parsed.rail, None, "version 1 records carry no rail");
        assert_eq!(
            parsed.to_line(),
            line,
            "a version 1 record must serialize back to its own bytes"
        );
    }

    /// New records declare the version and the rail, so a reader never has to
    /// guess which of the two shapes it is holding.
    #[test]
    fn a_new_record_declares_version_2_and_its_rail() {
        let s = Session::new("s");
        let eval = crate::policy::Evaluation {
            call: crate::policy::PaymentCall {
                server: "bank".into(),
                tool: "transfer".into(),
                call_id: "1".into(),
                args: serde_json::Map::new(),
            },
            provenance: BTreeMap::new(),
            verdict: crate::verdict::Verdict {
                decision: Decision::Deny,
                reasons: Vec::new(),
                step_up_prompt: None,
                evidence_id: "ev_x".into(),
            },
            unix_ms: 1_700_000_000_000,
            rail: Rail::Bank,
        };
        let r = Record::from_evaluation(&s, &eval, None);
        assert_eq!(r.format_version, FORMAT_VERSION);
        assert_eq!(r.rail, Some(Rail::Bank));
        let line = r.to_line();
        assert!(line.contains(r#""format_version":2"#), "{line}");
        assert!(line.contains(r#""rail":"bank""#), "{line}");
    }
}
