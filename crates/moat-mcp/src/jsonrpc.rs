//! JSON-RPC 2.0 message model as constrained by MCP.
//!
//! MCP tightens JSON-RPC in a few ways that this module enforces: request ids
//! are strings or integers and never `null`, batches are not used, and every
//! message is one of exactly four shapes. Anything else is [`Error::Malformed`].
//!
//! The framing layer keeps the raw line beside every parsed message (see
//! [`crate::stdio::Frame`]) so a proxy can forward it byte-for-byte when it
//! has no reason to touch it.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// The JSON-RPC version string every message carries.
pub const JSONRPC_VERSION: &str = "2.0";

/// A request identifier. MCP forbids `null` and fractional ids.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    /// An integer id.
    Number(i64),
    /// A string id.
    String(String),
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "{n}"),
            RequestId::String(s) => write!(f, "{s}"),
        }
    }
}

impl From<i64> for RequestId {
    fn from(n: i64) -> Self {
        RequestId::Number(n)
    }
}

impl From<&str> for RequestId {
    fn from(s: &str) -> Self {
        RequestId::String(s.to_owned())
    }
}

impl From<String> for RequestId {
    fn from(s: String) -> Self {
        RequestId::String(s)
    }
}

/// A request: carries an id and expects exactly one response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// Always `"2.0"`.
    pub jsonrpc: String,
    /// Correlates the eventual response.
    pub id: RequestId,
    /// The method name, e.g. `tools/call`.
    pub method: String,
    /// Method parameters, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl Request {
    /// Build a request.
    pub fn new(id: impl Into<RequestId>, method: impl Into<String>, params: Option<Value>) -> Self {
        Request {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }

    /// The params as an object, or an empty map if absent or not an object.
    pub fn params_object(&self) -> Map<String, Value> {
        match &self.params {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        }
    }
}

/// A notification: no id, never answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    /// Always `"2.0"`.
    pub jsonrpc: String,
    /// The method name, e.g. `notifications/initialized`.
    pub method: String,
    /// Parameters, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl Notification {
    /// Build a notification.
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self {
        Notification {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            method: method.into(),
            params,
        }
    }
}

/// A successful response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    /// Always `"2.0"`.
    pub jsonrpc: String,
    /// The id of the request being answered.
    pub id: RequestId,
    /// The result. MCP results are objects; we keep [`Value`] so nothing is
    /// lost on forwarding.
    pub result: Value,
}

impl Response {
    /// Build a success response.
    pub fn new(id: impl Into<RequestId>, result: Value) -> Self {
        Response {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id: id.into(),
            result,
        }
    }
}

/// The `error` member of an error response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorObject {
    /// Integer error code.
    pub code: i64,
    /// Short description.
    pub message: String,
    /// Optional structured detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ErrorObject {
    /// Build an error object.
    pub fn new(code: i64, message: impl Into<String>, data: Option<Value>) -> Self {
        ErrorObject {
            code,
            message: message.into(),
            data,
        }
    }
}

/// An error response. The id is optional only for the case where the request
/// was so malformed its id could not be read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// Always `"2.0"`.
    pub jsonrpc: String,
    /// The id of the request being answered, when it could be read.
    #[serde(default)]
    pub id: Option<RequestId>,
    /// The error.
    pub error: ErrorObject,
}

impl ErrorResponse {
    /// Build an error response.
    pub fn new(id: Option<RequestId>, error: ErrorObject) -> Self {
        ErrorResponse {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            error,
        }
    }
}

/// Standard JSON-RPC 2.0 and MCP-defined error codes.
pub mod code {
    /// Invalid JSON was received.
    pub const PARSE_ERROR: i64 = -32700;
    /// The JSON sent is not a valid request object.
    pub const INVALID_REQUEST: i64 = -32600;
    /// The method does not exist.
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// Invalid method parameters.
    pub const INVALID_PARAMS: i64 = -32602;
    /// Internal JSON-RPC error.
    pub const INTERNAL_ERROR: i64 = -32603;
    /// MCP 2026-07-28: mirrored HTTP headers do not match the body.
    pub const MCP_HEADER_MISMATCH: i64 = -32020;
    /// MCP 2026-07-28: the client lacks a capability the request needs.
    pub const MCP_MISSING_CLIENT_CAPABILITY: i64 = -32021;
    /// MCP 2026-07-28: the server does not speak the requested version.
    pub const MCP_UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;
}

/// One parsed message plus the exact line it arrived on.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    /// A request.
    Request(Request),
    /// A notification.
    Notification(Notification),
    /// A success response.
    Response(Response),
    /// An error response.
    Error(ErrorResponse),
}

impl Message {
    /// Classify and parse one line of JSON.
    ///
    /// The shape is decided by which members are present: `method` with an
    /// `id` is a request, `method` without one is a notification, `result` is
    /// a response and `error` is an error response. A batch (JSON array) is
    /// rejected because MCP removed batching.
    pub fn parse(line: &str) -> Result<Message> {
        let value: Value = serde_json::from_str(line).map_err(|e| Error::json(e, line))?;
        Message::from_value(value)
    }

