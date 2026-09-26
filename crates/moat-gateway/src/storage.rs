//! Durable PostgreSQL state for authenticated gateway deployments.

use std::str::FromStr;
use std::time::SystemTime;

use anyhow::{Context, Result};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use moat_core::evidence::Record;
use moat_core::money::Minor;
use moat_core::session::{PaymentAuthorization, Session};
use serde_json::Value;
use tokio_postgres::types::Json;
use tokio_postgres::{Config as PgConfig, NoTls};

/// PostgreSQL-backed sessions, approval tokens, API keys and signed evidence.
#[derive(Clone)]
pub struct DurableStore {
    pool: Pool,
}

/// The columns [`ApiKey::from_row`] reads, as one string.
///
/// `from_row` takes columns by name and panics on one the result does not
/// carry, so every query that builds an `ApiKey` has to return exactly this
/// list. Three separate queries do, and a RETURNING clause written out by hand
/// is easy to write from memory and then forget when the shape changes: adding
/// `scopes` to one of the three left signup and revoke panicking on a column
/// the row did not have. A macro rather than a constant so the result is still
/// a compile-time literal that `concat!` can splice into each query.
macro_rules! api_key_columns {
    () => {
        "id, label, access_role, active, created_at, last_used_at, revoked_at, scopes"
    };
}

/// The schema version this build needs: the newest file in `migrations/`,
/// read by the build script.
///
/// Read rather than written, because a number kept by hand is a number that
/// goes stale. The deploy migrates before it installs, so a binary that wants
/// the newest migration is a binary that gets it; and a gateway that started
/// against a schema it predates would fail at the first query instead of at
/// startup, with an error about a missing column rather than about a
/// migration nobody ran.
const REQUIRED_MIGRATION: i64 = parse_decimal(env!("MOAT_LATEST_MIGRATION"));

/// A non-negative decimal integer, at compile time.
const fn parse_decimal(text: &str) -> i64 {
    let bytes = text.as_bytes();
    assert!(!bytes.is_empty(), "MOAT_LATEST_MIGRATION is empty");
    let mut i = 0;
    let mut n: i64 = 0;
    while i < bytes.len() {
        let digit = bytes[i];
        assert!(
            digit.is_ascii_digit(),
            "MOAT_LATEST_MIGRATION is not a number"
        );
        n = n * 10 + (digit - b'0') as i64;
        i += 1;
    }
    n
}

