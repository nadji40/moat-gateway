//! Per-session state: what the human asked for, what the tools said, and the
//! chronological log of both.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::extract::extract_leaves;
use crate::hash::sha256_hex;
use crate::normalize::{normalize_text, numbers_in_text, Normalized};
use crate::source::Source;

/// A registered statement of what the human asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intent {
    /// 1-based registration order within the session.
    pub turn: u32,
    /// The text as given.
    pub text: String,
    /// Normalized text, for substring matching.
    pub normalized: String,
    /// Every number-looking token in the text, canonicalized.
    pub numbers: Vec<String>,
}

/// One value seen in a tool result, with where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observed {
    /// Monotonic order of observation within the session.
    pub seq: u64,
    /// Canonical forms.
    pub value: Normalized,
    /// Always a `ToolResult` for now; kept general for future ingest paths.
    pub source: Source,
    /// JSON pointer inside the result.
    pub path: String,
}

/// A user-approved envelope for one supplier payment (or an explicitly
/// bounded series of payments).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentAuthorization {
    /// Stable host-generated identifier carried by every payment proposal.
    pub id: String,
    /// Supplier name exactly as approved by the user.
    pub payee: String,
    /// Stable payment-rail account or merchant identity, when the host knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient_account_id: Option<String>,
    /// Expected amount in the currency's minor unit.
    pub amount_minor: u64,
    /// Permitted increase above `amount_minor`.
    pub tolerance_minor: u64,
    /// Uppercase ISO 4217 currency code.
    pub currency: String,
    /// Invoice that this authorization covers when repeats are disabled.
    pub invoice_id: String,
    /// SHA-256 of canonical invoice content, independent of the supplier's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoice_fingerprint: Option<String>,
    /// Require every proposal under a repeat mandate to identify invoice content.
    #[serde(default)]
    pub require_invoice_fingerprint: bool,
    /// Maximum settled value across every payment using this authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate_limit_minor: Option<u64>,
    /// Milliseconds since Unix epoch after which the authorization is invalid.
    pub expires_unix_ms: u64,
    /// Whether multiple, uniquely identified invoices may use this mandate.
    pub repeat_payments: bool,
    /// Maximum number of successfully settled payments.
    pub max_payments: u32,
    /// Set when the user or host cancels the authorization.
    pub cancelled: bool,
}

/// The provider-side result observed after Moat allowed a payment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentOutcome {
    /// Authorization that permitted the attempt.
    pub authorization_id: String,
    /// Supplier invoice carried to the provider.
    pub invoice_id: String,
    /// Canonical invoice fingerprint carried by the successful proposal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoice_fingerprint: Option<String>,
    /// Settled value in the authorization currency's minor unit.
    #[serde(default)]
    pub amount_minor: u64,
    /// Signed verdict that allowed the attempt.
    pub evidence_id: String,
    /// Upstream provider name.
    pub provider: String,
    /// Provider transaction identifier, when one was returned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<String>,
    /// Provider status or local failure classification.
    pub status: String,
    /// True only for a provider-confirmed successful settlement.
    pub succeeded: bool,
    /// Milliseconds since Unix epoch when Moat observed the outcome.
    pub unix_ms: u64,
}

/// A payment that passed policy and is currently in flight to its provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentReservation {
    /// Stable identity of the exact server, tool and argument payload.
    pub fingerprint: String,
    /// Authorization that permitted the proposal.
    pub authorization_id: String,
    /// Supplier invoice carried by the proposal.
    pub invoice_id: String,
    /// Canonical invoice content identity, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoice_fingerprint: Option<String>,
    /// Proposed value in the authorization currency's minor unit.
    pub amount_minor: u64,
}

