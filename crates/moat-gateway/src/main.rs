//! The `moat-gateway` binary: an MCP proxy that sits between an agent host and
//! its MCP servers so that one process sees both the untrusted content arriving
//! as tool results and the payment leaving as a tool call.

mod config;
mod http_listen;
mod intent_api;
mod proxy;
mod state;
mod storage;
mod upstream;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

/// Command line surface. See the README for the config reference.
#[derive(Debug, Parser)]
#[command(name = "moat-gateway", version, about = "Authorization layer for agent payments", long_about = None)]
struct Cli {
    /// Path to the gateway config file. Required when running the proxy.
    #[arg(short, long, value_name = "FILE", global = true)]
    config: Option<PathBuf>,

    /// Session id for this connection; overrides `session_id` in the config.
    #[arg(long, value_name = "ID", global = true)]
    session_id: Option<String>,

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
        /// Directory holding `moat_ed25519.pub`.
        #[arg(
            long,
            value_name = "DIR",
            default_value = "./keys",
            conflicts_with = "pubkey"
        )]
        keys: PathBuf,
        /// Public key as 64 hex characters, instead of `--keys`.
        #[arg(long, value_name = "HEX")]
        pubkey: Option<String>,
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
            let keys = moat_core::keys::Keys::generate().context("generating keypair")?;
            keys.save(&out)
                .with_context(|| format!("writing keys to {}", out.display()))?;
            println!(
                "wrote {} and {}\npublic key: {}",
                out.join(moat_core::keys::SECRET_FILE).display(),
                out.join(moat_core::keys::PUBLIC_FILE).display(),
                keys.public_hex()
            );
            Ok(())
        }
        Some(Command::Verify {
            evidence,
            keys,
            pubkey,
        }) => {
            let public = match pubkey {
                Some(hex) => moat_core::keys::Public::from_hex(&hex).context("--pubkey")?,
                None => moat_core::keys::Public::load(&keys)
                    .with_context(|| format!("loading public key from {}", keys.display()))?,
            };
            let text = std::fs::read_to_string(&evidence)
                .with_context(|| format!("reading {}", evidence.display()))?;
            let report = moat_core::evidence::verify_file(&text, &public);
            for p in &report.problems {
                println!(
                    "line {}{}: {}",
                    p.line,
                    p.id.as_deref()
                        .map(|i| format!(" ({i})"))
                        .unwrap_or_default(),
                    p.problem
                );
            }
            println!(
                "{}: {} records, {} problems, head {}",
                if report.ok() { "OK" } else { "FAILED" },
                report.records,
                report.problems.len(),
                report.head.as_deref().unwrap_or("none")
            );
            if report.ok() {
                Ok(())
            } else {
                std::process::exit(1)
            }
        }
        None => {
            let path = cli
                .config
                .ok_or_else(|| anyhow::anyhow!("--config is required to run the proxy"))?;
            let mut cfg = config::Config::load(&path)?;
            if cli.session_id.is_some() {
                cfg.session_id = cli.session_id;
            }
            tracing::info!(config = %path.display(), upstreams = cfg.upstreams.len(), "starting");
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .context("starting tokio runtime")?;
            rt.block_on(async move {
                let shared = build_shared(&cfg).await?;
                start_intent_api(&cfg, &shared);
                match cfg.listen.clone() {
                    config::Listen::Stdio => {
                        let session_id = cfg.session_id.clone().unwrap_or_else(generate_session_id);
                        tracing::info!(session = %session_id, "stdio session");
                        let stdin = tokio::io::BufReader::new(tokio::io::stdin());
                        let stdout = tokio::io::stdout();
                        proxy::Gateway::run(cfg, shared, session_id, stdin, stdout).await
                    }
                    config::Listen::Http { addr } => {
                        tracing::info!(
                            "each MCP session's id is returned in the Mcp-Session-Id header; use it with the intent API"
                        );
                        http_listen::serve(&addr, cfg, shared).await
                    }
                }
            })
        }
    }
}

async fn build_shared(cfg: &config::Config) -> Result<Arc<state::Shared>> {
    let policies = state::Policies::load(
        cfg.policy.as_deref(),
        cfg.upstreams
            .iter()
            .map(|u| (u.name.as_str(), u.policy.as_deref())),
    );
    let (keys, created) = moat_core::keys::Keys::load_or_create(&cfg.keys)
        .with_context(|| format!("signing keys in {}", cfg.keys.display()))?;
    tracing::info!(
        keys = %cfg.keys.display(), public = %keys.public_hex(), created,
        "evidence signing key ready"
    );
    let cosign = match &cfg.cosign_keys {
        Some(dir) => {
            let (key, created) = moat_core::cosign::CosignKey::load_or_create(dir)
                .with_context(|| format!("co-signing key in {}", dir.display()))?;
            tracing::info!(
                keys = %dir.display(), address = %key.address_hex(), created,
                concat!(
                    "co-signing key ready; a guarded wallet constructed with ",
                    "this address will execute only payments this gateway allows",
                )
            );
            Some(key)
        }
        None => None,
    };
    let storage = match &cfg.storage {
        Some(storage) => {
            let database_url = std::env::var(&storage.database_url_env).with_context(|| {
                format!(
                    "reading storage URL from environment variable {}",
                    storage.database_url_env
                )
            })?;
            let store = storage::DurableStore::connect(&database_url, storage.max_connections)
                .await
                .context("connecting durable storage")?;
            tracing::info!(
                max_connections = storage.max_connections,
                "durable PostgreSQL storage ready"
            );
            Some(store)
        }
        None => None,
    };
    Ok(Arc::new(
        state::Shared::new(
            policies,
            keys,
            cfg.evidence.clone(),
            storage,
            cfg.auth.required,
        )?
        .with_cosign(cosign),
    ))
}

fn start_intent_api(cfg: &config::Config, shared: &Arc<state::Shared>) {
    match &cfg.intent_api {
        Some(api) => {
            tracing::info!(
                "register intents at http://{}/v1/session/{{session}}/intent",
                api.addr
            );
            let addr = api.addr.clone();
            let api_shared = Arc::clone(shared);
            tokio::spawn(async move {
                if let Err(e) = intent_api::serve(&addr, api_shared).await {
                    tracing::error!(error = %e, "intent API stopped");
                }
            });
        }
        None => tracing::warn!(
            "no intent_api configured: nothing can register intents, so every payee will be untrusted"
        ),
    }
}

fn generate_session_id() -> String {
    let random: [u8; 24] = rand::random();
    format!("s_{}", moat_core::hash::sha256_hex(&random))
}
