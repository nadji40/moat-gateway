//! Error type for transport and parsing failures.

/// Failures that the MCP layer can report.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The underlying stream failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// A line was received that is not valid JSON.
    #[error("invalid JSON on the wire: {source} (line starts {preview:?})")]
    Json {
        /// The serde error.
        #[source]
        source: serde_json::Error,
        /// The first few characters of the offending line, for diagnostics.
        preview: String,
    },

    /// Valid JSON that is not a JSON-RPC 2.0 message MCP recognises.
    #[error("malformed JSON-RPC message: {0}")]
    Malformed(String),

    /// A single line exceeded the configured maximum frame size.
    #[error("frame exceeds the maximum of {max} bytes")]
    FrameTooLarge {
        /// The configured cap.
        max: usize,
    },

    /// An outgoing message contained an embedded newline, which the stdio
    /// framing forbids.
    #[error("message contains an embedded newline and cannot be framed")]
    EmbeddedNewline,

    /// The peer closed its side of the stream.
    #[error("transport closed by peer")]
    Closed,

    /// A child process could not be started or stopped.
    #[error("process error: {0}")]
    Process(String),
}

impl Error {
    pub(crate) fn json(source: serde_json::Error, line: &str) -> Self {
        let preview: String = line.chars().take(40).collect();
        Error::Json { source, preview }
    }
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;
