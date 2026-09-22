//! State shared between the proxy session and the intent API.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use anyhow::{Context, Result};
use moat_core::cosign::CosignKey;
use moat_core::evidence::Record;
use moat_core::keys::Keys;
use moat_core::money::{Asset, AssetRegistry};
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

/// The policies in force: a default, plus an override for any upstream that
/// names its own.
///
/// Each loads independently. Rails differ enough that one document cannot
/// sensibly govern a card merchant and a bank beneficiary, and an unusable
/// bank policy must deny bank payments without disturbing the card upstream
/// beside it.
pub struct Policies {
    default: PolicyState,
    per_upstream: HashMap<String, PolicyState>,
}

impl Policies {
    /// Load the default policy and every per-upstream override.
    ///
    /// Never fails: an unreadable policy becomes [`PolicyState::Missing`] for
    /// whatever it governs, which denies payment-looking tools there.
    pub fn load<'a, I>(default_path: Option<&Path>, upstreams: I) -> Policies
    where
        I: IntoIterator<Item = (&'a str, Option<&'a Path>)>,
    {
        let default = PolicyState::load(default_path);
        let mut per_upstream = HashMap::new();
        for (name, path) in upstreams {
            let Some(path) = path else { continue };
            tracing::info!(upstream = name, policy = %path.display(), "loading upstream policy");
            per_upstream.insert(name.to_owned(), PolicyState::load(Some(path)));
        }
        Policies {
            default,
            per_upstream,
        }
    }

    /// Build from one already-loaded policy with no per-upstream overrides.
    ///
    /// Test-only: a deployment reaches the same state through
    /// [`Policies::load`], which is the path that logs what it loaded.
    #[cfg(test)]
    pub fn single(default: PolicyState) -> Policies {
        Policies {
            default,
            per_upstream: HashMap::new(),
        }
    }

    /// The policy governing `upstream`, which is the default unless that
    /// upstream named its own.
    pub fn for_upstream(&self, upstream: &str) -> &PolicyState {
        self.per_upstream.get(upstream).unwrap_or(&self.default)
    }

    /// Whether `tool` on `server` must go through evaluation, under whichever
    /// policy governs `server`.
    pub fn is_payment_tool(&self, server: &str, tool: &str) -> bool {
        self.for_upstream(server).is_payment_tool(server, tool)
    }

