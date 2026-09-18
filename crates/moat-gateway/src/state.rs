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
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::storage::DurableStore;

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingResume {
    /// Session the step-up belongs to.
    pub session: String,
    /// Evidence record of the step-up verdict.
    pub evidence_id: String,
    /// Exact payment proposal the human was shown. Excludes JSON-RPC id.
    pub payment_fingerprint: String,
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
    session_tenants: Mutex<HashMap<String, String>>,
    session_versions: Mutex<HashMap<String, i64>>,
    session_gates: AsyncMutex<HashMap<String, std::sync::Arc<AsyncMutex<()>>>>,
    evidence: Mutex<EvidenceLog>,
    storage: Option<DurableStore>,
    auth_required: bool,
}

impl Shared {
    /// Build shared state. The evidence file is opened lazily on first write.
    /// If the file already has records, the chain continues from its last
    /// line.
    pub fn new(
        policy: PolicyState,
        keys: Keys,
        evidence_path: PathBuf,
        storage: Option<DurableStore>,
        auth_required: bool,
    ) -> Result<Shared> {
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
            session_tenants: Mutex::new(HashMap::new()),
            session_versions: Mutex::new(HashMap::new()),
            session_gates: AsyncMutex::new(HashMap::new()),
            evidence: Mutex::new(EvidenceLog {
                path: evidence_path,
                records: Vec::new(),
                last_hash,
            }),
            storage,
            auth_required,
        })
    }

    /// Whether HTTP callers must present a database-backed bearer key.
    pub fn auth_required(&self) -> bool {
        self.auth_required
    }

    /// Resolve a bearer token to a tenant, or the trusted local tenant when
    /// authentication is disabled.
    pub async fn authenticate_bearer(
        &self,
        token: Option<&str>,
        access_role: &str,
    ) -> Result<Option<String>> {
        if !self.auth_required {
            return Ok(Some("local".to_owned()));
        }
        let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
            return Ok(None);
        };
        let Some(storage) = &self.storage else {
            anyhow::bail!("authentication requires durable storage");
        };
        let hash = moat_core::hash::sha256_hex(token.as_bytes());
        storage.authenticate(&hash, access_role).await
    }

    async fn session_gate(&self, tenant_id: &str, id: &str) -> std::sync::Arc<AsyncMutex<()>> {
        let key = format!("{tenant_id}\0{id}");
        let mut gates = self.session_gates.lock().await;
        std::sync::Arc::clone(
            gates
                .entry(key)
                .or_insert_with(|| std::sync::Arc::new(AsyncMutex::new(()))),
        )
    }

    /// Return a tenant-bound session, restoring it from PostgreSQL when
    /// necessary. `create` is used only for a new trusted session.
    pub async fn session_for_tenant(
        &self,
        tenant_id: &str,
        id: &str,
        create: bool,
    ) -> Result<Option<std::sync::Arc<Mutex<Session>>>> {
        let gate = self.session_gate(tenant_id, id).await;
        let _guard = gate.lock().await;
        if let Some(bound) = self
            .session_tenants
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
        {
            if bound != tenant_id {
                return Ok(None);
            }
            return Ok(self.store.get(id));
        }

        if let Some(storage) = &self.storage {
            if let Some((session, version)) = storage.load_session(tenant_id, id).await? {
                let session = self.store.insert(session);
                self.session_tenants
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(id.to_owned(), tenant_id.to_owned());
                self.session_versions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(id.to_owned(), version);
                return Ok(Some(session));
            }
        }

        if !create {
            return Ok(None);
        }
        let session = self.store.get_or_create(id);
        self.session_tenants
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_owned(), tenant_id.to_owned());
        if let Some(storage) = &self.storage {
            let snapshot = lock(&session).clone();
            let version = storage.save_session(tenant_id, &snapshot, None).await?;
            self.session_versions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(id.to_owned(), version);
        }
        Ok(Some(session))
    }

    /// Persist the current complete session snapshot.
    pub async fn persist_session(&self, tenant_id: &str, id: &str) -> Result<()> {
        let Some(storage) = &self.storage else {
            return Ok(());
        };
        let gate = self.session_gate(tenant_id, id).await;
        let _guard = gate.lock().await;
        let bound = self
            .session_tenants
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned();
        anyhow::ensure!(
            bound.as_deref() == Some(tenant_id),
            "session is not bound to authenticated tenant"
        );
        let session = self
            .store
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("session is not loaded"))?;
        let snapshot = lock(&session).clone();
        let expected_version = self
            .session_versions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("session version is not loaded"))?;
        let version = storage
            .save_session(tenant_id, &snapshot, Some(expected_version))
            .await?;
        self.session_versions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_owned(), version);
        Ok(())
    }

    /// Apply a control-plane mutation and its durable snapshot as one logical
    /// operation. A failed write restores the in-memory state before returning.
    pub async fn mutate_session<T, F>(
        &self,
        tenant_id: &str,
        id: &str,
        mutate: F,
    ) -> Result<std::result::Result<T, String>>
    where
        T: Send,
        F: FnOnce(&mut Session) -> std::result::Result<T, String> + Send,
    {
        let gate = self.session_gate(tenant_id, id).await;
        let _guard = gate.lock().await;
        let bound = self
            .session_tenants
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned();
        anyhow::ensure!(
            bound.as_deref() == Some(tenant_id),
            "session is not bound to authenticated tenant"
        );
        let session = self
            .store
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("session is not loaded"))?;
        let (before, after, value) = {
            let mut session = lock(&session);
            let before = session.clone();
            match mutate(&mut session) {
                Ok(value) => (before, session.clone(), value),
                Err(message) => {
                    *session = before;
                    return Ok(Err(message));
                }
            }
        };
        if let Some(storage) = &self.storage {
            let expected_version = self
                .session_versions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(id)
                .copied()
                .ok_or_else(|| anyhow::anyhow!("session version is not loaded"))?;
            match storage
                .save_session(tenant_id, &after, Some(expected_version))
                .await
            {
                Ok(version) => {
                    self.session_versions
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(id.to_owned(), version);
                }
                Err(error) => {
                    *lock(&session) = before;
                    return Err(error);
                }
            }
        }
        Ok(Ok(value))
    }

    /// Persist signed evidence in PostgreSQL as well as the append-only file.
    pub async fn persist_evidence(&self, tenant_id: &str, record: &Record) -> Result<()> {
        let Some(storage) = &self.storage else {
            return Ok(());
        };
        storage
            .save_evidence(tenant_id, &record.session, record)
            .await
    }

    /// Check durable storage readiness when configured.
    pub async fn storage_ready(&self) -> Result<()> {
        match &self.storage {
            Some(storage) => storage.ready().await,
            None => Ok(()),
        }
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

    /// Evidence for one authenticated tenant session, restored from durable
    /// storage when configured.
    pub async fn evidence_for_tenant(
        &self,
        tenant_id: &str,
        session_id: &str,
    ) -> Result<Vec<Record>> {
        match &self.storage {
            Some(storage) => storage.evidence_for(tenant_id, session_id).await,
            None => Ok(self.evidence_for(session_id)),
        }
    }

    /// Mint a resume token for a step-up.
    pub async fn new_resume(&self, tenant_id: &str, pending: PendingResume) -> Result<String> {
        let random: [u8; 32] = rand::random();
        let token = format!("rt_{}", moat_core::hash::sha256_hex(&random));
        if let Some(storage) = &self.storage {
            let value = serde_json::to_value(&pending).context("encoding pending approval")?;
            storage
                .save_resume(
                    &moat_core::hash::sha256_hex(token.as_bytes()),
                    tenant_id,
                    &pending.session,
                    &value,
                    900,
                )
                .await?;
        } else {
            self.resumes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(token.clone(), pending);
        }
        Ok(token)
    }

    /// Atomically consume a tenant- and session-bound resume token.
    pub async fn take_resume(
        &self,
        tenant_id: &str,
        session_id: &str,
        token: &str,
    ) -> Result<Option<PendingResume>> {
        if let Some(storage) = &self.storage {
            let value = storage
                .take_resume(
                    &moat_core::hash::sha256_hex(token.as_bytes()),
                    tenant_id,
                    session_id,
                )
                .await?;
            return value
                .map(|value| serde_json::from_value(value).context("decoding pending approval"))
                .transpose();
        }
        let mut resumes = self.resumes.lock().unwrap_or_else(PoisonError::into_inner);
        if resumes
            .get(token)
            .is_some_and(|pending| pending.session == session_id)
        {
            Ok(resumes.remove(token))
        } else {
            Ok(None)
        }
    }

    /// Apply the host's answer to a step-up: on approval every value the
    /// human saw is registered as an intent, so the same call resolves to
    /// `User` next time. Returns what was confirmed.
    pub fn resolve_step_up(
        session: &mut Session,
        pending: PendingResume,
        token: &str,
        approved: bool,
    ) -> Vec<String> {
        let mut confirmed = Vec::new();
        if approved {
            session.approve_payment_proposal(pending.payment_fingerprint);
            for (field, value) in &pending.values {
                let text = match value {
                    Value::String(t) => t.clone(),
                    other => other.to_string(),
                };
                session.register_intent(&format!("confirmed {field}: {text}"));
                confirmed.push(text);
            }
        }
        session.log(Event::StepUpResolved {
            // Correlate the audit event without persisting the bearer token.
            resume_token: format!("sha256:{}", moat_core::hash::sha256_hex(token.as_bytes())),
            approved,
        });
        confirmed
    }
}
