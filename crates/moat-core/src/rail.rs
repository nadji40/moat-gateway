//! Which settlement rail a payment upstream moves money on.
//!
//! The rail is a property of the deployment, not of the call: an agent does
//! not get to say how the money leaves. It is declared per upstream in the
//! gateway config and carried into evaluation through
//! [`EvalContext`](crate::policy::EvalContext), so a rail can never be
//! asserted by an argument the model controls.
//!
//! Rails differ in ways that change what a correct verdict is. A card payment
//! is reversible and its destination is a merchant the network already knows.
//! A bank transfer and an on-chain transfer are irreversible, and the
//! destination — an IBAN, an address — *is* the payment. Later phases hang
//! those differences off this enum. [`Rail::reversible`] is the one that
//! decides how an ambiguous provider result is treated: see
//! [`crate::outcome`], where a transfer nobody can recall is counted as
//! having happened and a card authorization is not.
//!
//! The set is closed on purpose. An unrecognised rail in a config is a load
//! error, never a silent fall back to card semantics.

use serde::{Deserialize, Serialize};

/// The settlement rail behind a payment upstream.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Rail {
    /// Card and card-like provider rails: reversible, merchant-identified.
    /// The default, because it is what every deployment before this field was.
    #[default]
    Card,
    /// Account-to-account bank transfer: SEPA, ACH, SARIE, wire. Irreversible
    /// in practice, settles asynchronously, identified by an account number.
    Bank,
    /// On-chain transfer of a native asset or token. Final once confirmed,
    /// identified by an address on a specific network.
    Crypto,
}

impl Rail {
    /// The lowercase wire name, as it appears in config and evidence.
    pub fn as_str(self) -> &'static str {
        match self {
            Rail::Card => "card",
            Rail::Bank => "bank",
            Rail::Crypto => "crypto",
        }
    }

    /// Whether a settled payment on this rail can be pulled back through the
    /// rail's own mechanisms. Card chargebacks exist; a mined transfer and a
    /// completed wire do not come back on request.
    ///
    /// Nothing reads this yet. It is the distinction the outcome state
    /// machine is built on, stated here once so the two rails that share it
    /// cannot drift apart.
    pub fn reversible(self) -> bool {
        matches!(self, Rail::Card)
    }
}

impl std::fmt::Display for Rail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_card_so_existing_deployments_do_not_move() {
        assert_eq!(Rail::default(), Rail::Card);
    }

    #[test]
    fn wire_names_are_lowercase_and_round_trip() {
        for (rail, name) in [
            (Rail::Card, "card"),
            (Rail::Bank, "bank"),
            (Rail::Crypto, "crypto"),
        ] {
            assert_eq!(rail.as_str(), name);
            assert_eq!(rail.to_string(), name);
            assert_eq!(serde_json::to_string(&rail).unwrap(), format!("\"{name}\""));
            assert_eq!(
                serde_json::from_str::<Rail>(&format!("\"{name}\"")).unwrap(),
                rail
            );
        }
    }

    #[test]
    fn an_unknown_rail_is_an_error_not_a_fallback_to_card() {
        assert!(serde_json::from_str::<Rail>("\"sepa\"").is_err());
        assert!(serde_json::from_str::<Rail>("\"Card\"").is_err());
    }

    #[test]
    fn only_card_is_reversible() {
        assert!(Rail::Card.reversible());
        assert!(!Rail::Bank.reversible());
        assert!(!Rail::Crypto.reversible());
    }
}
