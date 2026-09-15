//! Where a value came from.

use serde::{Deserialize, Serialize};

/// The origin of a value that entered a session. Every value has exactly one.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Text the human typed, registered through the intent API.
    User {
        /// Which intent registration, counting from 1 per session.
        turn: u32,
    },
    /// A value from the policy allowlist.
    Allowlist {
        /// The allowlist entry it matched.
        name: String,
    },
    /// A value extracted from a tool result.
    ToolResult {
        /// Upstream that produced it.
        server: String,
        /// Tool that produced it.
        tool: String,
        /// The JSON-RPC id of the call, as a string.
        call_id: String,
    },
    /// System prompt or configuration. Trusted.
    System,
    /// Could not be attributed to anything.
    Unknown,
}

impl Source {
    /// Trust order for policy purposes: `System`, `User` and `Allowlist` are
    /// trusted; `ToolResult` and `Unknown` are not.
    pub fn is_trusted(&self) -> bool {
        matches!(
            self,
            Source::System | Source::User { .. } | Source::Allowlist { .. }
        )
    }

    /// The bare kind name as it appears in policy files: `User`, `Allowlist`,
    /// `ToolResult`, `System`, `Unknown`.
    pub fn kind(&self) -> SourceKind {
        match self {
            Source::User { .. } => SourceKind::User,
            Source::Allowlist { .. } => SourceKind::Allowlist,
            Source::ToolResult { .. } => SourceKind::ToolResult,
            Source::System => SourceKind::System,
            Source::Unknown => SourceKind::Unknown,
        }
    }
}

/// A [`Source`] without its payload, for policy rules like
/// `require_source: [User, Allowlist]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceKind {
    /// See [`Source::User`].
    User,
    /// See [`Source::Allowlist`].
    Allowlist,
    /// See [`Source::ToolResult`].
    ToolResult,
    /// See [`Source::System`].
    System,
    /// See [`Source::Unknown`].
    Unknown,
}

impl std::fmt::Display for SourceKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            SourceKind::User => "User",
            SourceKind::Allowlist => "Allowlist",
            SourceKind::ToolResult => "ToolResult",
            SourceKind::System => "System",
            SourceKind::Unknown => "Unknown",
        };
        f.write_str(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_order() {
        assert!(Source::System.is_trusted());
        assert!(Source::User { turn: 1 }.is_trusted());
        assert!(Source::Allowlist { name: "x".into() }.is_trusted());
        assert!(!Source::ToolResult {
            server: "s".into(),
            tool: "t".into(),
            call_id: "1".into()
        }
        .is_trusted());
        assert!(!Source::Unknown.is_trusted());
    }

    #[test]
    fn serializes_with_a_kind_tag() {
        let v = serde_json::to_value(Source::User { turn: 2 }).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "user", "turn": 2}));
        let v = serde_json::to_value(Source::Unknown).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "unknown"}));
    }
}
