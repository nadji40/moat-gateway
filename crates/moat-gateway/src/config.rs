//! Gateway configuration, loaded from a YAML file.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use moat_core::rail::Rail;
use serde::Deserialize;

/// Top-level `moat.yaml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Where the gateway listens for the MCP client.
    #[serde(default)]
    pub listen: Listen,
    /// The MCP servers being proxied.
    pub upstreams: Vec<Upstream>,
    /// Path to the policy YAML used by any upstream that does not name its
    /// own. Missing or unreadable means fail closed for payment tools.
    #[serde(default)]
    pub policy: Option<PathBuf>,
    /// Path to the append-only evidence JSONL file.
    #[serde(default = "default_evidence")]
    pub evidence: PathBuf,
    /// Directory holding (or receiving) the ed25519 signing key.
    #[serde(default = "default_keys")]
    pub keys: PathBuf,
    /// Directory holding (or receiving) the secp256k1 co-signing key a
    /// guarded wallet requires before it will move money (ADR 0010).
    ///
    /// Absent by default, and absent means no co-signing: a deployment
    /// that has not asked for this capability should not silently acquire
    /// a key that can cause payments to execute. Deliberately a separate
    /// directory from `keys`, because the two have different blast radii.
    #[serde(default)]
    pub cosign_keys: Option<PathBuf>,
    /// The intent API listener.
    #[serde(default)]
    pub intent_api: Option<IntentApi>,
    /// Separator between upstream name and tool name in aggregated names.
    #[serde(default = "default_separator")]
    pub separator: String,
    /// Fixed session id. If unset, one is generated per connection.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Optional durable PostgreSQL state. Required for authenticated HTTP.
    #[serde(default)]
    pub storage: Option<Storage>,
    /// Bearer authentication for HTTP and the intent API.
    #[serde(default)]
    pub auth: Auth,
}

/// Listen-side transport.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase", deny_unknown_fields)]
pub enum Listen {
    /// Speak MCP on this process's own stdin/stdout.
    #[default]
    Stdio,
    /// Streamable HTTP on the given address.
    Http {
        /// `host:port` to bind.
        addr: String,
        /// How long a session may go without a request before its upstreams
        /// are shut down and it is dropped from memory. Its durable snapshot
        /// is restored by the next request that names it; without durable
        /// storage nothing is dropped.
        #[serde(default = "default_idle_timeout_secs")]
        idle_timeout_secs: u64,
    },
}

/// One proxied MCP server.
///
/// No `deny_unknown_fields` here: serde cannot combine it with the flattened
/// tagged transport. Unknown keys are caught by the enum instead.
#[derive(Debug, Clone, Deserialize)]
pub struct Upstream {
    /// Name used as the tool namespace prefix. Must be unique.
    pub name: String,
    /// Which settlement rail this upstream moves money on. Declared here and
    /// not inferred from the tool, so an agent cannot claim a different one.
    /// Absent means `card`, which is what every upstream was before rails.
    #[serde(default)]
    pub rail: Rail,
    /// Policy governing payments on this upstream. Falls back to the
    /// top-level `policy` when absent. Each upstream's policy loads and fails
    /// independently: an unusable bank policy denies bank payments and leaves
    /// the card upstream alone.
    #[serde(default)]
    pub policy: Option<PathBuf>,
    /// How to reach it.
    #[serde(flatten)]
    pub transport: UpstreamTransport,
}

/// Upstream transport variants.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase", deny_unknown_fields)]
pub enum UpstreamTransport {
    /// Spawn a subprocess and speak over its stdio.
    Stdio {
        /// Program and arguments.
        command: Vec<String>,
        /// Extra environment variables for the child.
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
    },
    /// Streamable HTTP at the given URL.
    Http {
        /// The MCP endpoint.
        url: String,
    },
}