impl DurableStore {
    /// Connect and verify that the first production schema migration exists.
    pub async fn connect(database_url: &str, max_connections: usize) -> Result<Self> {
        let pg = PgConfig::from_str(database_url).context("parsing storage database URL")?;
        let manager = Manager::from_config(
            pg,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(max_connections)
            .build()
            .context("building PostgreSQL pool")?;
        let store = Self { pool };
        store.ready().await?;
        let client = store.pool.get().await.context("checking storage schema")?;
        let applied: Option<i64> = client
            .query_one(
                "SELECT max(version)::bigint FROM moat.schema_migrations",
                &[],
            )
            .await
            .context("checking storage migration")?
            .get(0);
        anyhow::ensure!(
            applied.unwrap_or(0) >= REQUIRED_MIGRATION,
            "this build needs Moat database migration {REQUIRED_MIGRATION}; the database is at {}. Run scripts/migrate.sh.",
            applied.unwrap_or(0)
        );
        Ok(store)
    }

    /// Check that PostgreSQL is reachable by the runtime role.
    pub async fn ready(&self) -> Result<()> {
        let client = self
            .pool
            .get()
            .await
            .context("getting PostgreSQL connection")?;
        client
            .simple_query("SELECT 1")
            .await
            .context("checking PostgreSQL connection")?;
        Ok(())
    }

    /// Resolve an active bearer key to its active tenant.
    pub async fn authenticate(&self, key_hash: &str, access_role: &str) -> Result<Option<Caller>> {
        let client = self.pool.get().await.context("auth database connection")?;
        let row = client
            .query_opt(
                "UPDATE moat.api_keys k
                 SET last_used_at = now()
                 FROM moat.tenants t
                 WHERE k.tenant_id = t.id
                   AND k.key_hash = $1
                   AND k.access_role = $2
                   AND k.active
                   AND t.active
                 RETURNING k.tenant_id, k.id, k.scopes",
                &[&key_hash, &access_role],
            )
            .await
            .context("authenticating API key")?;
        Ok(row.map(|row| Caller {
            tenant_id: row.get(0),
            key_id: row.get(1),
            scopes: row.get::<_, Vec<String>>(2),
        }))
    }

    /// Restore one tenant-bound session snapshot.
    pub async fn load_session(&self, tenant_id: &str, id: &str) -> Result<Option<(Session, i64)>> {
        let client = self
            .pool
            .get()
            .await
            .context("session database connection")?;
        let row = client
            .query_opt(
                "SELECT state, version FROM moat.sessions WHERE tenant_id = $1 AND id = $2",
                &[&tenant_id, &id],
            )
            .await
            .context("loading session")?;
        row.map(|row| {
            let Json(value): Json<Value> = row.get(0);
            let session = serde_json::from_value(value).context("decoding durable session")?;
            Ok((session, row.get(1)))
        })
        .transpose()
    }

    /// Insert or update a complete session snapshot, and the ledger rows it
    /// implies, in one transaction.
    ///
    /// One transaction, because the two are one fact. The session document
    /// is what this gateway evaluates and the ledger is what every other
    /// session under the tenant counts; a snapshot that committed without
    /// its ledger rows would let the aggregate read low until the next
    /// save, and a payment could be allowed in that gap.
    pub async fn save_session(
        &self,
        tenant_id: &str,
        session: &Session,
        expected_version: Option<i64>,
    ) -> Result<i64> {
        let state = Json(serde_json::to_value(session).context("encoding session")?);
        let mut client = self
            .pool
            .get()
            .await
            .context("session database connection")?;
        let tx = client
            .transaction()
            .await
            .context("opening session transaction")?;
        let row = match expected_version {
            Some(version) => tx
                .query_opt(
                    "UPDATE moat.sessions
                         SET state = $3, version = version + 1, updated_at = now()
                         WHERE tenant_id = $1 AND id = $2 AND version = $4
                         RETURNING version",
                    &[&tenant_id, &session.id, &state, &version],
                )
                .await
                .context("updating session")?,
            None => tx
                .query_opt(
                    "INSERT INTO moat.sessions (tenant_id, id, state)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (tenant_id, id) DO NOTHING
                         RETURNING version",
                    &[&tenant_id, &session.id, &state],
                )
                .await
                .context("creating session")?,
        };
        let row = row.ok_or_else(|| {
            anyhow::anyhow!(
                "session version conflict for tenant {tenant_id}; reload before retrying"
            )
        })?;
        let version: i64 = row.get(0);
        if !session.payment_authorizations().is_empty() {
            write_payment_ledger(&tx, tenant_id, session).await?;
        }
        tx.commit().await.context("committing session")?;
        Ok(version)
    }

    /// Record that a session was ended by its client. The row stays for
    /// audit; what changes is that no listener brings it back as a live
    /// session. Returns whether a live session was there to end.
    pub async fn end_session(&self, tenant_id: &str, id: &str) -> Result<bool> {
        let client = self
            .pool
            .get()
            .await
            .context("session database connection")?;
        let ended = client
            .execute(
                "UPDATE moat.sessions SET ended_at = now(), updated_at = now()
                 WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL",
                &[&tenant_id, &id],
            )
            .await
            .context("ending session")?;
        Ok(ended > 0)
    }

    /// Whether a session was ended by its client, in this process or another.
    pub async fn session_ended(&self, tenant_id: &str, id: &str) -> Result<bool> {
        let client = self
            .pool
            .get()
            .await
            .context("session database connection")?;
        let row = client
            .query_opt(
                "SELECT ended_at IS NOT NULL FROM moat.sessions WHERE tenant_id = $1 AND id = $2",
                &[&tenant_id, &id],
            )
            .await
            .context("checking whether the session ended")?;
        Ok(row.is_some_and(|row| row.get::<_, bool>(0)))
    }

    /// Persist one signed evidence record alongside its JSONL copy.
    pub async fn save_evidence(
        &self,
        tenant_id: &str,
        session_id: &str,
        record: &Record,
    ) -> Result<()> {
        let value = Json(serde_json::to_value(record).context("encoding evidence record")?);
        let client = self
            .pool
            .get()
            .await
            .context("evidence database connection")?;
        client
            .execute(
                "INSERT INTO moat.evidence_records
                    (tenant_id, session_id, evidence_id, record)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (tenant_id, evidence_id) DO NOTHING",
                &[&tenant_id, &session_id, &record.id, &value],
            )
            .await
            .context("saving evidence record")?;
        Ok(())
    }

    /// Load signed evidence for one tenant session in insertion order.
    pub async fn evidence_for(&self, tenant_id: &str, session_id: &str) -> Result<Vec<Record>> {
        let client = self
            .pool
            .get()
            .await
            .context("evidence database connection")?;
        let rows = client
            .query(
                "SELECT record
                 FROM moat.evidence_records
                 WHERE tenant_id = $1 AND session_id = $2
                 ORDER BY created_at, evidence_id",
                &[&tenant_id, &session_id],
            )
            .await
            .context("loading evidence records")?;
        rows.into_iter()
            .map(|row| {
                let Json(value): Json<Value> = row.get(0);
                serde_json::from_value(value).context("decoding evidence record")
            })
            .collect()
    }

    /// Store a single-use approval token. Only its SHA-256 is retained.
    pub async fn save_resume(
        &self,
        token_hash: &str,
        tenant_id: &str,
        session_id: &str,
        pending: &Value,
        ttl_seconds: i64,
    ) -> Result<()> {
        let pending = Json(pending.clone());
        let client = self
            .pool
            .get()
            .await
            .context("resume database connection")?;
        client
            .execute(
                "INSERT INTO moat.resume_tokens
                    (token_hash, tenant_id, session_id, pending, expires_at)
                 VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 second'))",
                &[&token_hash, &tenant_id, &session_id, &pending, &ttl_seconds],
            )
            .await
            .context("saving resume token")?;
        Ok(())
    }

    /// Atomically consume an unexpired token belonging to this tenant/session.
    pub async fn take_resume(
        &self,
        token_hash: &str,
        tenant_id: &str,
        session_id: &str,
    ) -> Result<Option<Value>> {
        let client = self
            .pool
            .get()
            .await
            .context("resume database connection")?;
        let row = client
            .query_opt(
                "UPDATE moat.resume_tokens
                 SET consumed_at = now()
                 WHERE token_hash = $1
                   AND tenant_id = $2
                   AND session_id = $3
                   AND consumed_at IS NULL
                   AND expires_at > now()
                 RETURNING pending",
                &[&token_hash, &tenant_id, &session_id],
            )
            .await
            .context("consuming resume token")?;
        Ok(row.map(|row| {
            let Json(value): Json<Value> = row.get(0);
            value
        }))
    }

    // ---- the control plane (migration 0005) ----
    //
    // Issuing and withdrawing credentials, so a tenant is not waiting on
    // somebody with root to run a shell script. Every call here is already
    // scoped to a tenant the caller authenticated as; none of these queries
    // takes a tenant id the caller chose.

    /// Record a new key. Only its SHA-256 is stored; the raw key is the
    /// caller's to hand over once and then forget.
    pub async fn create_api_key(
        &self,
        tenant_id: &str,
        label: &str,
        access_role: &str,
        key_hash: &str,
        created_by: Option<&str>,
        scopes: &[String],
    ) -> Result<ApiKey> {
        let client = self.pool.get().await.context("key database connection")?;
        let row = client
            .query_one(
                concat!(
                    "INSERT INTO moat.api_keys
                         (id, tenant_id, label, key_hash, access_role, created_by, scopes)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING ",
                    api_key_columns!()
                ),
                &[
                    &new_key_id(),
                    &tenant_id,
                    &label,
                    &key_hash,
                    &access_role,
                    &created_by,
                    &scopes,
                ],
            )
            .await
            .context("creating API key")?;
        Ok(ApiKey::from_row(&row))
    }

    /// What this tenant's agents have been doing, counted by decision.
    ///
    /// Reads the evidence table rather than a counter kept alongside it. A
    /// counter can disagree with the record; a count of the record cannot.
    pub async fn usage_for(&self, tenant_id: &str) -> Result<Usage> {
        let client = self.pool.get().await.context("usage connection")?;
        let rows = client
            .query(
                "SELECT COALESCE(record->>'verdict', 'unknown') AS verdict,
                        count(*)::bigint AS total,
                        count(*) FILTER (
                            WHERE created_at > now() - interval '7 days'
                        )::bigint AS week
                 FROM moat.evidence_records
                 WHERE tenant_id = $1
                 GROUP BY 1",
                &[&tenant_id],
            )
            .await
            .context("counting usage")?;

        let mut usage = Usage::default();
        for row in &rows {
            let verdict: String = row.get("verdict");
            let total: i64 = row.get("total");
            let week: i64 = row.get("week");
            usage.total += total;
            usage.week += week;
            match verdict.as_str() {
                "allow" => usage.allow = total,
                "step_up" => usage.step_up = total,
                "deny" => usage.deny = total,
                _ => usage.other += total,
            }
        }

        let row = client
            .query_one(
                "SELECT count(DISTINCT session_id)::bigint AS sessions,
                        max(created_at) AS last_at
                 FROM moat.evidence_records
                 WHERE tenant_id = $1",
                &[&tenant_id],
            )
            .await
            .context("counting sessions")?;
        usage.sessions = row.get("sessions");
        usage.last_at = stamp(row.get::<_, Option<SystemTime>>("last_at"));
        Ok(usage)
    }

    /// The most recent verdicts for this tenant, newest first.
    ///
    /// Returns the fields a feed shows, not the whole signed record: the full
    /// record is what the evidence endpoint is for, and putting a hundred of
    /// them through a dashboard would move megabytes to render a list.
    pub async fn recent_verdicts(&self, tenant_id: &str, limit: i64) -> Result<Vec<Verdict>> {
        let client = self.pool.get().await.context("verdict connection")?;
        let rows = client
            .query(
                "SELECT evidence_id, created_at, session_id,
                        record->>'verdict'            AS verdict,
                        record->>'rail'               AS rail,
                        record#>>'{call,tool}'        AS tool,
                        record#>>'{call,args,payee}'  AS payee,
                        record#>>'{call,args,amount}' AS amount,
                        record#>>'{call,args,currency}' AS currency,
                        record#>>'{provenance,payee,source,kind}' AS payee_source,
                        (SELECT string_agg(r->>'id', ', ')
                         FROM jsonb_array_elements(
                                COALESCE(record->'rules', '[]'::jsonb)) AS r
                         WHERE r->>'passed' = 'false') AS failed
                 FROM moat.evidence_records
                 WHERE tenant_id = $1
                 ORDER BY created_at DESC, evidence_id DESC
                 LIMIT $2",
                &[&tenant_id, &limit],
            )
            .await
            .context("loading recent verdicts")?;

        Ok(rows
            .iter()
            .map(|row| Verdict {
                evidence_id: row.get("evidence_id"),
                at: stamp(Some(row.get::<_, SystemTime>("created_at"))).unwrap_or_default(),
                session_id: row.get("session_id"),
                verdict: row.get::<_, Option<String>>("verdict").unwrap_or_default(),
                rail: row.get("rail"),
                tool: row.get("tool"),
                payee: row.get("payee"),
                amount: row.get("amount"),
                currency: row.get("currency"),
                payee_source: row.get("payee_source"),
                failed_rules: row.get("failed"),
            })
            .collect())
    }

    /// Create a tenant and its first `admin` key in one transaction, so a
    /// signup that fails halfway leaves no tenant nobody can reach.
    ///
    /// The id is the caller's, checked against the table's own pattern before
    /// it gets here. A collision is an ordinary outcome, not an error: two
    /// people will want the same name, and the second one needs to be told so
    /// rather than shown a database message.
    pub async fn create_tenant(
        &self,
        id: &str,
        name: &str,
        key_hash: &str,
    ) -> Result<Option<ApiKey>> {
        let mut client = self.pool.get().await.context("signup connection")?;
        let tx = client.transaction().await.context("signup transaction")?;

        let inserted = tx
            .query_opt(
                "INSERT INTO moat.tenants (id, name) VALUES ($1, $2)
                 ON CONFLICT (id) DO NOTHING
                 RETURNING id",
                &[&id, &name],
            )
            .await
            .context("creating tenant")?;
        if inserted.is_none() {
            return Ok(None);
        }

        let row = tx
            .query_one(
                concat!(
                    "INSERT INTO moat.api_keys
                         (id, tenant_id, label, key_hash, access_role)
                     VALUES ($1, $2, 'first admin key', $3, 'admin')
                     RETURNING ",
                    api_key_columns!()
                ),
                &[&new_key_id(), &id, &key_hash],
            )
            .await
            .context("creating the first admin key")?;

        // Read the row before committing, not after.
        //
        // The secret for this key exists only in the caller's memory: the
        // database has a hash. So anything that fails between the commit and
        // the reply leaves a tenant with an admin key nobody holds, and the id
        // is taken, so they cannot even sign up again. That is exactly what
        // happened when from_row panicked on a column the RETURNING clause had
        // stopped carrying.
        //
        // Built first, the same failure rolls the transaction back and the
        // caller gets an error and an id they can still use.
        let key = ApiKey::from_row(&row);
        tx.commit().await.context("committing signup")?;
        Ok(Some(key))
    }

    /// Every key this tenant has, newest first, revoked ones included. A
    /// credential that was withdrawn is part of the record, not a gap in it.
    pub async fn list_api_keys(&self, tenant_id: &str) -> Result<Vec<ApiKey>> {
        let client = self.pool.get().await.context("key database connection")?;
        let rows = client
            .query(
                concat!(
                    "SELECT ",
                    api_key_columns!(),
                    " FROM moat.api_keys
                     WHERE tenant_id = $1
                     ORDER BY created_at DESC"
                ),
                &[&tenant_id],
            )
            .await
            .context("listing API keys")?;
        Ok(rows.iter().map(ApiKey::from_row).collect())
    }

    /// Withdraw one key. Returns the key as it now stands, or `None` when
    /// this tenant has no such key — the same answer either way, so probing
    /// for another tenant's key ids tells the prober nothing.
    ///
    /// Revoking an already-revoked key is not an error and does not move
    /// `revoked_at`: the first withdrawal is the one that happened.
    pub async fn revoke_api_key(&self, tenant_id: &str, id: &str) -> Result<Option<ApiKey>> {
        let client = self.pool.get().await.context("key database connection")?;
        let row = client
            .query_opt(
                concat!(
                    "UPDATE moat.api_keys
                     SET active = false,
                         revoked_at = COALESCE(revoked_at, now())
                     WHERE tenant_id = $1 AND id = $2
                     RETURNING ",
                    api_key_columns!()
                ),
                &[&tenant_id, &id],
            )
            .await
            .context("revoking API key")?;
        Ok(row.as_ref().map(ApiKey::from_row))
    }
}

/// What a tenant's agents have done, counted from the evidence itself.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Usage {
    /// Every verdict ever recorded for this tenant.
    pub total: i64,
    /// Of those, the ones in the last seven days.
    pub week: i64,
    /// Forwarded to the provider.
    pub allow: i64,
    /// Held for a person.
    pub step_up: i64,
    /// Refused.
    pub deny: i64,
    /// Anything a future verdict kind adds, so a new one is visible in the
    /// total rather than silently dropped.
    pub other: i64,
    /// Distinct agent sessions seen.
    pub sessions: i64,
    /// When the most recent verdict was recorded.
    pub last_at: Option<String>,
}

