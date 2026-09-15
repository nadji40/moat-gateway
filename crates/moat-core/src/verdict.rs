//! The answer Moat gives to a payment call.

use serde::{Deserialize, Serialize};

use crate::source::SourceKind;

/// What the gateway should do with the call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// Forward to the upstream.
    Allow,
    /// Do not forward; ask a human.
    StepUp,
    /// Do not forward.
    Deny,
}

impl Decision {
    /// The more severe of two decisions. `Deny > StepUp > Allow`.
    pub fn max(self, other: Decision) -> Decision {
        std::cmp::max(self, other)
    }

    /// Lowercase name as used in evidence and error payloads.
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::StepUp => "step_up",
            Decision::Deny => "deny",
        }
    }
}

impl std::fmt::Display for Decision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The result of evaluating one rule against one call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleOutcome {
    /// Rule id from the policy, or `velocity` for the velocity check.
    pub id: String,
    /// Field the rule applied to, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// Whether the rule passed.
    pub passed: bool,
    /// The source the field resolved to, when the rule looked at one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceKind>,
    /// What the rule would do on failure.
    pub on_fail: Decision,
    /// Human-readable explanation.
    pub message: String,
}

/// The verdict for a payment call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    /// The decision.
    pub decision: Decision,
    /// Every rule evaluated, pass or fail.
    pub reasons: Vec<RuleOutcome>,
    /// A question for the host to show a human, on `StepUp`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_up_prompt: Option<String>,
    /// Id of the evidence record this verdict is recorded in.
    pub evidence_id: String,
}

impl Verdict {
    /// The failing rules only.
    pub fn failures(&self) -> impl Iterator<Item = &RuleOutcome> {
        self.reasons.iter().filter(|r| !r.passed)
    }
}

/// JSON-RPC error codes the gateway uses to refuse a call.
///
/// These are the numbers from the project brief. MCP revision 2026-07-28
/// reserves `-32020..=-32099` for the specification itself and forbids
/// implementations from emitting other codes in that range; see ADR 0002 for
/// the pending decision. Changing them here changes them everywhere.
pub mod code {
    /// The call needs a human's approval.
    pub const STEP_UP: i64 = -32050;
    /// The call is refused.
    pub const DENY: i64 = -32051;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_order() {
        assert_eq!(Decision::Allow.max(Decision::StepUp), Decision::StepUp);
        assert_eq!(Decision::StepUp.max(Decision::Deny), Decision::Deny);
        assert_eq!(Decision::Deny.max(Decision::Allow), Decision::Deny);
        assert!(Decision::Allow < Decision::StepUp && Decision::StepUp < Decision::Deny);
    }

    #[test]
    fn serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&Decision::StepUp).unwrap(),
            "\"step_up\""
        );
    }
}