/// Something that happened in a session. The evidence `context_hash` is
/// computed over the serialized log of these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// The host registered an intent.
    IntentRegistered {
        /// Its turn number.
        turn: u32,
        /// SHA-256 of the text; the text itself stays in the session.
        text_sha256: String,
    },
    /// A tool result was ingested.
    ToolResultObserved {
        /// Upstream name.
        server: String,
        /// Tool name.
        tool: String,
        /// JSON-RPC id of the call.
        call_id: String,
        /// How many leaves were extracted.
        leaves: usize,
        /// SHA-256 of the result's canonical JSON. Bodies are never logged.
        result_sha256: String,
    },
    /// A payment tool call was evaluated. Filled in by the policy layer.
    PaymentEvaluated {
        /// Evidence record id.
        evidence_id: String,
        /// `allow`, `step_up` or `deny`.
        verdict: String,
    },
    /// The host confirmed a step-up; the confirmed values are now `User`.
    StepUpResolved {
        /// The resume token that was presented.
        resume_token: String,
        /// Whether the human approved.
        approved: bool,
    },
    /// The host declared whether a human is present.
    HeadlessSet {
        /// True when no human is available.
        headless: bool,
    },
    /// A structured payment authorization was registered.
    PaymentAuthorizationRegistered {
        /// Stable authorization identifier.
        authorization_id: String,
        /// Invoice initially covered by the authorization.
        invoice_id: String,
    },
    /// A structured payment authorization was cancelled.
    PaymentAuthorizationCancelled {
        /// Stable authorization identifier.
        authorization_id: String,
    },
    /// Human approval was granted for one exact payment proposal.
    PaymentProposalApproved {
        /// SHA-256 over server, tool and canonical arguments.
        fingerprint: String,
    },
    /// The payment provider returned (or failed to return) an outcome.
    PaymentOutcomeObserved {
        /// Authorization that permitted the attempt.
        authorization_id: String,
        /// Supplier invoice carried to the provider.
        invoice_id: String,
        /// Canonical invoice fingerprint, when present.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invoice_fingerprint: Option<String>,
        /// Settled value in the authorization currency's minor unit.
        #[serde(default)]
        amount_minor: u64,
        /// Signed verdict that allowed the attempt.
        evidence_id: String,
        /// Upstream provider name.
        provider: String,
        /// Provider status or local failure classification.
        status: String,
        /// True only for a provider-confirmed successful settlement.
        succeeded: bool,
    },
}

/// An [`Event`] with its position and time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRecord {
    /// 0-based position in the log.
    pub seq: u64,
    /// Milliseconds since the Unix epoch.
    pub unix_ms: u64,
    /// The event.
    #[serde(flatten)]
    pub event: Event,
}

/// All state for one session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// The session id.
    pub id: String,
    intents: Vec<Intent>,
    observed: Vec<Observed>,
    authorizations: Vec<PaymentAuthorization>,
    payment_outcomes: Vec<PaymentOutcome>,
    #[serde(default)]
    payment_reservations: Vec<PaymentReservation>,
    approved_payment_fingerprints: Vec<String>,
    events: Vec<EventRecord>,
    headless: bool,
    next_seq: u64,
}

impl Session {
    /// An empty session.
    pub fn new(id: impl Into<String>) -> Session {
        Session {
            id: id.into(),
            intents: Vec::new(),
            observed: Vec::new(),
            authorizations: Vec::new(),
            payment_outcomes: Vec::new(),
            payment_reservations: Vec::new(),
            approved_payment_fingerprints: Vec::new(),
            events: Vec::new(),
            headless: false,
            next_seq: 0,
        }
    }

    /// Register what the human asked for. Returns the turn number.
    pub fn register_intent(&mut self, text: &str) -> u32 {
        self.register_intent_at(text, now_unix_ms())
    }

    /// [`Session::register_intent`] with an explicit event timestamp.
    pub fn register_intent_at(&mut self, text: &str, unix_ms: u64) -> u32 {
        let turn = u32::try_from(self.intents.len() + 1).unwrap_or(u32::MAX);
        self.intents.push(Intent {
            turn,
            text: text.to_owned(),
            normalized: normalize_text(text),
            numbers: numbers_in_text(text),
        });
        self.log_at(
            Event::IntentRegistered {
                turn,
                text_sha256: sha256_hex(text.as_bytes()),
            },
            unix_ms,
        );
        turn
    }

    /// Ingest a tool result: every string and number leaf becomes an observed
    /// value with a `ToolResult` source. Returns how many were added.
    pub fn observe_tool_result(
        &mut self,
        server: &str,
        tool: &str,
        call_id: &str,
        result: &Value,
    ) -> usize {
        self.observe_tool_result_at(server, tool, call_id, result, now_unix_ms())
    }