/// One line of the verdict feed. A summary of a signed record, not the record.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Verdict {
    /// Ties the line back to the full signed record.
    pub evidence_id: String,
    /// RFC 3339.
    pub at: String,
    /// Which agent session produced it.
    pub session_id: String,
    /// `allow`, `step_up` or `deny`.
    pub verdict: String,
    /// Which settlement rail, when the record names one.
    pub rail: Option<String>,
    /// The tool that was called.
    pub tool: Option<String>,
    /// Who was going to be paid.
    pub payee: Option<String>,
    /// How much, as the call stated it.
    pub amount: Option<String>,
    /// In what.
    pub currency: Option<String>,
    /// Where the payee came from: `user`, `tool_result`, `allowlist`,
    /// `unknown`. The single most useful field on the line.
    pub payee_source: Option<String>,
    /// The rules that did not pass, comma separated. `None` when all passed.
    pub failed_rules: Option<String>,
}

/// A key as the control plane reports it. Never carries the key itself.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ApiKey {
    /// Stable identifier, safe to log and to put in a URL.
    pub id: String,
    /// Whatever the tenant called it.
    pub label: String,
    /// `agent`, `approver` or `admin`.
    pub access_role: String,
    /// False once withdrawn.
    pub active: bool,
    /// When it was minted, RFC 3339.
    pub created_at: String,
    /// When it last authenticated, if ever.
    pub last_used_at: Option<String>,
    /// When it was withdrawn, if it was.
    pub revoked_at: Option<String>,
    /// What the key may do within its role. Empty means the whole role.
    pub scopes: Vec<String>,
}

