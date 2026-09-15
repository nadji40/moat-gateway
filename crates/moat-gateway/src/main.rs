//! The `moat-gateway` binary: an MCP proxy that sits between an agent host and
//! its MCP servers so that one process sees both the untrusted content arriving
//! as tool results and the payment leaving as a tool call.

mod config;
mod proxy;
mod upstream;

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

/// Command line surface. See the README for the config reference.
#[derive(Debug, Parser)]
#[command(name = "moat-gateway", version, about = "Authorization layer for agent payments", long_about = None)]
struct Cli {
    /// Path to the gateway config file. Required when running the proxy.
    #[arg(short, long, value_name = "FILE", global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

/// Subcommands that do something other than run the proxy.
#[derive(Debug, Subcommand)]
enum Command {
    /// Generate a fresh ed25519 signing keypair for evidence records.
    Keygen {
        /// Directory to write `moat_ed25519` and `moat_ed25519.pub` into.
        #[arg(long, value_name = "DIR", default_value = "./keys")]
        out: PathBuf,
    },
    /// Check the hash chain and signatures of an evidence file.
    Verify {
        /// Path to the evidence JSONL file.
        #[arg(long, value_name = "FILE")]
        evidence: PathBuf,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // stdout is the MCP channel; every log line goes to stderr.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("moat_gateway=info,moat_core=info,moat_mcp=info")
            }),
        )
        .with_writer(std::io::stderr)
        .init();

    match cli.command {
        Some(Command::Keygen { out }) => {
            anyhow::bail!(
                "keygen is not implemented yet (work order step 8); would write to {}",
                out.display()
            )
        }
        Some(Command::Verify { evidence }) => {
            anyhow::bail!(
                "verify is not implemented yet (work order step 8); would read {}",
                evidence.display()
            )
        }
        None => {
            let path = cli
                .config
                .ok_or_else(|| anyhow::anyhow!("--config is required to run the proxy"))?;
            let cfg = config::Config::load(&path)?;
            tracing::info!(config = %path.display(), upstreams = cfg.upstreams.len(), "starting");
            match cfg.listen {
                config::Listen::Stdio => run_stdio(cfg),
                config::Listen::Http { ref addr } => {
                    anyhow::bail!("listen transport http ({addr}) is not implemented yet (work order step 11)")
                }
            }
        }
    }
}

fn run_stdio(cfg: config::Config) -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting tokio runtime")?;
    rt.block_on(async move {
        let stdin = tokio::io::BufReader::new(tokio::io::stdin());
        let stdout = tokio::io::stdout();
        proxy::Gateway::run(cfg, stdin, stdout).await
    })
}