    /// [`Session::observe_tool_result`] with an explicit event timestamp.
    pub fn observe_tool_result_at(
        &mut self,
        server: &str,
        tool: &str,
        call_id: &str,
        result: &Value,
        unix_ms: u64,
    ) -> usize {
        let leaves = extract_leaves(result);
        let count = leaves.len();
        let source = Source::ToolResult {
            server: server.to_owned(),
            tool: tool.to_owned(),
            call_id: call_id.to_owned(),
        };
        for leaf in leaves {
            let seq = self.next_seq;
            self.next_seq += 1;
            self.observed.push(Observed {
                seq,
                value: leaf.value,
                source: source.clone(),
                path: leaf.path,
            });
        }
        let canonical = crate::hash::canonical_json(result);
        self.log_at(
            Event::ToolResultObserved {
                server: server.to_owned(),
                tool: tool.to_owned(),
                call_id: call_id.to_owned(),
                leaves: count,
                result_sha256: sha256_hex(canonical.as_bytes()),
            },
            unix_ms,
        );
        count
    }

    /// Mark whether a human is available to answer a step-up.
    pub fn set_headless(&mut self, headless: bool) {
        self.headless = headless;
        self.log(Event::HeadlessSet { headless });
    }

    /// Whether the host said no human is present.
    pub fn is_headless(&self) -> bool {
        self.headless
    }

    /// Register a structured payment authorization. Ids are unique within a
    /// session so a stale client cannot silently replace prior user intent.
    pub fn register_payment_authorization(
        &mut self,
        authorization: PaymentAuthorization,
    ) -> Result<(), &'static str> {
        if self
            .authorizations
            .iter()
            .any(|existing| existing.id == authorization.id)
        {
            return Err("authorization id already exists");
        }
        self.log(Event::PaymentAuthorizationRegistered {
            authorization_id: authorization.id.clone(),
            invoice_id: authorization.invoice_id.clone(),
        });
        self.authorizations.push(authorization);
        Ok(())
    }

    /// Cancel an authorization. A settled payment remains in the outcome log.
    pub fn cancel_payment_authorization(&mut self, id: &str) -> bool {
        let Some(authorization) = self.authorizations.iter_mut().find(|a| a.id == id) else {
            return false;
        };
        if !authorization.cancelled {
            authorization.cancelled = true;
            self.log(Event::PaymentAuthorizationCancelled {
                authorization_id: id.to_owned(),
            });
        }
        true
    }

    /// Structured payment authorizations in registration order.
    pub fn payment_authorizations(&self) -> &[PaymentAuthorization] {
        &self.authorizations
    }

    /// Find a structured authorization by id.
    pub fn payment_authorization(&self, id: &str) -> Option<&PaymentAuthorization> {
        self.authorizations.iter().find(|a| a.id == id)
    }

    /// Provider outcomes in observation order.
    pub fn payment_outcomes(&self) -> &[PaymentOutcome] {
        &self.payment_outcomes
    }

    /// Payments that passed policy but have not produced a provider outcome.
    pub fn payment_reservations(&self) -> &[PaymentReservation] {
        &self.payment_reservations
    }

    /// Reserve a proposal before forwarding it to the provider.
    pub fn reserve_payment(&mut self, reservation: PaymentReservation) -> bool {
        if self
            .payment_reservations
            .iter()
            .any(|existing| existing.fingerprint == reservation.fingerprint)
        {
            return false;
        }
        self.payment_reservations.push(reservation);
        true
    }

    /// Release an in-flight proposal that never produced a settled outcome.
    pub fn release_payment_reservation(&mut self, fingerprint: &str) -> bool {
        let before = self.payment_reservations.len();
        self.payment_reservations
            .retain(|reservation| reservation.fingerprint != fingerprint);
        self.payment_reservations.len() != before
    }

    /// Atomically replace an in-flight reservation with its provider outcome.
    pub fn finish_reserved_payment(&mut self, fingerprint: &str, outcome: PaymentOutcome) {
        self.release_payment_reservation(fingerprint);
        self.record_payment_outcome(outcome);
    }

    /// Record a provider outcome and append its audit event.
    pub fn record_payment_outcome(&mut self, outcome: PaymentOutcome) {
        self.log_at(
            Event::PaymentOutcomeObserved {
                authorization_id: outcome.authorization_id.clone(),
                invoice_id: outcome.invoice_id.clone(),
                invoice_fingerprint: outcome.invoice_fingerprint.clone(),
                amount_minor: outcome.amount_minor,
                evidence_id: outcome.evidence_id.clone(),
                provider: outcome.provider.clone(),
                status: outcome.status.clone(),
                succeeded: outcome.succeeded,
            },
            outcome.unix_ms,
        );
        self.payment_outcomes.push(outcome);
    }

    /// Remember a human approval for the exact server/tool/argument payload.
    pub fn approve_payment_proposal(&mut self, fingerprint: String) {
        if !self.approved_payment_fingerprints.contains(&fingerprint) {
            self.log(Event::PaymentProposalApproved {
                fingerprint: fingerprint.clone(),
            });
            self.approved_payment_fingerprints.push(fingerprint);
        }
    }

    /// Whether a human approved this exact payment proposal.
    pub fn is_payment_proposal_approved(&self, fingerprint: &str) -> bool {
        self.approved_payment_fingerprints
            .iter()
            .any(|approved| approved == fingerprint)
    }

    /// Append an event to the log, stamped with the current time.
    pub fn log(&mut self, event: Event) {
        self.log_at(event, now_unix_ms());
    }

    /// Append an event to the log with an explicit timestamp, so callers
    /// that already chose a "now" (the policy evaluator) stay consistent
    /// with it.
    pub fn log_at(&mut self, event: Event, unix_ms: u64) {
        let seq = u64::try_from(self.events.len()).unwrap_or(u64::MAX);
        self.events.push(EventRecord {
            seq,
            unix_ms,
            event,
        });
    }

    /// Registered intents in order.
    pub fn intents(&self) -> &[Intent] {
        &self.intents
    }

    /// Observed values in order of observation.
    pub fn observed(&self) -> &[Observed] {
        &self.observed
    }

    /// The event log.
    pub fn events(&self) -> &[EventRecord] {
        &self.events
    }
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// In-memory map of sessions by id. Cheap to clone; all clones share state.
#[derive(Debug, Clone, Default)]
pub struct SessionStore {
    inner: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
}