/// Who is making a request: the tenant they belong to, which key it was, and
/// what that key is allowed to do inside its role.
///
/// The role has already been checked by the time this exists. Scopes narrow
/// what is left, and an empty list means nothing was narrowed.
#[derive(Debug, Clone)]
pub struct Caller {
    /// The tenant every read and write is confined to.
    pub tenant_id: String,
    /// The key that authenticated, for attribution and for refusing to let a
    /// key withdraw itself.
    pub key_id: String,
    /// Empty for a key that carries the whole of its role.
    pub scopes: Vec<String>,
}

impl Caller {
    /// Whether this key carries `scope`. A key with no scopes carries them all,
    /// which is what every key minted before scopes existed has.
    #[must_use]
    pub fn may(&self, scope: &str) -> bool {
        self.scopes.is_empty() || self.scopes.iter().any(|held| held == scope)
    }
}

impl ApiKey {
    fn from_row(row: &tokio_postgres::Row) -> Self {
        Self {
            id: row.get("id"),
            label: row.get("label"),
            access_role: row.get("access_role"),
            active: row.get("active"),
            created_at: stamp(Some(row.get::<_, SystemTime>("created_at"))).unwrap_or_default(),
            last_used_at: stamp(row.get::<_, Option<SystemTime>>("last_used_at")),
            revoked_at: stamp(row.get::<_, Option<SystemTime>>("revoked_at")),
            scopes: row.get::<_, Vec<String>>("scopes"),
        }
    }
}

fn new_key_id() -> String {
    let random: [u8; 16] = rand::random();
    format!("key_{}", &moat_core::hash::sha256_hex(&random)[..24])
}

/// A database timestamp in the same RFC 3339 shape the evidence records use,
/// so a key's dates and a verdict's date can be compared without parsing two
/// formats. `None` in, `None` out: a key that has never authenticated has no
/// `last_used_at` and should not be given a fabricated one.
fn stamp(value: Option<SystemTime>) -> Option<String> {
    let ms = value?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()?;
    Some(moat_core::evidence::rfc3339(ms))
}

// ---- the payment ledger (migration 0003) ----
//
// Authorizations, outcomes and reservations as rows keyed by tenant rather
// than by session, so a mandate can outlive the conversation that created
// it and an aggregate can be enforced across concurrent sessions. The
// session document keeps what only it needs; this keeps what has to be
// counted.
//
// Amounts cross the wire as text. `numeric(39,0)` holds a u128 and there is
// no Rust type tokio-postgres maps it to, so every read casts to text and
// every write casts from it. Going through i64 would silently lose an
// eighteen-decimal token above about 9.2 units, and going through f64 in a
// ledger would be indefensible.
//
// The write cast is `$n::text::numeric`, not `$n::numeric`, and the
// difference is the whole thing working. A bare `$n::numeric` makes
// Postgres infer the parameter's type as numeric, and tokio-postgres then
// refuses to send a String for it. Naming `text` first fixes the inferred
// type at the one thing we can serialize, and the second cast converts it
// server-side.

/// Upsert a session's authorizations and outcomes, and replace its
/// reservations, inside `tx`.
///
/// Upserts rather than replaces: another session under the same tenant may
/// have written rows for the same authorization, and this one's snapshot is
/// not entitled to delete them. Reservations that this session no longer
/// holds are removed, because a reservation is a claim about right now and a
/// stale one blocks a payment nobody is making. One this session still holds
/// but has outlived [`moat_core::session::RESERVATION_MAX_AGE_MS`] is not
/// written back for the same reason.
async fn write_payment_ledger(
    tx: &tokio_postgres::Transaction<'_>,
    tenant_id: &str,
    session: &Session,
) -> Result<()> {
    for authorization in session.payment_authorizations() {
        let body = Json(serde_json::to_value(authorization).context("encoding authorization")?);
        tx.execute(
            "INSERT INTO moat.payment_authorizations (
                 tenant_id, id, origin_session_id, payee, destination, network,
                 asset_contract, currency, amount_minor, tolerance_minor,
                 aggregate_limit_minor, invoice_id, invoice_fingerprint,
                 require_invoice_fingerprint, repeat_payments, max_payments,
                 expires_unix_ms, cancelled, body
             ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9::text::numeric, $10::text::numeric,
                 $11::text::numeric, $12, $13, $14, $15, $16, $17, $18, $19
             )
             ON CONFLICT (tenant_id, id) DO UPDATE SET
                 cancelled = moat.payment_authorizations.cancelled OR EXCLUDED.cancelled,
                 body = EXCLUDED.body,
                 updated_at = now()",
            &[
                &tenant_id,
                &authorization.id,
                &session.id,
                &authorization.payee,
                &authorization.recipient_account_id,
                &authorization.network,
                &authorization.asset_contract,
                &authorization.currency,
                &authorization.amount_minor.0.to_string(),
                &authorization.tolerance_minor.0.to_string(),
                &authorization
                    .aggregate_limit_minor
                    .map(|limit| limit.0.to_string()),
                &authorization.invoice_id,
                &authorization.invoice_fingerprint,
                &authorization.require_invoice_fingerprint,
                &authorization.repeat_payments,
                &i32::try_from(authorization.max_payments).unwrap_or(i32::MAX),
                &i64::try_from(authorization.expires_unix_ms).unwrap_or(i64::MAX),
                &authorization.cancelled,
                &body,
            ],
        )
        .await
        .with_context(|| format!("saving authorization {}", authorization.id))?;
    }

    for outcome in session.payment_outcomes() {
        let body = Json(serde_json::to_value(outcome).context("encoding outcome")?);
        tx.execute(
            "INSERT INTO moat.payment_outcomes (
                 tenant_id, evidence_id, authorization_id, session_id, rail, provider,
                 invoice_id, status, status_kind, committed, terminal, quarantined,
                 amount_minor, receipt, body
             ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::numeric, $14, $15
             )
             ON CONFLICT (tenant_id, evidence_id) DO UPDATE SET
                 status = EXCLUDED.status,
                 status_kind = EXCLUDED.status_kind,
                 committed = EXCLUDED.committed,
                 terminal = EXCLUDED.terminal,
                 quarantined = EXCLUDED.quarantined,
                 receipt = COALESCE(EXCLUDED.receipt, moat.payment_outcomes.receipt),
                 body = EXCLUDED.body,
                 updated_at = now()",
            &[
                &tenant_id,
                &outcome.evidence_id,
                &outcome.authorization_id,
                &session.id,
                &outcome.rail.as_str(),
                &outcome.provider,
                &outcome.invoice_id,
                &outcome.status,
                &outcome.status_kind.as_str(),
                &outcome.committed,
                &outcome.status_kind.terminal(),
                &outcome.quarantined,
                &outcome.amount_minor.0.to_string(),
                &outcome.receipt,
                &body,
            ],
        )
        .await
        .with_context(|| format!("saving outcome {}", outcome.evidence_id))?;
    }

    // This session's reservations, and only this session's: a claim
    // that a payment is in flight belongs to the process making it.
    tx.execute(
        "DELETE FROM moat.payment_reservations WHERE tenant_id = $1 AND session_id = $2",
        &[&tenant_id, &session.id],
    )
    .await
    .context("clearing stale reservations")?;
    let now_unix_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    for reservation in session
        .payment_reservations()
        .iter()
        .filter(|reservation| !reservation.is_stale(now_unix_ms))
    {
        tx.execute(
            "INSERT INTO moat.payment_reservations (
                 tenant_id, fingerprint, authorization_id, session_id, amount_minor
             ) VALUES ($1, $2, $3, $4, $5::text::numeric)
             ON CONFLICT (tenant_id, fingerprint) DO NOTHING",
            &[
                &tenant_id,
                &reservation.fingerprint,
                &reservation.authorization_id,
                &session.id,
                &reservation.amount_minor.0.to_string(),
            ],
        )
        .await
        .context("saving reservation")?;
    }

    Ok(())
}