    /// Classify an already-parsed JSON value.
    pub fn from_value(value: Value) -> Result<Message> {
        let obj = match value {
            Value::Object(o) => o,
            Value::Array(_) => {
                return Err(Error::Malformed(
                    "JSON-RPC batches are not part of MCP".to_owned(),
                ))
            }
            other => {
                return Err(Error::Malformed(format!(
                    "expected an object, got {}",
                    kind(&other)
                )))
            }
        };

        match obj.get("jsonrpc") {
            Some(Value::String(v)) if v == JSONRPC_VERSION => {}
            _ => {
                return Err(Error::Malformed(
                    "missing or wrong \"jsonrpc\" member".to_owned(),
                ))
            }
        }

        let has_method = obj.contains_key("method");
        let has_id = obj.get("id").is_some_and(|v| !v.is_null());
        let value = Value::Object(obj.clone());

        let parsed = if has_method && has_id {
            serde_json::from_value(value).map(Message::Request)
        } else if has_method {
            if obj.contains_key("id") {
                return Err(Error::Malformed("request id must not be null".to_owned()));
            }
            serde_json::from_value(value).map(Message::Notification)
        } else if obj.contains_key("result") {
            if !has_id {
                return Err(Error::Malformed("response is missing its id".to_owned()));
            }
            serde_json::from_value(value).map(Message::Response)
        } else if obj.contains_key("error") {
            serde_json::from_value(value).map(Message::Error)
        } else {
            return Err(Error::Malformed(
                "no method, result or error member".to_owned(),
            ));
        };

        parsed.map_err(|e| Error::Malformed(e.to_string()))
    }

    /// Serialize to a single compact line without a trailing newline.
    pub fn to_line(&self) -> Result<String> {
        let s = match self {
            Message::Request(m) => serde_json::to_string(m),
            Message::Notification(m) => serde_json::to_string(m),
            Message::Response(m) => serde_json::to_string(m),
            Message::Error(m) => serde_json::to_string(m),
        }
        .map_err(|e| Error::Malformed(e.to_string()))?;
        if s.contains('\n') {
            return Err(Error::EmbeddedNewline);
        }
        Ok(s)
    }

    /// The method name, for requests and notifications.
    pub fn method(&self) -> Option<&str> {
        match self {
            Message::Request(r) => Some(&r.method),
            Message::Notification(n) => Some(&n.method),
            _ => None,
        }
    }

    /// The id, for anything that has one.
    pub fn id(&self) -> Option<&RequestId> {
        match self {
            Message::Request(r) => Some(&r.id),
            Message::Response(r) => Some(&r.id),
            Message::Error(e) => e.id.as_ref(),
            Message::Notification(_) => None,
        }
    }
}

impl From<Request> for Message {
    fn from(m: Request) -> Self {
        Message::Request(m)
    }
}
impl From<Notification> for Message {
    fn from(m: Notification) -> Self {
        Message::Notification(m)
    }
}
impl From<Response> for Message {
    fn from(m: Response) -> Self {
        Message::Response(m)
    }
}
impl From<ErrorResponse> for Message {
    fn from(m: ErrorResponse) -> Self {
        Message::Error(m)
    }
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_all_four_shapes() {
        type Check = fn(&Message) -> bool;
        let cases: Vec<(&str, Check)> = vec![
            (r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, |m| {
                matches!(m, Message::Request(_))
            }),
            (
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                |m| matches!(m, Message::Notification(_)),
            ),
            (r#"{"jsonrpc":"2.0","id":"a","result":{}}"#, |m| {
                matches!(m, Message::Response(_))
            }),
            (
                r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"x"}}"#,
                |m| matches!(m, Message::Error(_)),
            ),
        ];
        for (line, check) in cases {
            let m = Message::parse(line).unwrap();
            assert!(check(&m), "misclassified {line}");
        }
    }

    #[test]
    fn rejects_non_mcp_shapes() {
        let bad = [
            r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#,
            r#"{"id":1,"method":"ping"}"#,
            r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0","result":{}}"#,
            "not json",
            "42",
        ];
        for line in bad {
            assert!(Message::parse(line).is_err(), "accepted {line}");
        }
    }

    #[test]
    fn ids_round_trip_exactly() {
        for (line, id) in [
            (
                r#"{"jsonrpc":"2.0","id":7,"method":"m"}"#,
                RequestId::Number(7),
            ),
            (
                r#"{"jsonrpc":"2.0","id":-3,"method":"m"}"#,
                RequestId::Number(-3),
            ),
            (
                r#"{"jsonrpc":"2.0","id":"req-9","method":"m"}"#,
                RequestId::from("req-9"),
            ),
        ] {
            let m = Message::parse(line).unwrap();
            assert_eq!(m.id(), Some(&id));
            assert_eq!(m.to_line().unwrap(), line);
        }
    }

    #[test]
    fn serializes_compactly_without_absent_params() {
        let r = Request::new(1, "tools/list", None);
        assert_eq!(
            Message::from(r).to_line().unwrap(),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
        );
        let r = Request::new("x", "tools/call", Some(json!({"name": "pay"})));
        assert_eq!(
            Message::from(r).to_line().unwrap(),
            r#"{"jsonrpc":"2.0","id":"x","method":"tools/call","params":{"name":"pay"}}"#
        );
    }

    #[test]
    fn strings_with_newlines_are_escaped_not_embedded() {
        let r = Response::new(1, json!({"text": "a\nb"}));
        let line = Message::from(r).to_line().unwrap();
        assert!(!line.contains('\n'));
        assert!(line.contains("\\n"));
    }
}
