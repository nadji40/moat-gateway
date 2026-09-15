//! Provenance tracking, policy evaluation and evidence for Moat.
//!
//! This crate is deliberately free of MCP and gateway concerns so that the
//! future TypeScript and Python bindings can wrap it directly. It answers one
//! question: *given the values an agent is about to spend money with, where did
//! each of those values come from, and does policy allow it?*
//!
//! - [`source`]: the [`Source`] label every value carries.
//! - [`normalize`]: the canonical forms values are compared in.
//! - [`extract`]: pulling leaves out of a tool result.
//! - [`session`]: per-session intents, observed values and the event log.
//! - [`provenance`]: resolving where a payment argument came from.
//! - [`hash`]: canonical JSON and SHA-256.

#![forbid(unsafe_code)]

pub mod extract;
pub mod hash;
pub mod normalize;
pub mod provenance;
pub mod session;
pub mod source;

pub use provenance::{resolve, MatchKind, Resolution};
pub use session::{Session, SessionStore};
pub use source::{Source, SourceKind};

/// The version of this crate, for evidence records and handshakes.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