/// A `Minor` from a `numeric` column returned as text.
fn minor_from_text(text: &str) -> Result<Minor> {
    text.trim()
        .parse::<u128>()
        .map(Minor)
        .with_context(|| format!("reading {text:?} as a minor-unit amount"))
}

/// What an authorization has spent and is holding, right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Aggregate {
    /// Committed and not reversed, across every session.
    pub committed: Minor,
    /// Held by proposals in flight, across every session.
    pub reserved: Minor,
    /// How many committed payments have been made.
    pub payments: u32,
}

impl Aggregate {
    /// Everything the mandate is already answerable for.
    pub fn total(self) -> Minor {
        self.committed.saturating_add(self.reserved)
    }
}

impl DurableStore {
    /// Write a session's authorizations, outcomes and reservations to the
    /// ledger, in a transaction of their own.
    ///
    /// [`DurableStore::save_session`] writes the same rows inside the
    /// session's transaction, which is the path a running gateway takes.
    /// This is for writing the ledger without a session snapshot.
    #[cfg(test)]
    pub async fn save_payment_ledger(&self, tenant_id: &str, session: &Session) -> Result<()> {
        let mut client = self
            .pool
            .get()
            .await
            .context("payment ledger database connection")?;
        let tx = client
            .transaction()
            .await
            .context("opening payment ledger transaction")?;
        write_payment_ledger(&tx, tenant_id, session).await?;
        tx.commit().await.context("committing payment ledger")?;
        Ok(())
    }

    /// Delete every reservation older than
    /// [`moat_core::session::RESERVATION_MAX_AGE_MS`], across every tenant.
    /// Returns how many were deleted.
    ///
    /// A session releases its own reservations when their payments settle
    /// and drops the ones it finds abandoned. A session that died mid-payment
    /// does neither, and its rows would hold value against the mandate for
    /// every other session until somebody noticed. This is the somebody.
    pub async fn expire_reservations(&self) -> Result<u64> {
        let client = self
            .pool
            .get()
            .await
            .context("reservation database connection")?;
        let max_age_ms =
            i64::try_from(moat_core::session::RESERVATION_MAX_AGE_MS).unwrap_or(i64::MAX);
        client
            .execute(
                "DELETE FROM moat.payment_reservations
                 WHERE created_at < now() - ($1::bigint * interval '1 millisecond')",
                &[&max_age_ms],
            )
            .await
            .context("expiring abandoned reservations")
    }

    /// An authorization from the ledger, whatever session registered it.
    ///
    /// This is what makes a mandate outlive its conversation. The gateway
    /// looks in the live session first and comes here second, so a running
    /// session is never slowed down and a new one can still find the
    /// mandate the last one was given.
    pub async fn payment_authorization(
        &self,
        tenant_id: &str,
        id: &str,
    ) -> Result<Option<PaymentAuthorization>> {
        let client = self
            .pool
            .get()
            .await
            .context("authorization database connection")?;
        let row = client
            .query_opt(
                "SELECT body FROM moat.payment_authorizations
                 WHERE tenant_id = $1 AND id = $2",
                &[&tenant_id, &id],
            )
            .await
            .context("loading authorization")?;
        match row {
            Some(row) => {
                let Json(body): Json<Value> = row.get(0);
                Ok(Some(
                    serde_json::from_value(body).context("decoding authorization")?,
                ))
            }
            None => Ok(None),
        }
    }

    /// What an authorization has spent and is holding across every session.
    pub async fn aggregate_for(
        &self,
        tenant_id: &str,
        authorization_id: &str,
    ) -> Result<Aggregate> {
        let client = self
            .pool
            .get()
            .await
            .context("aggregate database connection")?;
        let row = client
            .query_one(
                "SELECT
                     COALESCE((SELECT sum(amount_minor) FROM moat.payment_outcomes
                               WHERE tenant_id = $1 AND authorization_id = $2 AND committed), 0)::text,
                     COALESCE((SELECT count(*) FROM moat.payment_outcomes
                               WHERE tenant_id = $1 AND authorization_id = $2 AND committed), 0),
                     COALESCE((SELECT sum(amount_minor) FROM moat.payment_reservations
                               WHERE tenant_id = $1 AND authorization_id = $2), 0)::text",
                &[&tenant_id, &authorization_id],
            )
            .await
            .context("reading aggregate")?;
        let committed: String = row.get(0);
        let payments: i64 = row.get(1);
        let reserved: String = row.get(2);
        Ok(Aggregate {
            committed: minor_from_text(&committed)?,
            payments: u32::try_from(payments).unwrap_or(u32::MAX),
            reserved: minor_from_text(&reserved)?,
        })
    }