/// Intent API listener.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentApi {
    /// `host:port` to bind. Loopback, unless `auth.required` is on.
    pub addr: String,
    /// The `moat-intent` reader, for example `http://127.0.0.1:7083`. With
    /// it, an intent given as text alone is read into fields by the model;
    /// without it, or when it does not answer in time, the core's own rules
    /// read the text.
    #[serde(default)]
    pub reader: Option<String>,
    /// How long to wait for the reader before the rules read the text.
    #[serde(default = "default_reader_timeout_secs")]
    pub reader_timeout_secs: u64,
}

fn default_reader_timeout_secs() -> u64 {
    45
}

/// Durable PostgreSQL storage configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Storage {
    /// Environment variable containing the PostgreSQL URL.
    #[serde(default = "default_database_url_env")]
    pub database_url_env: String,
    /// Maximum PostgreSQL connections held by this gateway process.
    #[serde(default = "default_max_connections")]
    pub max_connections: usize,
}

/// HTTP authentication configuration.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    /// Require a database-backed bearer key on HTTP and intent requests.
    #[serde(default)]
    pub required: bool,
    /// Let anyone create a tenant and its first `admin` key over HTTP.
    ///
    /// Off unless a deployment says otherwise, because it is the one endpoint
    /// that writes a row for a caller who has no credential yet. Turning it on
    /// is how a public trial works; leaving it off is how a pilot for one
    /// named customer stays that way.
    #[serde(default)]
    pub self_signup: bool,
}

