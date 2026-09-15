//! Provenance tracking, policy evaluation and evidence for Moat.
//!
//! This crate is deliberately free of MCP and gateway concerns so that the
//! future TypeScript and Python bindings can wrap it directly. It answers one
//! question: *given the values an agent is about to spend money with, where did
//! each of those values come from, and does policy allow it?*
//!
//! Nothing here is wired up yet — see the work order in the README.

/// The version of this crate, for evidence records and handshakes.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
