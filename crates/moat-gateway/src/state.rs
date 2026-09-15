//! State shared between the proxy session and the intent API.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use anyhow::{Context, Result};
use moat_core::evidence::Record;
use moat_core::keys::Keys;
use moat_core::policy::{Evaluation, Policy, PolicyError};
use moat_core::session::{lock, Event, Session, SessionStore};
use serde_json::Value;

/// Tool names treated as payments when no policy could be loaded. The
/// gateway fails closed for these and open for everything else.
pub const FALLBACK_PAYMENT_TOOLS: &[&str] = &[
    "pay",
    "create_payment",
    "charge",
    "transfer",
    "send_money",
    "purchase",
    "checkout",
    "refund",
];

/// Whether a policy is in force.
pub enum PolicyState {
    /// Loaded and validated.
    Loaded(Policy),
    /// Could not be loaded; payment-looking tools are denied.
    Missing(String),
}

impl PolicyState {
    /// Load from the configured path, if any. Never fails: a bad policy is
    /// recorded as [`PolicyState::Missing`] and shouted about.
    pub fn load(path: Option<&Path>) -> PolicyState {
        let Some(path) = path else {
            let why = "no `policy` in config".to_owned();
            tracing::error!("POLICY MISSING: {why}; payment tools will be DENIED");
            return PolicyState::Missing(why);
        };
        match Policy::load(path) {
            Ok(p) => {
                tracing::info!(policy = %path.display(), rules = p.rules.len(), "policy loaded");
                PolicyState::Loaded(p)
            }
            Err(e) => {
                let why = match &e {
                    PolicyError::Io { .. } => format!("{e}"),
                    other => format!("{other}"),
                };
                tracing::error!("POLICY UNUSABLE: {why}; payment tools will be DENIED, everything else forwarded");
                PolicyState::Missing(why)
            }
        }
    }

    /// Whether `tool` on `server` must go through evaluation.
    pub fn is_payment_tool(&self, server: &str, tool: &str) -> bool {
        match self {
            PolicyState::Loaded(p) => p.is_payment_tool(server, tool),
            PolicyState::Missing(_) => FALLBACK_PAYMENT_TOOLS.contains(&tool),
        }
    }
}

/// A step-up waiting for the host's answer.
#[derive(Debug, Clone)]
pub struct PendingResume {
    /// Session the step-up belongs to.
    pub session: String,
    /// Evidence record of the step-up verdict.
    pub evidence_id: String,
    /// The field values the human is being asked to approve.
    pub values: Vec<(String, Value)>,
}

struct EvidenceLog {
    path: PathBuf,
    records: Vec<Record>,
    last_hash: Option<String>,
}

/// Everything the proxy and the intent API both touch.
pub struct Shared {
    /// Sessions by id.
    pub store: SessionStore,
    /// The policy, or why there is none.
    pub policy: PolicyState,
    keys: Keys,
    resumes: Mutex<HashMap<String, PendingResume>>,
    evidence: Mutex<EvidenceLog>,
}

impl Shared {
    /// Build shared state. The evidence file is opened lazily on first write.
    /// If the file already has records, the chain continues from its last
    /// line.
    pub fn new(policy: PolicyState, keys: Keys, evidence_path: PathBuf) -> Result<Shared> {
        let last_hash = match std::fs::read_to_string(&evidence_path) {
            Ok(text) => text
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|l| moat_core::hash::sha256_hex(l.as_bytes())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(e).with_context(|| format!("reading {}", evidence_path.display()))
            }
        };
        if last_hash.is_some() {
            tracing::info!(evidence = %evidence_path.display(), "continuing existing evidence chain");
        }
        Ok(Shared {
            store: SessionStore::new(),
            policy,
            keys,
            resumes: Mutex::new(HashMap::new()),
            evidence: Mutex::new(EvidenceLog {
                path: evidence_path,
                records: Vec::new(),
                last_hash,
            }),
        })
    }

    /// Append the evidence record for an evaluation and log the evaluation
    /// in the session. Returns the record.
    ///
    /// The session lock must not be held by the caller.
    pub fn record(&self, session: &Mutex<Session>, eval: &Evaluation) -> Result<Record> {
        let mut log = self.evidence.lock().unwrap_or_else(PoisonError::into_inner);
        let mut record = {
            let s = lock(session);
            Record::from_evaluation(&s, eval, log.last_hash.clone())
        };
        record.sign(&self.keys);
        let line = record.to_line();
        if let Some(dir) = log.path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("creating {}", dir.display()))?;
            }
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log.path)
            .with_context(|| format!("opening evidence file {}", log.path.display()))?;
        f.write_all(line.as_bytes())
            .and_then(|_| f.write_all(b"\n"))
            .and_then(|_| f.flush())
            .with_context(|| format!("appending to {}", log.path.display()))?;
        log.last_hash = Some(record.hash());
        log.records.push(record.clone());
        lock(session).record_evaluation(eval);
        Ok(record)
    }

    /// Evidence records for one session, in order.
    pub fn evidence_for(&self, session_id: &str) -> Vec<Record> {
        let log = self.evidence.lock().unwrap_or_else(PoisonError::into_inner);
        log.records
            .iter()
            .filter(|r| r.session == session_id)
            .cloned()
            .collect()
    }

    /// Mint a resume token for a step-up.
    pub fn new_resume(&self, pending: PendingResume) -> String {
        let seed = format!(
            "{}|{}|{}",
            pending.session,
            pending.evidence_id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let token = format!("rt_{}", &moat_core::hash::sha256_hex(seed.as_bytes())[..32]);
        self.resumes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(token.clone(), pending);
        token
    }

    /// Consume a resume token. `Ok(None)` when unknown.
    pub fn take_resume(&self, token: &str) -> Option<PendingResume> {
        self.resumes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(token)
    }

    /// Apply the host's answer to a step-up: on approval every value the
    /// human saw is registered as an intent, so the same call resolves to
    /// `User` next time. Returns what was confirmed.
    pub fn resolve_step_up(
        &self,
        pending: PendingResume,
        token: &str,
        approved: bool,
    ) -> Vec<String> {
        let session = self.store.get_or_create(&pending.session);
        let mut s = lock(&session);
        let mut confirmed = Vec::new();
        if approved {
            for (field, value) in &pending.values {
                let text = match value {
                    Value::String(t) => t.clone(),
                    other => other.to_string(),
                };
                s.register_intent(&format!("confirmed {field}: {text}"));
                confirmed.push(text);
            }
        }
        s.log(Event::StepUpResolved {
            resume_token: token.to_owned(),
            approved,
        });
        confirmed
    }
}
