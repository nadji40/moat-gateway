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
use crate::session::Session;
use crate::verdict::{Decision, RuleOutcome};

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
}
