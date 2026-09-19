//! Shared helpers for gateway integration tests.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use moat_mcp::stdio::{FrameReader, FrameWriter};
use moat_mcp::{Message, Request};
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// Build (once) and locate the fake MCP server that lives in `moat-mcp`.
///
/// `CARGO_BIN_EXE_*` only covers this package's own binaries, so we ask cargo
/// to build the fixture and read the executable path from its JSON output.
pub fn fake_server_path() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
        let out = std::process::Command::new(cargo)
            .args([
                "build",
                "-p",
                "moat-mcp",
                "--bin",
                "moat-fake-mcp-server",
                "--message-format=json",
            ])
            .stderr(Stdio::inherit())
            .output()
            .expect("cargo build of the fake server");
        assert!(out.status.success(), "building moat-fake-mcp-server failed");
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|v| v["reason"] == "compiler-artifact")
            .filter_map(|v| v["executable"].as_str().map(PathBuf::from))
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("moat-fake-mcp-server"))
            })
            .expect("fake server executable path in cargo output")
    })
    .clone()
}

/// A spawned process we talk MCP to over its stdio.
pub struct Peer {
    pub child: Child,
    pub reader: FrameReader<BufReader<ChildStdout>>,
    pub writer: FrameWriter<ChildStdin>,
}

impl Peer {
    pub fn spawn(program: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Peer {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Peer {
            child,
            reader: FrameReader::new(BufReader::new(stdout)),
            writer: FrameWriter::new(stdin),
        }
    }

    /// Send a request and return the raw reply line plus its parsed form.
    pub async fn call(&mut self, req: Request) -> (String, Message) {
        let id = req.id.clone();
        self.writer.write_message(&req.into()).await.expect("write");
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(10), self.reader.next_frame())
                .await
                .expect("timed out waiting for reply")
                .expect("read")
                .expect("stream ended");
            // Skip unsolicited notifications.
            if frame.message.id() == Some(&id) {
                return (frame.raw, frame.message);
            }
        }
    }

    pub async fn notify(&mut self, n: moat_mcp::Notification) {
        self.writer.write_message(&n.into()).await.expect("write");
    }

    pub async fn close_and_wait(mut self) -> std::process::ExitStatus {
        self.writer.shutdown().await.expect("close stdin");
        drop(self.writer);
        tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .expect("process did not exit")
            .expect("wait")
    }
}

/// Write a gateway config into a fresh temp dir and return its path.
pub fn write_config(name: &str, body: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("moat-test-{}-{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("moat.yaml");
    std::fs::write(&path, body).unwrap();
    path
}

/// Render a path as a YAML single-quoted scalar, for interpolation into a
/// config body.
///
/// Windows paths contain backslashes and YAML treats `\` as an escape inside
/// *double* quotes, so `"C:\Users\..."` fails to parse with "found unknown
/// escape character". Single-quoted scalars take every character literally;
/// the only escape is `''` for a literal quote.
pub fn yaml_path(path: &std::path::Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}

pub fn gateway_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_moat-gateway"))
}

/// A minimal HTTP/1.1 client for the intent API, so the tests need no
/// client crate. Returns the status code and the JSON body.
pub mod http {
    use serde_json::Value;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn exchange(addr: &str, request: String) -> (u16, Value) {
        let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
        stream.write_all(request.as_bytes()).await.expect("send");
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.expect("recv");
        let text = String::from_utf8_lossy(&buf);
        let (head, body) = text.split_once("\r\n\r\n").expect("http response");
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("status");
        let body = if body.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(body.trim()).unwrap_or_else(|_| Value::String(body.to_owned()))
        };
        (status, body)
    }

    pub async fn post(addr: &str, path: &str, body: &Value) -> (u16, Value) {
        let payload = body.to_string();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        exchange(addr, req).await
    }

    pub async fn get(addr: &str, path: &str) -> (u16, Value) {
        let req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
        exchange(addr, req).await
    }
}
