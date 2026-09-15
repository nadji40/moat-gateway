//! Model Context Protocol types and transport framing.
//!
//! This crate knows how to speak MCP and nothing else: JSON-RPC message types,
//! stdio newline framing and HTTP+SSE framing. It holds no policy logic, so the
//! gateway can forward anything it does not understand without consulting it.
//!
//! Nothing here is wired up yet — see the work order in the README.

/// The version of this crate, for evidence records and handshakes.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
