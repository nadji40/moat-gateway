//! What happened after Moat allowed a payment.
//!
//! Until now Moat asked one question of a provider's reply: did it say
//! `succeeded`? Anything else was a failure, the reservation was released,
//! and the same payment could be sent again. On a card that is right. The
//! authorization either took or it did not, and if it took and should not
//! have, it can be reversed.
//!
//! On a bank transfer it is wrong, and wrong in the direction that costs
//! money. A transfer is not finished when the request returns. It is
//! accepted, then submitted, then settled, over hours or days, and once it
//! is submitted nobody can recall it. If the response is lost in between,
//! Moat does not know which of those happened. Releasing the reservation at
//! that point tells the agent the payment did not go through, and the agent
//! does the obvious thing and sends it again.
//!
//! So this module separates two facts that were previously one:
//!
//! - **What the provider said**, as [`OutcomeStatus`]. Seven states, and an
//!   unrecognised one is [`OutcomeStatus::Unknown`] rather than a failure.
//! - **Whether Moat counts it against the mandate**, which is a decision,
//!   not an observation, and which depends on the rail.
//!
//! The decision is [`OutcomeStatus::disposition`]. Read it once there and
//! nowhere else.

use serde::{Deserialize, Serialize};

use crate::rail::Rail;

/// What a provider said about a payment, in one vocabulary across rails.
///
/// The ordering is the order money moves through: accepted, handed over,
/// seen, final. [`Unknown`](OutcomeStatus::Unknown) is not a stage; it is
/// the absence of an answer.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeStatus {
    /// The provider accepted the instruction and has not acted on it.
    Pending,
    /// The instruction has been handed to the network. Not recallable.
    Submitted,
    /// The network has seen it. Not final, not recallable.
    Confirmed,
    /// Final: the money arrived.
    Succeeded,
    /// Final: the money did not move.
    Failed,
    /// It moved and came back: a return, a refund, a reorg.
    Reversed,
    /// Moat does not know, and must not guess. A lost response, a transport
    /// error, a status string nobody has taught it. This is the state the
    /// rest of this module exists for.
    #[default]
    Unknown,
}

/// How Moat treats an outcome, once the rail is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct Disposition {
    /// Whether the value counts against the mandate's limits and usage.
    pub committed: bool,
    /// Whether Moat cannot account for this payment and must refuse further
    /// ones under the same authorization until somebody checks.
    pub quarantined: bool,
}

impl OutcomeStatus {
    /// Map whatever a provider wrote into this vocabulary.
    ///
    /// Anything unrecognised is [`Unknown`](OutcomeStatus::Unknown), never
    /// [`Failed`](OutcomeStatus::Failed). A provider that invents a status
    /// string has told Moat nothing, and "nothing" must not read as "the
    /// money did not move".
    pub fn from_provider(raw: &str) -> OutcomeStatus {
        match raw.trim().to_ascii_lowercase().as_str() {
            "succeeded" | "success" | "settled" | "completed" | "complete" | "finalized"
            | "finalised" | "paid" => OutcomeStatus::Succeeded,
            "confirmed" => OutcomeStatus::Confirmed,
            "submitted" | "broadcast" | "sent" | "in_flight" | "inflight" => {
                OutcomeStatus::Submitted
            }
            "pending" | "processing" | "accepted" | "queued" | "scheduled" => {
                OutcomeStatus::Pending
            }
            "failed" | "failure" | "cancelled" | "canceled" | "rejected" | "declined"
            | "expired" => OutcomeStatus::Failed,
            "reversed" | "refunded" | "returned" | "chargeback" | "reorged" => {
                OutcomeStatus::Reversed
            }
            _ => OutcomeStatus::Unknown,
        }
    }

    /// Whether the provider has given a final answer.
    pub fn terminal(self) -> bool {
        matches!(
            self,
            OutcomeStatus::Succeeded | OutcomeStatus::Failed | OutcomeStatus::Reversed
        )
    }

    /// Whether the provider has said, definitely, that the money did not
    /// move or came back.
    fn definitely_not_paid(self) -> bool {
        matches!(self, OutcomeStatus::Failed | OutcomeStatus::Reversed)
    }

    /// How Moat treats an outcome in this state on this rail.
    ///
    /// A definite answer means the same thing everywhere: settled counts,
    /// failed and reversed do not. It is the indefinite answers that divide
    /// the rails.
    ///
    /// On a reversible rail an accepted-but-unfinished payment does not
    /// count, which is what makes a lost response safely retryable and is
    /// exactly the behaviour every card deployment has had.
    ///
    /// On an irreversible rail it counts, because it may already be gone.
    /// And when the state is [`Unknown`](OutcomeStatus::Unknown) it is also
    /// quarantined: counting it protects the limit, but Moat still does not
    /// know whether this authorization has been used, and guessing either
    /// way is how a supplier gets paid twice.
    pub fn disposition(self, rail: Rail) -> Disposition {
        if self.terminal() {
            return Disposition {
                committed: !self.definitely_not_paid(),
                quarantined: false,
            };
        }
        if rail.reversible() {
            return Disposition {
                committed: false,
                quarantined: false,
            };
        }
        Disposition {
            committed: true,
            quarantined: self == OutcomeStatus::Unknown,
        }
    }

