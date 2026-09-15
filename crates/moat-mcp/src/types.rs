//! Typed views of the MCP methods a proxy has to understand.
//!
//! These are deliberately lossy-free: every struct carries a flattened `extra`
//! map so fields this crate does not model survive a parse/serialize cycle.
//! That is what lets the gateway rewrite one field (a tool name) and forward
//! the rest of a message untouched.
//!
//! Two protocol eras are in play (see ADR 0002). Revision `2025-11-25` and
//! earlier open with an `initialize` handshake; revision `2026-07-28` and
//! later carry version and capabilities on every request in `_meta` and
//! answer `server/discover` instead. This module models both shapes.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The latest handshake-era ("legacy") protocol revision.
pub const PROTOCOL_VERSION_2025_11_25: &str = "2025-11-25";
/// The first per-request-metadata ("modern") protocol revision.
pub const PROTOCOL_VERSION_2026_07_28: &str = "2026-07-28";

/// Method names this crate recognises. Anything else is forwarded blind.
pub mod method {
    /// Legacy handshake request.
    pub const INITIALIZE: &str = "initialize";
    /// Legacy handshake completion notification.
    pub const INITIALIZED: &str = "notifications/initialized";
    /// Modern discovery request; servers must implement it.
    pub const SERVER_DISCOVER: &str = "server/discover";
    /// Liveness check, allowed before initialization.
    pub const PING: &str = "ping";
    /// List tools.
    pub const TOOLS_LIST: &str = "tools/list";
    /// Invoke a tool.
    pub const TOOLS_CALL: &str = "tools/call";
    /// Server tells the client the tool list changed.
    pub const TOOLS_LIST_CHANGED: &str = "notifications/tools/list_changed";
    /// Client abandons an in-flight request.
    pub const CANCELLED: &str = "notifications/cancelled";
    /// Progress on an in-flight request.
    pub const PROGRESS: &str = "notifications/progress";
}

/// `_meta` keys reserved by MCP that a proxy must not disturb.
pub mod meta {
    /// Per-request protocol version (modern era).
    pub const PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
    /// Per-request client identity (modern era).
    pub const CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
    /// Per-request client capabilities (modern era).
    pub const CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
    /// Server identity on results (modern era).
    pub const SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";
    /// Progress token on requests.
    pub const PROGRESS_TOKEN: &str = "progressToken";
}

/// Name and version of a client or server implementation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Implementation {
    /// Machine name.
    pub name: String,
    /// Version string.
    pub version: String,
    /// Display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Anything else (`description`, `icons`, `websiteUrl`, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Implementation {
    /// Build an implementation descriptor.
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Implementation {
            name: name.into(),
            version: version.into(),
            title: None,
            extra: Map::new(),
        }
    }
}

/// Params of a legacy `initialize` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// Version the client wants to speak.
    pub protocol_version: String,
    /// Client capabilities, kept opaque.
    #[serde(default)]
    pub capabilities: Value,
    /// Client identity.
    pub client_info: Implementation,
    /// Anything else.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Result of a legacy `initialize` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    /// Version the server chose.
    pub protocol_version: String,
    /// Server capabilities, kept opaque.
    #[serde(default)]
    pub capabilities: Value,
    /// Server identity.
    pub server_info: Implementation,
    /// Guidance for the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Anything else.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Result of a modern `server/discover` request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResult {
    /// Always `"complete"` in the core protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_type: Option<String>,
    /// Versions the server speaks.
    pub supported_versions: Vec<String>,
    /// Server capabilities, kept opaque.
    #[serde(default)]
    pub capabilities: Value,
    /// Guidance for the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Anything else, including `_meta` with the server info.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One tool definition as returned by `tools/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    /// Unique (per server) name.
    pub name: String,
    /// Display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// What the tool does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Schema for the arguments. Kept opaque.
    pub input_schema: Value,
    /// Anything else (`outputSchema`, `annotations`, `icons`, `_meta`, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Result of `tools/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListToolsResult {
    /// The tools.
    pub tools: Vec<Tool>,
    /// Pagination cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Anything else (`resultType`, `ttlMs`, `_meta`, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Params of `tools/call`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallToolParams {
    /// Which tool.
    pub name: String,
    /// The arguments, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Map<String, Value>>,
    /// Anything else (`_meta`, `inputResponses`, `requestState`, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Result of `tools/call`.
///
/// `content` is kept as raw values: the core extracts leaves from whatever is
/// there, and the gateway never rewrites it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallToolResult {
    /// Unstructured content blocks.
    #[serde(default)]
    pub content: Vec<Value>,
    /// Structured content, if the tool has an output schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    /// True when the tool itself failed (as opposed to a protocol error).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Anything else (`resultType`, `_meta`, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_list_round_trip_keeps_unknown_fields() {
        let input = json!({
            "resultType": "complete",
            "tools": [{
                "name": "pay",
                "inputSchema": {"type": "object"},
                "annotations": {"destructiveHint": true},
                "icons": [{"src": "https://x/y.png"}]
            }],
            "nextCursor": "c2",
            "ttlMs": 300000
        });
        let parsed: ListToolsResult = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(parsed.tools[0].name, "pay");
        assert_eq!(parsed.next_cursor.as_deref(), Some("c2"));
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back, input);
    }

    #[test]
    fn call_params_keep_meta() {
        let input = json!({
            "name": "pay",
            "arguments": {"payee": "X", "amount": 480},
            "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}
        });
        let parsed: CallToolParams = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), input);
    }

    #[test]
    fn initialize_result_round_trip() {
        let input = json!({
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {"listChanged": true}},
            "serverInfo": {"name": "s", "version": "1", "websiteUrl": "https://s"},
            "instructions": "hi"
        });
        let parsed: InitializeResult = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), input);
    }
}
