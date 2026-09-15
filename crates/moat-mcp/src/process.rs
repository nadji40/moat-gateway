//! Launching an MCP server as a child process and talking to it over stdio.
//!
//! Lifecycle follows the stdio binding: the client owns the process, sends on
//! its stdin, reads its stdout, may read its stderr as log output, and shuts
//! down by closing stdin, waiting, then escalating to a kill.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::error::{Error, Result};
use crate::stdio::{FrameReader, FrameWriter};

/// How long [`ChildTransport::shutdown`] waits after closing stdin before
/// killing the process.
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// A running MCP server subprocess with framed access to its streams.
pub struct ChildTransport {
    child: Child,
    reader: Option<FrameReader<BufReader<ChildStdout>>>,
    writer: Option<FrameWriter<ChildStdin>>,
}

impl ChildTransport {
    /// Spawn `command[0]` with `command[1..]` as arguments.
    ///
    /// stderr is captured and forwarded line by line to `tracing` at debug
    /// level under the given `label`, because the spec says a client should
    /// not assume stderr output means an error.
    pub fn spawn(command: &[String], label: &str) -> Result<Self> {
        let (program, args) = command
            .split_first()
            .ok_or_else(|| Error::Process("empty command".to_owned()))?;

        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| Error::Process(format!("spawning {program}: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Process("child stdin not piped".to_owned()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Process("child stdout not piped".to_owned()))?;
        if let Some(stderr) = child.stderr.take() {
            let label = label.to_owned();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(upstream = %label, "{line}");
                }
            });
        }

        Ok(ChildTransport {
            child,
            reader: Some(FrameReader::new(BufReader::new(stdout))),
            writer: Some(FrameWriter::new(stdin)),
        })
    }

    /// Split into independently owned read and write halves.
    ///
    /// After this, the returned [`ChildTransport`] only manages the process.
    pub fn split(
        &mut self,
    ) -> Option<(FrameReader<BufReader<ChildStdout>>, FrameWriter<ChildStdin>)> {
        Some((self.reader.take()?, self.writer.take()?))
    }

    /// Mutable access to the read half, if not split off.
    pub fn reader(&mut self) -> Option<&mut FrameReader<BufReader<ChildStdout>>> {
        self.reader.as_mut()
    }

    /// Mutable access to the write half, if not split off.
    pub fn writer(&mut self) -> Option<&mut FrameWriter<ChildStdin>> {
        self.writer.as_mut()
    }

    /// The OS process id, if the process is still running.
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Graceful shutdown: close stdin, wait up to `grace`, then kill.
    ///
    /// If the write half was split off, the caller must drop it (closing
    /// stdin) before calling this, or the wait will run to the grace period.
    pub async fn shutdown(mut self, grace: Duration) -> Result<std::process::ExitStatus> {
        if let Some(mut w) = self.writer.take() {
            // Errors here mean the child already closed its end; that is fine.
            let _ = w.shutdown().await;
            drop(w);
        }
        self.reader.take();
        match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(status) => status.map_err(Error::Io),
            Err(_) => {
                tracing::warn!(pid = ?self.child.id(), "upstream did not exit after stdin close; killing");
                self.child
                    .kill()
                    .await
                    .map_err(|e| Error::Process(format!("kill: {e}")))?;
                self.child.wait().await.map_err(Error::Io)
            }
        }
    }
}