    /// Take a reservation if, and only if, the mandate still has room.
    ///
    /// The whole point is that this is one statement under one row lock.
    /// Two sessions reading their own aggregates and then deciding
    /// separately will both decide yes; two sessions queueing on
    /// `SELECT ... FOR UPDATE` against the authorization row cannot. The
    /// check and the write have to happen inside that lock or the lock buys
    /// nothing.
    ///
    /// Returns the aggregate as it stood *before* this reservation, so the
    /// caller can say what the limit was measured against, or `None` when
    /// there was no room or the fingerprint was already held.
    pub async fn reserve_if_within(
        &self,
        tenant_id: &str,
        authorization_id: &str,
        fingerprint: &str,
        session_id: &str,
        amount: Minor,
        limit: Minor,
    ) -> Result<Option<Aggregate>> {
        let mut client = self
            .pool
            .get()
            .await
            .context("reservation database connection")?;
        let tx = client
            .transaction()
            .await
            .context("opening reservation transaction")?;

        // Serialises every concurrent proposal under this mandate.
        let locked = tx
            .query_opt(
                "SELECT cancelled FROM moat.payment_authorizations
                 WHERE tenant_id = $1 AND id = $2
                 FOR UPDATE",
                &[&tenant_id, &authorization_id],
            )
            .await
            .context("locking authorization")?;
        let Some(locked) = locked else {
            return Ok(None);
        };
        let cancelled: bool = locked.get(0);
        if cancelled {
            return Ok(None);
        }

        let row = tx
            .query_one(
                "SELECT
                     COALESCE((SELECT sum(amount_minor) FROM moat.payment_outcomes
                               WHERE tenant_id = $1 AND authorization_id = $2 AND committed), 0)::text,
                     COALESCE((SELECT count(*) FROM moat.payment_outcomes
                               WHERE tenant_id = $1 AND authorization_id = $2 AND committed), 0),
                     COALESCE((SELECT sum(amount_minor) FROM moat.payment_reservations
                               WHERE tenant_id = $1 AND authorization_id = $2), 0)::text",
                &[&tenant_id, &authorization_id],
            )
            .await
            .context("reading aggregate under lock")?;
        let committed: String = row.get(0);
        let payments: i64 = row.get(1);
        let reserved: String = row.get(2);
        let before = Aggregate {
            committed: minor_from_text(&committed)?,
            payments: u32::try_from(payments).unwrap_or(u32::MAX),
            reserved: minor_from_text(&reserved)?,
        };
        if before.total().saturating_add(amount).0 > limit.0 {
            // Rolled back by dropping the transaction: nothing was written.
            return Ok(None);
        }

        let inserted = tx
            .execute(
                "INSERT INTO moat.payment_reservations (
                     tenant_id, fingerprint, authorization_id, session_id, amount_minor
                 ) VALUES ($1, $2, $3, $4, $5::text::numeric)
                 ON CONFLICT (tenant_id, fingerprint) DO NOTHING",
                &[
                    &tenant_id,
                    &fingerprint,
                    &authorization_id,
                    &session_id,
                    &amount.0.to_string(),
                ],
            )
            .await
            .context("taking reservation")?;
        if inserted == 0 {
            // An identical payment is already in flight. Not an error, and
            // not a reservation either.
            return Ok(None);
        }
        tx.commit().await.context("committing reservation")?;
        Ok(Some(before))
    }

    /// Release a reservation by fingerprint. Absent is not an error.
    pub async fn release_reservation(&self, tenant_id: &str, fingerprint: &str) -> Result<()> {
        let client = self
            .pool
            .get()
            .await
            .context("reservation database connection")?;
        client
            .execute(
                "DELETE FROM moat.payment_reservations WHERE tenant_id = $1 AND fingerprint = $2",
                &[&tenant_id, &fingerprint],
            )
            .await
            .context("releasing reservation")?;
        Ok(())
    }

    /// Everything an operator has to clear by hand: quarantined, or not yet
    /// terminal, across every session of the tenant.
    pub async fn open_outcomes(&self, tenant_id: &str, limit: i64) -> Result<Vec<Value>> {
        let client = self
            .pool
            .get()
            .await
            .context("outcomes database connection")?;
        let rows = client
            .query(
                "SELECT body FROM moat.payment_outcomes
                 WHERE tenant_id = $1 AND (quarantined OR NOT terminal)
                 ORDER BY updated_at DESC
                 LIMIT $2",
                &[&tenant_id, &limit],
            )
            .await
            .context("listing open outcomes")?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let Json(body): Json<Value> = row.get(0);
                body
            })
            .collect())
    }
}

#[cfg(test)]
mod ledger_tests {
    /// The payment ledger, against a real PostgreSQL.
    ///
    /// Skipped unless `MOAT_TEST_DATABASE_URL` names a database with migration
    /// 3 applied, so `cargo test` stays green on a machine with no database and
    /// CI needs no service. Point it at a scratch database, never a production
    /// one: these tests create a tenant, write rows and delete them again.
    ///
    ///   MOAT_TEST_DATABASE_URL=postgres://... cargo test -p moat-gateway ledger_tests
    ///
    /// The role in that URL needs to reach the `moat` schema and insert into
    /// `moat.tenants`; `moat_migrator` does not, which is what broke the deploy
    /// script, so use an owner or superuser connection.
    ///
    /// What is worth testing here is not that a row round-trips. It is the two
    /// things the ledger exists for and that no unit test can reach:
    ///
    ///   the aggregate counts committed payments and open reservations across
    ///   sessions, and a reversal stops counting;
    ///
    ///   and two sessions racing the same mandate cannot both be granted it,
    ///   because the check and the write happen inside one row lock. That one
    ///   is the reason the tables exist at all, and it is exactly the bug that
    ///   a single-process test would never see.
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Run one statement against the test database.
    async fn exec(
        store: &DurableStore,
        sql: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) {
        let client = store.pool.get().await.expect("test connection");
        client
            .execute(sql, params)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    use ::moat_core::money::Minor;
    use ::moat_core::outcome::OutcomeStatus;
    use ::moat_core::rail::Rail;
    use ::moat_core::session::{PaymentAuthorization, PaymentOutcome, PaymentReservation, Session};

    /// The database to test against, or `None` to skip.
    fn database_url() -> Option<String> {
        let url = std::env::var("MOAT_TEST_DATABASE_URL").ok()?;
        let url = url.trim().to_owned();
        if url.is_empty() {
            return None;
        }
        Some(url)
    }

    macro_rules! store_or_skip {
        () => {
            match database_url() {
                Some(url) => DurableStore::connect(&url, 8)
                    .await
                    .expect("connecting to MOAT_TEST_DATABASE_URL"),
                None => {
                    eprintln!("skipped: set MOAT_TEST_DATABASE_URL to run the ledger tests");
                    return;
                }
            }
        };
    }

    fn unique(prefix: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        format!("{prefix}-{nanos}")
    }

    fn now_ms() -> u64 {
        u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_millis(),
        )
        .expect("fits")
    }

    fn reservation(fingerprint: &str, amount: u128, reserved_unix_ms: u64) -> PaymentReservation {
        PaymentReservation {
            fingerprint: fingerprint.to_owned(),
            authorization_id: "auth-age".to_owned(),
            invoice_id: "INV-auth-age".to_owned(),
            invoice_fingerprint: None,
            amount_minor: Minor(amount),
            reserved_unix_ms,
        }
    }

    /// A tenant of our own, so a test never touches another's rows.
    async fn tenant(store: &DurableStore, id: &str) {
        exec(
            store,
            "INSERT INTO moat.tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
            &[&id, &"ledger test"],
        )
        .await;
    }

    /// Remove everything this test wrote, in foreign-key order.
    async fn cleanup(store: &DurableStore, id: &str) {
        for sql in [
            "DELETE FROM moat.payment_reservations WHERE tenant_id = $1",
            "DELETE FROM moat.payment_outcomes WHERE tenant_id = $1",
            "DELETE FROM moat.payment_authorizations WHERE tenant_id = $1",
            "DELETE FROM moat.sessions WHERE tenant_id = $1",
            "DELETE FROM moat.tenants WHERE id = $1",
        ] {
            exec(store, sql, &[&id]).await;
        }
    }

    fn authorization(id: &str, amount: u128, aggregate: Option<u128>) -> PaymentAuthorization {
        PaymentAuthorization {
            id: id.to_owned(),
            payee: Some("Monitoring Pro Inc".into()),
            recipient_account_id: Some("acct_supplier_001".into()),
            amount_minor: Minor(amount),
            tolerance_minor: Minor(0),
            currency: "USD".into(),
            network: None,
            asset_contract: None,
            invoice_id: Some(format!("INV-{id}")),
            invoice_fingerprint: None,
            require_invoice_fingerprint: false,
            aggregate_limit_minor: aggregate.map(Minor),
            expires_unix_ms: 4_000_000_000_000,
            repeat_payments: true,
            max_payments: 10,
            cancelled: false,
        }
    }

    fn outcome(
        evidence_id: &str,
        authorization_id: &str,
        amount: u128,
        kind: OutcomeStatus,
    ) -> PaymentOutcome {
        PaymentOutcome {
            authorization_id: authorization_id.to_owned(),
            invoice_id: format!("INV-{authorization_id}"),
            amount_minor: Minor(amount),
            evidence_id: evidence_id.to_owned(),
            provider: "stripe".into(),
            receipt: Some(unique("rcpt")),
            status: format!("{kind:?}").to_lowercase(),
            succeeded: kind == OutcomeStatus::Succeeded,
            status_kind: kind,
            invoice_fingerprint: None,
            committed: !matches!(kind, OutcomeStatus::Failed | OutcomeStatus::Reversed),
            quarantined: false,
            rail: Rail::Card,
            unix_ms: 1_700_000_000_000,
            reconciled_unix_ms: None,
        }
    }

