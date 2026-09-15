//! Newline-delimited framing for the stdio transport.
//!
//! Per the MCP stdio binding (revision 2026-07-28, unchanged in substance from
//! 2025-11-25): one JSON-RPC message per line, UTF-8, no embedded newlines,
//! nothing on stdout that is not a message. The same framing is specified for
//! any reliable byte stream, so these types are generic over the stream.

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{Error, Result};
use crate::jsonrpc::Message;

/// Default cap on a single frame. Tool results can be large; 32 MiB is well
/// above anything a sane server emits and well below what would hurt.
pub const DEFAULT_MAX_FRAME: usize = 32 * 1024 * 1024;

/// A raw line received from the peer, together with its parsed form.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// The exact bytes received, without the trailing newline.
    pub raw: String,
    /// The parsed message.
    pub message: Message,
}

/// Reads frames from a buffered async stream.
pub struct FrameReader<R> {
    inner: R,
    max_frame: usize,
    buf: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> FrameReader<R> {
    /// Wrap a buffered reader with the default frame cap.
    pub fn new(inner: R) -> Self {
        Self::with_max_frame(inner, DEFAULT_MAX_FRAME)
    }

    /// Wrap a buffered reader with an explicit frame cap.
    pub fn with_max_frame(inner: R, max_frame: usize) -> Self {
        FrameReader {
            inner,
            max_frame,
            buf: Vec::new(),
        }
    }

    /// Read the next raw line. Returns `Ok(None)` at end of stream.
    ///
    /// Empty lines are skipped: they are not messages, and tolerating them
    /// costs nothing. A trailing `\r` is stripped so CRLF peers work.
    pub async fn next_line(&mut self) -> Result<Option<String>> {
        loop {
            self.buf.clear();
            let n = read_until_limited(&mut self.inner, &mut self.buf, self.max_frame).await?;
            if n == 0 {
                return Ok(None);
            }
            if self.buf.last() == Some(&b'\n') {
                self.buf.pop();
            }
            if self.buf.last() == Some(&b'\r') {
                self.buf.pop();
            }
            if self.buf.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            let line = String::from_utf8(std::mem::take(&mut self.buf))
                .map_err(|e| Error::Malformed(format!("frame is not UTF-8: {e}")))?;
            return Ok(Some(line));
        }
    }

    /// Read and parse the next frame. Returns `Ok(None)` at end of stream.
    ///
    /// A line that is not a valid message is returned as an error, but the
    /// reader stays usable: the caller decides whether to answer with a
    /// parse error or drop the line.
    pub async fn next_frame(&mut self) -> Result<Option<Frame>> {
        match self.next_line().await? {
            None => Ok(None),
            Some(raw) => {
                let message = Message::parse(&raw)?;
                Ok(Some(Frame { raw, message }))
            }
        }
    }

    /// Give back the underlying reader.
    pub fn into_inner(self) -> R {
        self.inner
    }
}

/// `read_until(b'\n')` that stops and errors once `max` bytes are buffered,
/// instead of growing without bound on a peer that never sends a newline.
async fn read_until_limited<R: AsyncBufRead + Unpin>(
    r: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> Result<usize> {
    let mut total = 0usize;
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            return Ok(total);
        }
        let (chunk, done) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (&available[..=i], true),
            None => (available, false),
        };
        if total + chunk.len() > max {
            return Err(Error::FrameTooLarge { max });
        }
        buf.extend_from_slice(chunk);
        let used = chunk.len();
        total += used;
        r.consume(used);
        if done {
            return Ok(total);
        }
    }
}

/// Writes frames to an async stream, one message per line.
pub struct FrameWriter<W> {
    inner: W,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    /// Wrap a writer.
    pub fn new(inner: W) -> Self {
        FrameWriter { inner }
    }

    /// Write a raw line exactly as given, plus the newline.
    ///
    /// Refuses lines with embedded newlines: the framing would split them into
    /// two garbage messages.
    pub async fn write_raw(&mut self, line: &str) -> Result<()> {
        if line.contains('\n') {
            return Err(Error::EmbeddedNewline);
        }
        self.inner.write_all(line.as_bytes()).await?;
        self.inner.write_all(b"\n").await?;
        self.inner.flush().await?;
        Ok(())
    }

    /// Serialize and write a message.
    pub async fn write_message(&mut self, message: &Message) -> Result<()> {
        let line = message.to_line()?;
        self.write_raw(&line).await
    }

    /// Flush and close the writer, signalling end of stream to the peer.
    pub async fn shutdown(&mut self) -> Result<()> {
        self.inner.shutdown().await?;
        Ok(())
    }

    /// Give back the underlying writer.
    pub fn into_inner(self) -> W {
        self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::{Request, RequestId};
    use tokio::io::BufReader;

    #[tokio::test]
    async fn reads_lines_skipping_blanks_and_crlf() {
        let input = "\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\r\n   \n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}";
        let mut r = FrameReader::new(BufReader::new(input.as_bytes()));
        let a = r.next_frame().await.unwrap().unwrap();
        assert_eq!(a.raw, r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        let b = r.next_frame().await.unwrap().unwrap();
        assert_eq!(b.message.id(), Some(&RequestId::Number(2)));
        assert!(r.next_frame().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn bad_line_is_an_error_but_reader_continues() {
        let input = "garbage\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n";
        let mut r = FrameReader::new(BufReader::new(input.as_bytes()));
        assert!(matches!(r.next_frame().await, Err(Error::Json { .. })));
        assert!(r.next_frame().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn oversize_frame_is_rejected() {
        let long = format!("{}\n", "x".repeat(100));
        let mut r = FrameReader::with_max_frame(BufReader::new(long.as_bytes()), 50);
        assert!(matches!(
            r.next_line().await,
            Err(Error::FrameTooLarge { max: 50 })
        ));
    }

    #[tokio::test]
    async fn writer_frames_and_refuses_embedded_newlines() {
        let mut out = Vec::new();
        {
            let mut w = FrameWriter::new(&mut out);
            w.write_message(&Request::new(1, "ping", None).into())
                .await
                .unwrap();
            assert!(matches!(
                w.write_raw("a\nb").await,
                Err(Error::EmbeddedNewline)
            ));
        }
        assert_eq!(out, b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n");
    }
}