    /// The name this status serializes as.
    pub fn as_str(self) -> &'static str {
        match self {
            OutcomeStatus::Pending => "pending",
            OutcomeStatus::Submitted => "submitted",
            OutcomeStatus::Confirmed => "confirmed",
            OutcomeStatus::Succeeded => "succeeded",
            OutcomeStatus::Failed => "failed",
            OutcomeStatus::Reversed => "reversed",
            OutcomeStatus::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for OutcomeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Whether a reconciliation may move an outcome from `from` to `to`.
///
/// Reconciliation is someone going to the provider and reporting back what
/// they found, so it may resolve an open state into any other state. What it
/// may not do is contradict a final answer: an outcome that settled cannot
/// become pending again, and one that failed cannot quietly become a
/// success. The one move allowed out of a terminal state is
/// [`Succeeded`](OutcomeStatus::Succeeded) to
/// [`Reversed`](OutcomeStatus::Reversed), because that is a thing that
/// actually happens to money.
pub fn may_reconcile(from: OutcomeStatus, to: OutcomeStatus) -> bool {
    if from == to {
        return true;
    }
    if !from.terminal() {
        return true;
    }
    from == OutcomeStatus::Succeeded && to == OutcomeStatus::Reversed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_words_map_onto_the_vocabulary() {
        for (raw, want) in [
            ("succeeded", OutcomeStatus::Succeeded),
            ("SETTLED", OutcomeStatus::Succeeded),
            ("  completed ", OutcomeStatus::Succeeded),
            ("confirmed", OutcomeStatus::Confirmed),
            ("broadcast", OutcomeStatus::Submitted),
            ("processing", OutcomeStatus::Pending),
            ("declined", OutcomeStatus::Failed),
            ("returned", OutcomeStatus::Reversed),
        ] {
            assert_eq!(OutcomeStatus::from_provider(raw), want, "{raw}");
        }
    }

    /// The default for anything unrecognised has to be the state that makes
    /// Moat careful, not the one that makes it permissive.
    #[test]
    fn a_status_nobody_taught_it_is_unknown_and_not_failed() {
        for raw in [
            "",
            "weird",
            "transport_error",
            "provider_error",
            "in progress",
        ] {
            assert_eq!(
                OutcomeStatus::from_provider(raw),
                OutcomeStatus::Unknown,
                "{raw}"
            );
        }
    }

    /// The card rail's behaviour is the one every existing deployment has,
    /// and this phase must not move it: an unfinished payment does not count
    /// and nothing is quarantined, so a lost response stays retryable.
    #[test]
    fn a_reversible_rail_treats_an_unfinished_payment_as_not_having_happened() {
        for status in [
            OutcomeStatus::Pending,
            OutcomeStatus::Submitted,
            OutcomeStatus::Confirmed,
            OutcomeStatus::Unknown,
        ] {
            let d = status.disposition(Rail::Card);
            assert!(!d.committed, "{status} should not count on a card");
            assert!(!d.quarantined, "{status} should not quarantine a card");
        }
    }

    /// The point of the phase. On a rail where the money does not come
    /// back, "I do not know" has to mean "assume it is gone".
    #[test]
    fn an_irreversible_rail_treats_an_unfinished_payment_as_having_happened() {
        for rail in [Rail::Bank, Rail::Crypto] {
            for status in [
                OutcomeStatus::Pending,
                OutcomeStatus::Submitted,
                OutcomeStatus::Confirmed,
            ] {
                let d = status.disposition(rail);
                assert!(d.committed, "{status} on {rail:?} must count");
                assert!(!d.quarantined, "{status} on {rail:?} is accounted for");
            }
            let unknown = OutcomeStatus::Unknown.disposition(rail);
            assert!(unknown.committed, "unknown on {rail:?} must count");
            assert!(
                unknown.quarantined,
                "unknown on {rail:?} is not accounted for and must stop the mandate"
            );
        }
    }

    #[test]
    fn a_final_answer_means_the_same_thing_on_every_rail() {
        for rail in [Rail::Card, Rail::Bank, Rail::Crypto] {
            assert!(OutcomeStatus::Succeeded.disposition(rail).committed);
            assert!(!OutcomeStatus::Failed.disposition(rail).committed);
            assert!(!OutcomeStatus::Reversed.disposition(rail).committed);
            for status in [
                OutcomeStatus::Succeeded,
                OutcomeStatus::Failed,
                OutcomeStatus::Reversed,
            ] {
                assert!(!status.disposition(rail).quarantined);
            }
        }
    }

    #[test]
    fn reconciliation_resolves_open_states_and_will_not_rewrite_history() {
        assert!(may_reconcile(
            OutcomeStatus::Unknown,
            OutcomeStatus::Succeeded
        ));
        assert!(may_reconcile(OutcomeStatus::Unknown, OutcomeStatus::Failed));
        assert!(may_reconcile(
            OutcomeStatus::Pending,
            OutcomeStatus::Succeeded
        ));
        assert!(may_reconcile(
            OutcomeStatus::Submitted,
            OutcomeStatus::Failed
        ));
        // Money that arrived can still come back.
        assert!(may_reconcile(
            OutcomeStatus::Succeeded,
            OutcomeStatus::Reversed
        ));
        // Nothing else may contradict a final answer.
        assert!(!may_reconcile(
            OutcomeStatus::Succeeded,
            OutcomeStatus::Pending
        ));
        assert!(!may_reconcile(
            OutcomeStatus::Failed,
            OutcomeStatus::Succeeded
        ));
        assert!(!may_reconcile(
            OutcomeStatus::Reversed,
            OutcomeStatus::Succeeded
        ));
        // Restating what is already known is allowed and changes nothing.
        assert!(may_reconcile(OutcomeStatus::Failed, OutcomeStatus::Failed));
    }
}