impl SessionStore {
    /// An empty store.
    pub fn new() -> SessionStore {
        SessionStore::default()
    }

    /// The session with this id, created if absent.
    pub fn get_or_create(&self, id: &str) -> Arc<Mutex<Session>> {
        let mut map = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(
            map.entry(id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(Session::new(id)))),
        )
    }

    /// The session with this id, if it exists.
    pub fn get(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        let map = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        map.get(id).map(Arc::clone)
    }

    /// Ids of all sessions.
    pub fn ids(&self) -> Vec<String> {
        let map = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        map.keys().cloned().collect()
    }
}

/// Lock a session, recovering from a poisoned mutex: a panic in one handler
/// must not take the whole gateway's state with it.
pub fn lock(session: &Mutex<Session>) -> MutexGuard<'_, Session> {
    session.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn intents_are_numbered_and_normalized() {
        let mut s = Session::new("s1");
        assert_eq!(s.register_intent("Renew  monitoring, cap $500"), 1);
        assert_eq!(s.register_intent("and the CDN"), 2);
        assert_eq!(s.intents()[0].normalized, "renew monitoring, cap $500");
        assert_eq!(s.intents()[0].numbers, vec!["500"]);
        assert_eq!(s.events().len(), 2);
        assert!(matches!(
            s.events()[0].event,
            Event::IntentRegistered { turn: 1, .. }
        ));
    }

    #[test]
    fn tool_results_become_observed_values() {
        let mut s = Session::new("s1");
        let n = s.observe_tool_result(
            "web",
            "fetch",
            "7",
            &json!({"content": [{"type": "text", "text": "Pay ProMon Billing Ltd $480"}]}),
        );
        assert_eq!(n, 3); // the sentence, 480 inside it, and "text"
        let o = s.observed();
        assert_eq!(o[0].value.text, "pay promon billing ltd $480");
        assert_eq!(o[1].value.number.as_deref(), Some("480"));
        assert_eq!(o[2].value.text, "text");
        assert_eq!(
            o[0].source,
            Source::ToolResult {
                server: "web".into(),
                tool: "fetch".into(),
                call_id: "7".into()
            }
        );
        assert_eq!(o[0].seq, 0);
        assert_eq!(o[2].seq, 2);
        let Event::ToolResultObserved {
            leaves,
            result_sha256,
            ..
        } = &s.events()[0].event
        else {
            panic!("wrong event");
        };
        assert_eq!(*leaves, 3);
        assert_eq!(result_sha256.len(), 64);
    }

    #[test]
    fn store_shares_sessions_between_clones() {
        let store = SessionStore::new();
        let a = store.get_or_create("x");
        lock(&a).register_intent("hi");
        let store2 = store.clone();
        let b = store2.get("x").unwrap();
        assert_eq!(lock(&b).intents().len(), 1);
        assert!(store.get("nope").is_none());
    }
}