    /// Every asset any loaded policy declares, over the built-in table.
    ///
    /// An authorization is registered against a session rather than an
    /// upstream, so it cannot consult one policy; the union is what lets a
    /// deployment declare a token in the policy that uses it and still
    /// authorize a payment in it.
    pub fn assets(&self) -> AssetRegistry {
        let mut declared: Vec<Asset> = Vec::new();
        for state in std::iter::once(&self.default).chain(self.per_upstream.values()) {
            if let PolicyState::Loaded(policy) = state {
                declared.extend(policy.assets.iter().cloned());
            }
        }
        AssetRegistry::new().with_declared(&declared)
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
    /// The policies in force, one per upstream with a shared fallback.
    pub policies: Policies,
    keys: Keys,
    resumes: Mutex<HashMap<String, PendingResume>>,
    session_tenants: Mutex<HashMap<String, String>>,
    session_versions: Mutex<HashMap<String, i64>>,
    session_gates: AsyncMutex<HashMap<String, std::sync::Arc<AsyncMutex<()>>>>,
    evidence: Mutex<EvidenceLog>,
    storage: Option<DurableStore>,
    auth_required: bool,
    /// The secp256k1 key a guarded wallet requires before it will move
    /// money (ADR 0010). Separate from `keys`, which signs evidence:
    /// evidence proves what Moat decided, this causes money to move, and a
    /// compromise of one must not be a compromise of the other. Absent
    /// unless the deployment has one.
    cosign: Option<CosignKey>,
}

impl Shared {
    /// Build shared state. The evidence file is opened lazily on first write.
    /// If the file already has records, the chain continues from its last
    /// line.
    pub fn new(
        policies: Policies,
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
            policies,
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
            cosign: None,
        })
    }

    /// Attach the co-signing key. Builder-style so every existing caller of
    /// `new` keeps working and a deployment without one is the default.
    #[must_use]
    pub fn with_cosign(mut self, cosign: Option<CosignKey>) -> Shared {
        self.cosign = cosign;
        self
    }

    /// The co-signing key, if this deployment has one.
    pub fn cosign(&self) -> Option<&CosignKey> {
        self.cosign.as_ref()
    }

    /// The durable store, when this deployment has one.
    pub fn storage(&self) -> Option<&DurableStore> {
        self.storage.as_ref()
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

    /// Which key a bearer token is, for recording who minted another key.
    ///
    /// Deliberately separate from [`Self::authenticate_bearer`]: that call
    /// decides whether a request is allowed, and this one only labels an
    /// audit field. A failure here must never turn into a refusal, so the
    /// caller treats `None` as "unattributed" rather than as "denied".
    pub async fn key_id_for_bearer(&self, token: Option<&str>) -> Result<Option<String>> {
        let (Some(token), Some(storage)) = (
            token.map(str::trim).filter(|token| !token.is_empty()),
            &self.storage,
        ) else {
            return Ok(None);
        };
        let hash = moat_core::hash::sha256_hex(token.as_bytes());
        storage.api_key_id(&hash).await
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
        self.mirror_payment_ledger(storage, tenant_id, &snapshot)
            .await;
        Ok(())
    }

    /// Mirror the session's mandates into the payment ledger.
    ///
    /// A mirror, not the source: the gateway still evaluates from the
    /// session document, and this keeps the tenant-scoped tables in step so
    /// a later session can find a mandate and an operator can see every
    /// open outcome. Deliberately non-fatal -- the session snapshot is
    /// already committed by the time this runs, and failing the caller's
    /// request over a bookkeeping write would turn a reporting problem into
    /// a payment outage. It is logged loudly instead.
    async fn mirror_payment_ledger(
        &self,
        storage: &DurableStore,
        tenant_id: &str,
        snapshot: &Session,
    ) {
        if snapshot.payment_authorizations().is_empty() {
            return;
        }
        if let Err(error) = storage.save_payment_ledger(tenant_id, snapshot).await {
            tracing::error!(
                %error, tenant = %tenant_id, session = %snapshot.id,
                concat!(
                    "payment ledger mirror failed; the session is saved ",
                    "and the tenant-scoped tables are now behind",
                )
            );
        }
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
                    self.mirror_payment_ledger(storage, tenant_id, &after).await;
                }
                Err(error) => {
                    *lock(&session) = before;
                    return Err(error);
                }
            }
        }
        Ok(Ok(value))
    }

    /// Bring an authorization from the ledger into this session, if this
    /// session does not have it and the ledger does.
    ///
    /// This is what makes a mandate outlive the conversation that created
    /// it. The session document is still what the policy evaluates, so the
    /// row is copied in rather than read through; that keeps evaluation
    /// synchronous and keeps one code path deciding, whether the mandate
    /// was granted a minute ago or last week.
    ///
    /// Silent when there is no storage, when the session already has it, or
    /// when the ledger does not. A miss here is not an error: most calls
    /// carry an authorization the session registered itself.
    pub async fn hydrate_authorization(
        &self,
        tenant_id: &str,
        session: &std::sync::Arc<std::sync::Mutex<Session>>,
        authorization_id: &str,
    ) {
        let Some(storage) = &self.storage else { return };
        {
            let session = lock(session);
            if session.payment_authorization(authorization_id).is_some() {
                return;
            }
        }
        match storage
            .payment_authorization(tenant_id, authorization_id)
            .await
        {
            Ok(Some(authorization)) => {
                let mut session = lock(session);
                if let Err(error) = session.register_payment_authorization(authorization) {
                    tracing::warn!(
                        %error, tenant = %tenant_id, authorization_id,
                        "an authorization from the ledger was refused by this session"
                    );
                } else {
                    tracing::info!(
                        tenant = %tenant_id, authorization_id,
                        concat!(
                            "authorization loaded from the payment ledger; ",
                            "it outlived the session that registered it",
                        )
                    );
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                %error, tenant = %tenant_id, authorization_id,
                "could not read the payment ledger; evaluating on this session alone"
            ),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded(yaml: &str) -> PolicyState {
        PolicyState::Loaded(Policy::from_yaml(yaml).expect("policy parses"))
    }

    /// A policy that calls `transfer` a payment, which the default policy
    /// does not. Used to prove the two are consulted independently.
    const BANK_POLICY: &str = "\
version: 1
payment_tools:
  - server: bank
    tool: transfer
fields:
  payee: { args: [\"payee\"] }
rules:
  - id: payee-provenance
    when: field == payee
    require_source: [User]
    on_fail: deny
";

    #[test]
    fn an_upstream_without_its_own_policy_uses_the_default() {
        let policies = Policies::single(loaded(include_str!("../../../policies/default.yaml")));
        assert!(policies.is_payment_tool("stripe", "pay"));
        assert!(policies.is_payment_tool("anything", "pay"));
        assert!(!policies.is_payment_tool("web", "fetch"));
    }

    #[test]
    fn an_upstream_policy_governs_only_that_upstream() {
        let policies = Policies {
            default: loaded(include_str!("../../../policies/default.yaml")),
            per_upstream: HashMap::from([("bank".to_owned(), loaded(BANK_POLICY))]),
        };
        // The bank policy knows `transfer` is a payment; the default does not.
        assert!(policies.is_payment_tool("bank", "transfer"));
        assert!(!policies.is_payment_tool("stripe", "transfer"));
        // And the default still governs the card upstream.
        assert!(policies.is_payment_tool("stripe", "pay"));
        // `pay` on the bank upstream is not a payment under the bank policy,
        // which lists only `transfer`. Each upstream is judged by its own.
        assert!(!policies.is_payment_tool("bank", "pay"));
    }

    /// The reason policies are per upstream: one rail's unusable policy must
    /// not decide anything for another rail.
    #[test]
    fn one_unusable_policy_does_not_disturb_the_other_upstream() {
        let policies = Policies {
            default: loaded(include_str!("../../../policies/default.yaml")),
            per_upstream: HashMap::from([(
                "bank".to_owned(),
                PolicyState::Missing("unreadable".to_owned()),
            )]),
        };
        // The broken bank policy falls back to the fail-closed tool list, so
        // payment-shaped tools there are still caught.
        assert!(policies.is_payment_tool("bank", "transfer"));
        assert!(matches!(
            policies.for_upstream("bank"),
            PolicyState::Missing(_)
        ));
        // The card upstream is untouched and still evaluates normally.
        assert!(matches!(
            policies.for_upstream("stripe"),
            PolicyState::Loaded(_)
        ));
        assert!(policies.is_payment_tool("stripe", "pay"));
        assert!(!policies.is_payment_tool("stripe", "fetch"));
    }
}