/// Refuse a bind address off the loopback interface.
fn is_loopback(addr: &str) -> bool {
    let host = addr
        .rsplit_once(':')
        .map_or(addr, |(host, _)| host)
        .trim_matches(|c| c == '[' || c == ']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn ensure_loopback(addr: &str, what: &str) -> Result<()> {
    anyhow::ensure!(
        is_loopback(addr),
        concat!(
            "{} is {:?}, which is not loopback, and auth.required is off, so anyone ",
            "who can reach it would be trusted; bind it to 127.0.0.1 or turn auth.required on",
        ),
        what,
        addr
    );
    Ok(())
}

fn default_evidence() -> PathBuf {
    PathBuf::from("./evidence.jsonl")
}
fn default_keys() -> PathBuf {
    PathBuf::from("./keys")
}
fn default_separator() -> String {
    "__".to_owned()
}
fn default_database_url_env() -> String {
    "MOAT_DATABASE_URL".to_owned()
}
fn default_max_connections() -> usize {
    16
}
fn default_idle_timeout_secs() -> u64 {
    30 * 60
}

impl Config {
    /// Read and validate a config file. Relative paths inside it are resolved
    /// against the file's own directory, so `moat-gateway --config x/moat.yaml`
    /// behaves the same from any working directory.
    pub fn load(path: &Path) -> Result<Config> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let mut cfg: Config = serde_norway::from_str(&text)
            .with_context(|| format!("parsing config {}", path.display()))?;
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        cfg.resolve_paths(base);
        cfg.validate()?;
        Ok(cfg)
    }

    fn resolve_paths(&mut self, base: &Path) {
        let fix = |p: &mut PathBuf| {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        };
        if let Some(p) = self.policy.as_mut() {
            fix(p);
        }
        for upstream in &mut self.upstreams {
            if let Some(p) = upstream.policy.as_mut() {
                fix(p);
            }
        }
        fix(&mut self.evidence);
        fix(&mut self.keys);
    }

    fn validate(&self) -> Result<()> {
        anyhow::ensure!(!self.upstreams.is_empty(), "config has no upstreams");
        anyhow::ensure!(!self.separator.is_empty(), "separator must not be empty");
        if self.auth.required {
            anyhow::ensure!(
                self.storage.is_some(),
                "auth.required needs durable storage for tenant API keys"
            );
        } else {
            // With authentication off, whoever can reach a listener is the
            // trusted caller: the intent API registers what the user said
            // and releases holds, and the MCP listener pays. Neither may be
            // reachable from off the machine on that footing.
            if let Listen::Http { addr, .. } = &self.listen {
                ensure_loopback(addr, "listen.addr")?;
            }
            if let Some(api) = &self.intent_api {
                ensure_loopback(&api.addr, "intent_api.addr")?;
            }
        }
        if let Some(api) = &self.intent_api {
            if let Some(reader) = &api.reader {
                // What users type is sent there, so it is a service on this
                // machine and never an address somebody else could answer on.
                let authority = reader
                    .strip_prefix("http://")
                    .and_then(|rest| rest.split('/').next());
                anyhow::ensure!(
                    authority.is_some_and(is_loopback),
                    "intent_api.reader is {reader:?}; it must be an http:// URL on loopback, \
                     because what users type is sent to it"
                );
                anyhow::ensure!(
                    api.reader_timeout_secs > 0,
                    "intent_api.reader_timeout_secs must be positive"
                );
            }
        }
        if let Listen::Http {
            idle_timeout_secs, ..
        } = &self.listen
        {
            anyhow::ensure!(
                *idle_timeout_secs > 0,
                "listen.idle_timeout_secs must be positive"
            );
        }
        if let Some(storage) = &self.storage {
            anyhow::ensure!(
                !storage.database_url_env.trim().is_empty(),
                "storage.database_url_env must not be empty"
            );
            anyhow::ensure!(
                storage.max_connections > 0,
                "storage.max_connections must be positive"
            );
        }
        let mut seen = std::collections::HashSet::new();
        for u in &self.upstreams {
            anyhow::ensure!(!u.name.is_empty(), "an upstream has an empty name");
            anyhow::ensure!(
                !u.name.contains(&self.separator),
                "upstream name {:?} contains the separator {:?}",
                u.name,
                self.separator
            );
            anyhow::ensure!(seen.insert(&u.name), "duplicate upstream name {:?}", u.name);
            if let UpstreamTransport::Stdio { command, .. } = &u.transport {
                anyhow::ensure!(
                    !command.is_empty(),
                    "upstream {:?} has an empty command",
                    u.name
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_readme_example() {
        let text = r#"
listen: { transport: stdio }
upstreams:
  - name: stripe
    transport: stdio
    command: ["node", "arena/mock-stripe/server.js"]
  - name: web
    transport: http
    url: "http://127.0.0.1:7100/mcp"
policy: policies/default.yaml
evidence: ./evidence.jsonl
keys: ./keys
intent_api: { addr: "127.0.0.1:7072" }
"#;
        let cfg: Config = serde_norway::from_str(text).unwrap();
        assert!(matches!(cfg.listen, Listen::Stdio));
        assert_eq!(cfg.upstreams.len(), 2);
        assert_eq!(cfg.separator, "__");
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn rejects_duplicate_and_separator_in_names() {
        let dup = r#"
upstreams:
  - { name: a, transport: stdio, command: ["x"] }
  - { name: a, transport: stdio, command: ["y"] }
"#;
        let cfg: Config = serde_norway::from_str(dup).unwrap();
        assert!(cfg.validate().is_err());

        let sep = r#"
upstreams:
  - { name: "a__b", transport: stdio, command: ["x"] }
"#;
        let cfg: Config = serde_norway::from_str(sep).unwrap();
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn an_upstream_without_a_rail_is_a_card_upstream() {
        let text = r#"
upstreams:
  - { name: stripe, transport: stdio, command: ["x"] }
"#;
        let cfg: Config = serde_norway::from_str(text).unwrap();
        assert_eq!(cfg.upstreams[0].rail, Rail::Card);
        assert!(cfg.upstreams[0].policy.is_none());
    }

    #[test]
    fn an_upstream_can_declare_its_rail_and_its_own_policy() {
        let text = r#"
policy: policies/default.yaml
upstreams:
  - { name: stripe, rail: card, transport: stdio, command: ["x"] }
  - { name: bank, rail: bank, policy: policies/rails/bank.yaml, transport: stdio, command: ["y"] }
  - { name: evm, rail: crypto, transport: stdio, command: ["z"] }
"#;
        let mut cfg: Config = serde_norway::from_str(text).unwrap();
        cfg.resolve_paths(Path::new("/cfg"));
        assert_eq!(cfg.upstreams[0].rail, Rail::Card);
        assert_eq!(cfg.upstreams[1].rail, Rail::Bank);
        assert_eq!(cfg.upstreams[2].rail, Rail::Crypto);
        // A per-upstream policy path resolves against the config's directory,
        // exactly like the top-level one.
        assert_eq!(
            cfg.upstreams[1].policy.as_deref(),
            Some(Path::new("/cfg").join("policies/rails/bank.yaml").as_path())
        );
        assert!(cfg.upstreams[0].policy.is_none(), "falls back to top level");
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn an_unrecognised_rail_is_rejected_rather_than_treated_as_card() {
        let text = r#"
upstreams:
  - { name: sepa, rail: wire, transport: stdio, command: ["x"] }
"#;
        assert!(serde_norway::from_str::<Config>(text).is_err());
    }

    /// The pilot runs from a clone of this repo. Its config must keep parsing
    /// unchanged, with every upstream reading as the card rail it has always
    /// been.
    #[test]
    fn the_pilot_config_still_parses_as_card() {
        let text = include_str!("../../../deploy/moat.pilot.yaml");
        let cfg: Config = serde_norway::from_str(text).unwrap();
        assert!(cfg.upstreams.iter().all(|u| u.rail == Rail::Card));
        assert!(cfg.upstreams.iter().all(|u| u.policy.is_none()));
        assert!(cfg.validate().is_ok());
    }

    /// Without authentication, a listener anyone can reach is a listener
    /// that trusts anyone. It is refused at load rather than warned about.
    #[test]
    fn an_open_listener_needs_authentication() {
        let open_mcp = r#"
listen: { transport: http, addr: "0.0.0.0:7071" }
upstreams:
  - { name: stripe, transport: stdio, command: ["x"] }
"#;
        let cfg: Config = serde_norway::from_str(open_mcp).unwrap();
        assert!(cfg.validate().is_err());

        let open_api = r#"
upstreams:
  - { name: stripe, transport: stdio, command: ["x"] }
intent_api: { addr: "10.0.0.5:7072" }
"#;
        let cfg: Config = serde_norway::from_str(open_api).unwrap();
        assert!(cfg.validate().is_err());

        for addr in ["127.0.0.1:7072", "localhost:7072", "[::1]:7072"] {
            let text = format!(
                "upstreams:\n  - {{ name: s, transport: stdio, command: [\"x\"] }}\nintent_api: {{ addr: \"{addr}\" }}\n"
            );
            let cfg: Config = serde_norway::from_str(&text).unwrap();
            assert!(cfg.validate().is_ok(), "{addr}");
        }

        let authenticated = r#"
listen: { transport: http, addr: "0.0.0.0:7071" }
upstreams:
  - { name: stripe, transport: stdio, command: ["x"] }
intent_api: { addr: "0.0.0.0:7072" }
storage: { database_url_env: MOAT_DATABASE_URL, max_connections: 4 }
auth: { required: true }
"#;
        let cfg: Config = serde_norway::from_str(authenticated).unwrap();
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn authenticated_http_requires_durable_storage() {
        let missing = r#"
listen: { transport: http, addr: "127.0.0.1:7071" }
upstreams:
  - { name: stripe, transport: stdio, command: ["x"] }
auth: { required: true }
"#;
        let cfg: Config = serde_norway::from_str(missing).unwrap();
        assert!(cfg.validate().is_err());

        let durable = r#"
listen: { transport: http, addr: "127.0.0.1:7071" }
upstreams:
  - { name: stripe, transport: stdio, command: ["x"] }
storage: { database_url_env: MOAT_DATABASE_URL, max_connections: 4 }
auth: { required: true }
"#;
        let cfg: Config = serde_norway::from_str(durable).unwrap();
        assert!(cfg.validate().is_ok());
    }
}