    /// A mandate registered in one session is found from another.
    ///
    /// The whole reason the tables exist: before them, reconnecting lost the
    /// mandate, so every long-lived agreement had to be re-granted.
    #[tokio::test]
    async fn an_authorization_outlives_the_session_that_registered_it() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        session
            .register_payment_authorization(authorization("auth-outlives", 50_000, None))
            .expect("registering");
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving the ledger");

        // A different session, which has never seen this mandate.
        let found = store
            .payment_authorization(&id, "auth-outlives")
            .await
            .expect("reading back")
            .expect("the mandate should be in the ledger");
        assert_eq!(found.payee.as_deref(), Some("Monitoring Pro Inc"));
        assert_eq!(found.amount_minor, Minor(50_000));
        assert_eq!(
            found.recipient_account_id.as_deref(),
            Some("acct_supplier_001")
        );

        assert!(store
            .payment_authorization(&id, "auth-never-registered")
            .await
            .expect("reading a missing mandate")
            .is_none());

        cleanup(&store, &id).await;
    }

    /// Committed payments and open reservations both count; a reversal does not.
    #[tokio::test]
    async fn the_aggregate_counts_what_the_mandate_is_answerable_for() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        session
            .register_payment_authorization(authorization("auth-agg", 10_000, Some(100_000)))
            .expect("registering");
        session.record_payment_outcome(outcome(
            "ev-a",
            "auth-agg",
            10_000,
            OutcomeStatus::Succeeded,
        ));
        session.record_payment_outcome(outcome(
            "ev-b",
            "auth-agg",
            30_000,
            OutcomeStatus::Confirmed,
        ));
        // Failed money never moved, so it must not be held against the mandate.
        session.record_payment_outcome(outcome("ev-c", "auth-agg", 70_000, OutcomeStatus::Failed));
        session.reserve_payment(PaymentReservation {
            fingerprint: "fp-open".into(),
            authorization_id: "auth-agg".into(),
            invoice_id: "INV-auth-agg".into(),
            invoice_fingerprint: None,
            amount_minor: Minor(5_000),
            reserved_unix_ms: now_ms(),
        });
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving");

        let aggregate = store
            .aggregate_for(&id, "auth-agg")
            .await
            .expect("aggregate");
        assert_eq!(aggregate.committed, Minor(40_000), "succeeded + confirmed");
        assert_eq!(aggregate.reserved, Minor(5_000), "the open reservation");
        assert_eq!(aggregate.payments, 2, "the failed one is not a payment");
        assert_eq!(aggregate.total(), Minor(45_000));

        cleanup(&store, &id).await;
    }

    /// The path a running gateway takes: the session snapshot and its
    /// ledger rows land together, so nothing can read the one without the
    /// other.
    #[tokio::test]
    async fn saving_a_session_writes_its_ledger_with_it() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        session
            .register_payment_authorization(authorization("auth-with", 10_000, Some(100_000)))
            .expect("registering");
        session.record_payment_outcome(outcome(
            "ev-with",
            "auth-with",
            10_000,
            OutcomeStatus::Succeeded,
        ));
        let version = store
            .save_session(&id, &session, None)
            .await
            .expect("saving");

        assert!(store
            .payment_authorization(&id, "auth-with")
            .await
            .expect("reading")
            .is_some());
        let aggregate = store
            .aggregate_for(&id, "auth-with")
            .await
            .expect("aggregate");
        assert_eq!(aggregate.committed, Minor(10_000));
        assert_eq!(aggregate.payments, 1);

        // And the second save, through the optimistic-version path.
        session.record_payment_outcome(outcome(
            "ev-with-2",
            "auth-with",
            20_000,
            OutcomeStatus::Confirmed,
        ));
        store
            .save_session(&id, &session, Some(version))
            .await
            .expect("saving again");
        let aggregate = store
            .aggregate_for(&id, "auth-with")
            .await
            .expect("aggregate");
        assert_eq!(aggregate.committed, Minor(30_000));

        cleanup(&store, &id).await;
    }

    /// A DELETE ends a session for every process, not only the one that saw
    /// it. The row stays, so the evidence and the mandates it holds can still
    /// be read.
    #[tokio::test]
    async fn an_ended_session_stays_ended_for_every_process() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let session = Session::new(unique("s"));
        store
            .save_session(&id, &session, None)
            .await
            .expect("saving");
        assert!(!store
            .session_ended(&id, &session.id)
            .await
            .expect("checking"));
        assert!(store.end_session(&id, &session.id).await.expect("ending"));
        assert!(store
            .session_ended(&id, &session.id)
            .await
            .expect("checking"));
        assert!(
            !store
                .end_session(&id, &session.id)
                .await
                .expect("ending again"),
            "ending twice is not a second end"
        );
        assert!(
            store
                .load_session(&id, &session.id)
                .await
                .expect("loading")
                .is_some(),
            "the row is still there to read"
        );
        assert!(!store
            .session_ended(&id, "never-existed")
            .await
            .expect("checking"));

        cleanup(&store, &id).await;
    }

    /// A reservation a dead process left behind stops counting: the session
    /// that still holds a stale one does not write it back, and the reaper
    /// clears the row of a session that never came back at all.
    #[tokio::test]
    async fn an_abandoned_reservation_stops_holding_value() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        session
            .register_payment_authorization(authorization("auth-age", 10_000, Some(100_000)))
            .expect("registering");
        assert!(session.reserve_payment(reservation("fp-stale", 7_000, 0)));
        assert!(session.reserve_payment(reservation("fp-live", 5_000, now_ms())));
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving");
        let aggregate = store
            .aggregate_for(&id, "auth-age")
            .await
            .expect("aggregate");
        assert_eq!(
            aggregate.reserved,
            Minor(5_000),
            "the stale one was not written"
        );

        // Nothing to reap yet: the live one is fresh.
        store.expire_reservations().await.expect("reaping");
        let aggregate = store
            .aggregate_for(&id, "auth-age")
            .await
            .expect("aggregate");
        assert_eq!(aggregate.reserved, Minor(5_000));

        // The process that held it dies, and time passes.
        exec(
            &store,
            "UPDATE moat.payment_reservations SET created_at = now() - interval '1 day'
             WHERE tenant_id = $1",
            &[&id],
        )
        .await;
        let reaped = store.expire_reservations().await.expect("reaping");
        assert!(reaped >= 1, "ours was among the reaped");
        let aggregate = store
            .aggregate_for(&id, "auth-age")
            .await
            .expect("aggregate");
        assert_eq!(aggregate.reserved, Minor(0));

        cleanup(&store, &id).await;
    }

    /// u128 amounts survive the round trip through `numeric(39,0)`.
    ///
    /// Eighteen decimals in base units leaves `bigint` behind at about 9.2
    /// units, so anything that quietly went through an i64 would truncate here.
    #[tokio::test]
    async fn an_eighteen_decimal_amount_survives_the_database() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        // 1,234.5 ETH in wei.
        let wei = 1_234_500_000_000_000_000_000u128;
        let mut session = Session::new(unique("s"));
        session
            .register_payment_authorization(authorization("auth-wei", wei, Some(wei * 2)))
            .expect("registering");
        session.record_payment_outcome(outcome(
            "ev-wei",
            "auth-wei",
            wei,
            OutcomeStatus::Succeeded,
        ));
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving");

        let found = store
            .payment_authorization(&id, "auth-wei")
            .await
            .expect("reading")
            .expect("present");
        assert_eq!(found.amount_minor, Minor(wei));
        let aggregate = store
            .aggregate_for(&id, "auth-wei")
            .await
            .expect("aggregate");
        assert_eq!(aggregate.committed, Minor(wei));

        cleanup(&store, &id).await;
    }

    /// Two sessions racing one mandate: exactly one gets it.
    ///
    /// This is the test the ledger was built for. Before it, each session read
    /// its own document, each saw the whole allowance unspent, and both spent
    /// it. `reserve_if_within` computes the aggregate and takes the reservation
    /// inside one row lock, so the loser queues and then sees the winner's
    /// reservation.
    #[tokio::test]
    async fn two_sessions_cannot_both_spend_the_same_allowance() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        // Room for one payment of 60, not two.
        session
            .register_payment_authorization(authorization("auth-race", 60_000, Some(100_000)))
            .expect("registering");
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving");

        let limit = Minor(100_000);
        let amount = Minor(60_000);
        let a = {
            let store = store.clone();
            let id = id.clone();
            tokio::spawn(async move {
                store
                    .reserve_if_within(&id, "auth-race", "fp-a", "session-a", amount, limit)
                    .await
            })
        };
        let b = {
            let store = store.clone();
            let id = id.clone();
            tokio::spawn(async move {
                store
                    .reserve_if_within(&id, "auth-race", "fp-b", "session-b", amount, limit)
                    .await
            })
        };
        let a = a.await.expect("task a").expect("query a");
        let b = b.await.expect("task b").expect("query b");

        assert!(
            a.is_some() ^ b.is_some(),
            "exactly one of the two should have been granted; got a={a:?} b={b:?}"
        );

        let aggregate = store
            .aggregate_for(&id, "auth-race")
            .await
            .expect("aggregate");
        assert_eq!(
            aggregate.reserved,
            Minor(60_000),
            "only the winner's reservation is held"
        );

        cleanup(&store, &id).await;
    }

    /// The same payment proposed twice is one reservation, not two.
    #[tokio::test]
    async fn one_fingerprint_is_one_reservation() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        session
            .register_payment_authorization(authorization("auth-dup", 10_000, Some(100_000)))
            .expect("registering");
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving");

        let first = store
            .reserve_if_within(
                &id,
                "auth-dup",
                "fp-same",
                "s1",
                Minor(10_000),
                Minor(100_000),
            )
            .await
            .expect("first");
        let second = store
            .reserve_if_within(
                &id,
                "auth-dup",
                "fp-same",
                "s2",
                Minor(10_000),
                Minor(100_000),
            )
            .await
            .expect("second");
        assert!(first.is_some(), "the first proposal is granted");
        assert!(
            second.is_none(),
            "the identical proposal is not granted twice"
        );
        assert_eq!(
            store
                .aggregate_for(&id, "auth-dup")
                .await
                .expect("aggregate")
                .reserved,
            Minor(10_000)
        );

        store
            .release_reservation(&id, "fp-same")
            .await
            .expect("releasing");
        assert_eq!(
            store
                .aggregate_for(&id, "auth-dup")
                .await
                .expect("aggregate")
                .reserved,
            Minor::ZERO,
            "releasing frees the mandate"
        );

        cleanup(&store, &id).await;
    }

    /// A cancelled mandate grants nothing, whatever room is left in it.
    #[tokio::test]
    async fn a_cancelled_mandate_reserves_nothing() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        let mut cancelled = authorization("auth-cancelled", 10_000, Some(100_000));
        cancelled.cancelled = true;
        session
            .register_payment_authorization(cancelled)
            .expect("registering");
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving");

        let granted = store
            .reserve_if_within(
                &id,
                "auth-cancelled",
                "fp-x",
                "s1",
                Minor(10),
                Minor(100_000),
            )
            .await
            .expect("query");
        assert!(granted.is_none(), "a cancelled mandate is not a mandate");

        cleanup(&store, &id).await;
    }

    /// Quarantined and non-terminal outcomes are what an operator has to clear.
    #[tokio::test]
    async fn open_outcomes_are_the_ones_somebody_has_to_deal_with() {
        let store = store_or_skip!();
        let id = unique("t");
        tenant(&store, &id).await;

        let mut session = Session::new(unique("s"));
        session
            .register_payment_authorization(authorization("auth-open", 10_000, None))
            .expect("registering");
        session.record_payment_outcome(outcome(
            "ev-done",
            "auth-open",
            1_000,
            OutcomeStatus::Succeeded,
        ));
        let mut stuck = outcome("ev-stuck", "auth-open", 2_000, OutcomeStatus::Unknown);
        stuck.quarantined = true;
        session.record_payment_outcome(stuck);
        store
            .save_payment_ledger(&id, &session)
            .await
            .expect("saving");

        let open = store.open_outcomes(&id, 50).await.expect("open outcomes");
        let ids: Vec<&str> = open
            .iter()
            .filter_map(|o| o.get("evidence_id").and_then(|v| v.as_str()))
            .collect();
        assert!(
            ids.contains(&"ev-stuck"),
            "the quarantined one is open: {ids:?}"
        );
        assert!(
            !ids.contains(&"ev-done"),
            "a settled payment is not open: {ids:?}"
        );

        cleanup(&store, &id).await;
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    /// The build script and this test read the same directory. If they ever
    /// disagree, the build script is what is wrong.
    #[test]
    fn the_required_migration_is_the_newest_file() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../migrations");
        let newest = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let (number, _) = name.split_once('_')?;
                name.ends_with(".sql")
                    .then(|| number.parse::<i64>().ok())
                    .flatten()
            })
            .max()
            .expect("at least one migration");
        assert_eq!(REQUIRED_MIGRATION, newest);
        assert_eq!(parse_decimal("0007"), 7);
        assert_eq!(parse_decimal("12"), 12);
    }
}

#[cfg(test)]
mod column_tests {
    /// `ApiKey::from_row` takes columns by name and panics on one the result
    /// does not carry. Four queries build an `ApiKey`; when `scopes` was added
    /// only two were updated, and signup and revoke panicked in production on
    /// a column the row did not have.
    ///
    /// `api_key_columns!()` is the fix. This is what keeps it the fix: the
    /// list must appear once, in the macro, and never be written out again
    /// beside a query where it can fall behind.
    #[test]
    fn nothing_spells_out_the_api_key_columns_by_hand() {
        let source = include_str!("storage.rs");
        // Split so this test's own literal is not one of the copies it counts.
        let needle = concat!("access_role,", " active");
        let spelled_out = source.matches(needle).count();
        assert_eq!(
            spelled_out, 1,
            "the column list belongs in api_key_columns!() and nowhere else; \
             found {spelled_out} copies of it"
        );
    }
}
