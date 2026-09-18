//! Gateway configuration, loaded from a YAML file.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
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
    /// Path to the policy YAML. Missing or unreadable means fail closed for
    /// payment tools.
    #[serde(default)]
    pub policy: Option<PathBuf>,
    /// Path to the append-only evidence JSONL file.
    #[serde(default = "default_evidence")]
    pub evidence: PathBuf,
    /// Directory holding (or receiving) the ed25519 signing key.
    #[serde(default = "default_keys")]
    pub keys: PathBuf,
    /// The intent API listener. Read from step 7 on.
    #[serde(default)]
    #[allow(dead_code)]
    pub intent_api: Option<IntentApi>,
    /// Separator between upstream name and tool name in aggregated names.
    #[serde(default = "default_separator")]
    pub separator: String,
    /// Fixed session id. If unset, one is generated per connection. Read
    /// from step 4 on.
    #[serde(default)]
    #[allow(dead_code)]
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
    /// Streamable HTTP on the given address (step 11).
    Http {
        /// `host:port` to bind.
        addr: String,
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
    /// `host:port` to bind. Should be loopback.
    #[allow(dead_code)]
    pub addr: String,
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
