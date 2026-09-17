//! A hand-written, dependency-free MCP server for tests.
//!
//! Speaks the `2025-11-25` handshake era over stdio and exposes two tools:
//! `echo` (returns its arguments as text) and `pay` (returns a fake receipt).
//! It exists so the framing and the gateway can be tested against a real
//! subprocess without pulling in an SDK. It never contacts the network.
//!
//! Set `FAKE_MCP_PRETTY=1` to make it emit responses with extra spaces, which
//! the passthrough tests use to prove the gateway forwards bytes unchanged.

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let pretty = std::env::var_os("FAKE_MCP_PRETTY").is_some();
    let mut out = stdout.lock();
    let mut calls = 0u32;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                emit(&mut out, &error(Value::Null, -32700, "parse error"), pretty);
                continue;
            }
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let id = msg.get("id").cloned();

        // Notifications get no answer.
        let Some(id) = id.filter(|v| !v.is_null()) else {
            if method == "notifications/initialized" {
                eprintln!("fake-mcp-server: initialized");
            }
            continue;
        };

        let reply = match method {
            "initialize" => {
                let requested = msg
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-11-25");
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": requested,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": "moat-fake-mcp-server", "version": "0.1.0"},
                        "instructions": "Test fixture. Two tools: echo and pay."
                    }
                })
            }
            "ping" => json!({"jsonrpc": "2.0", "id": id, "result": {}}),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {
                            "name": "echo",
                            "description": "Echo the arguments back as text.",
                            "inputSchema": {"type": "object"}
                        },
                        {
                            "name": "pay",
                            "description": "Pay a payee. Fake: records nothing, moves nothing.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "payee": {"type": "string"},
                                    "amount": {"type": "number"},
                                    "currency": {"type": "string"},
                                    "authorization_id": {"type": "string"},
                                    "invoice_id": {"type": "string"}
                                },
                                "required": ["payee", "amount"]
                            }
                        }
                    ]
                }
            }),
            "tools/call" => {
                calls += 1;
                let name = msg
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let args = msg
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match name {
                    "echo" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{"type": "text", "text": args.to_string()}],
                            "isError": false
                        }
                    }),
                    "pay" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{"type": "text", "text": format!(
                                "receipt fake_{calls}: paid {} {} to {}",
                                args.get("amount").cloned().unwrap_or(Value::Null),
                                args.get("currency").and_then(Value::as_str).unwrap_or("USD"),
                                args.get("payee").and_then(Value::as_str).unwrap_or("?")
                            )}],
                            "structuredContent": {
                                "receipt": format!("fake_{calls}"),
                                "status": "succeeded",
                                "authorization_id": args.get("authorization_id"),
                                "invoice_id": args.get("invoice_id"),
                                "call": calls
                            },
                            "isError": false
                        }
                    }),
                    other => error(id, -32602, &format!("Unknown tool: {other}")),
                }
            }
            other => error(id, -32601, &format!("Method not found: {other}")),
        };
        emit(&mut out, &reply, pretty);
    }
    eprintln!("fake-mcp-server: stdin closed, exiting");
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn emit(out: &mut impl Write, v: &Value, pretty: bool) {
    // Pretty mode adds spaces after separators but stays on one line, so the
    // bytes differ from serde's compact form without breaking the framing.
    let s = if pretty {
        v.to_string().replace("\":", "\": ").replace(",\"", ", \"")
    } else {
        v.to_string()
    };
    let _ = writeln!(out, "{s}");
    let _ = out.flush();
}
