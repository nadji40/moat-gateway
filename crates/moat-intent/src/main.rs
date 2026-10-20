//! The `moat-intent` binary: reads what users type into intent fields for the
//! Moat gateway. See the crate documentation for what it checks.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use moat_intent::reader::{Backend, Provider, Reader};
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
    /// Which kind of server reads: `llama` (llama-server, local or
    /// tunnelled), `anthropic` (Claude), or `openai` (any OpenAI-compatible
    /// chat completions API). A hosted one takes its key from the
    /// environment variable MOAT_INTENT_API_KEY, never from a flag.
    #[arg(long, env = "MOAT_INTENT_PROVIDER", default_value = "llama")]
    provider: Provider,
    /// The server's base URL. Defaults to http://127.0.0.1:8092 for llama
    /// and https://api.anthropic.com for anthropic; openai needs one.
    #[arg(long, env = "MOAT_INTENT_LLM_URL")]
    llm_url: Option<String>,
    /// The model to ask for, as it goes in the record. Defaults to
    /// gemma-4-E4B-it-Q4_K_M for llama and claude-opus-5-5 for anthropic;
    /// openai needs one.
    #[arg(long, env = "MOAT_INTENT_MODEL")]
    model: Option<String>,
    /// How hard a Claude model thinks before answering: low, medium, high,
    /// xhigh or max, or `default` for the model's own. Anthropic only.
    #[arg(long, env = "MOAT_INTENT_EFFORT", default_value = "low")]
    effort: String,
    /// The gateway's intent API. Without it only `/v1/read` works.
    #[arg(long, env = "MOAT_INTENT_GATEWAY")]
    gateway: Option<String>,
    /// How long to wait for the model, in seconds.
    #[arg(long, env = "MOAT_INTENT_TIMEOUT_SECS", default_value_t = 60)]
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

    let provider = cli.provider;
    let llm_url = cli
        .llm_url
        .clone()
        .or_else(|| provider.default_url().map(str::to_owned))
        .with_context(|| format!("the {} provider needs --llm-url", provider.name()))?;
    let model = cli
        .model
        .clone()
        .or_else(|| provider.default_model().map(str::to_owned))
        .with_context(|| format!("the {} provider needs --model", provider.name()))?;
    let effort =
        (provider == Provider::Anthropic && cli.effort != "default").then(|| cli.effort.clone());
    let reader = Reader::with_backend(
        Backend {
            provider,
            url: llm_url.clone(),
            model: model.clone(),
            api_key: std::env::var("MOAT_INTENT_API_KEY").ok(),
            effort,
        },
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
                %local, provider = provider.name(), llm = %llm_url, %model,
                gateway = cli.gateway.as_deref().unwrap_or("none"),
                prompt = %&moat_intent::reader::prompt_sha256()[..16],
                "moat-intent listening"
            );
            axum::serve(socket, router(state))
                .await
                .context("moat-intent server")
        })
}
