//! Model Context Protocol types and transport framing.
//!
//! This crate knows how to speak MCP and nothing else: JSON-RPC message
//! shapes, the typed views of the handful of methods a proxy must understand,
//! newline framing for stdio, and child-process management for stdio
//! upstreams. It holds no policy logic, so the gateway can forward anything it
//! does not understand without consulting it.
//!
//! Written against the MCP specification revision `2026-07-28` with
//! compatibility for the `2025-11-25` handshake era; see ADR 0002 for what
//! that means and why both are needed.

#![forbid(unsafe_code)]

pub mod error;
pub mod jsonrpc;
pub mod process;
pub mod stdio;
pub mod types;

pub use error::{Error, Result};
pub use jsonrpc::{
    ErrorObject, ErrorResponse, Message, Notification, Request, RequestId, Response,
};
pub use stdio::{Frame, FrameReader, FrameWriter};

/// The version of this crate, for evidence records and handshakes.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
