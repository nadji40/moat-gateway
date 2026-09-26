//! The `moat-intent` binary: reads what users type into intent fields for the
//! Moat gateway. See the crate documentation for what it checks.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use moat_intent::reader::Reader;
use moat_intent::server::{router, AppState};

/// Command line.
#[derive(Debug, Parser)]
#[command(
    name = "moat-intent",
    version,
    about = "Reads what a user typed into Moat intent fields"
)]
struct Cli {
    /// Where to listen.
    #[arg(long, default_value = "127.0.0.1:7083")]
    listen: String,
    /// The llama-server serving the model.
    #[arg(long, default_value = "http://127.0.0.1:8092")]
    llm_url: String,
    /// The model's name, as it goes in the record.
    #[arg(long, default_value = "gemma-4-E4B-it-Q4_K_M")]
    model: String,
    /// The gateway's intent API. Without it only `/v1/read` works.
    #[arg(long)]
    gateway: Option<String>,
    /// How long to wait for the model, in seconds.
    #[arg(long, default_value_t = 60)]
    timeout_secs: u64,
    /// Listen on an address other than loopback. The service holds no
    /// credential, but what users type passes through it.
    #[arg(long)]
    allow_remote: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("moat_intent=info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let reader = Reader::new(
        &cli.llm_url,
        &cli.model,
        Duration::from_secs(cli.timeout_secs),
    )?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("building the gateway client")?;
    let state = Arc::new(AppState {
        reader,
        gateway: cli.gateway.clone(),
        http,
    });

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting tokio runtime")?
        .block_on(async move {
            let socket = tokio::net::TcpListener::bind(&cli.listen)
                .await
                .with_context(|| format!("binding {}", cli.listen))?;
            let local = socket.local_addr().context("local address")?;
            anyhow::ensure!(
                local.ip().is_loopback() || cli.allow_remote,
                "{local} is not loopback; pass --allow-remote if that is intended"
            );
            tracing::info!(
                %local, llm = %cli.llm_url, model = %cli.model,
                gateway = cli.gateway.as_deref().unwrap_or("none"),
                prompt = %&moat_intent::reader::prompt_sha256()[..16],
                "moat-intent listening"
            );
            axum::serve(socket, router(state))
                .await
                .context("moat-intent server")
        })
}
