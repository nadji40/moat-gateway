//! Durable PostgreSQL state for authenticated gateway deployments.

use std::str::FromStr;

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
        let found = client
            .query_opt(
                "SELECT version FROM moat.schema_migrations WHERE version = 3",
                &[],
            )
            .await
            .context("checking storage migration")?;
        anyhow::ensure!(found.is_some(), "Moat database migration 3 is not applied");
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
    pub async fn authenticate(&self, key_hash: &str, access_role: &str) -> Result<Option<String>> {
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
                 RETURNING k.tenant_id",
                &[&key_hash, &access_role],
            )
            .await
            .context("authenticating API key")?;
        Ok(row.map(|row| row.get(0)))
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

    /// Insert or update a complete session snapshot.
    pub async fn save_session(
        &self,
        tenant_id: &str,
        session: &Session,
        expected_version: Option<i64>,
    ) -> Result<i64> {
        let state = Json(serde_json::to_value(session).context("encoding session")?);
        let client = self
            .pool
            .get()
            .await
            .context("session database connection")?;
        let row = match expected_version {
            Some(version) => client
                .query_opt(
                    "UPDATE moat.sessions
                         SET state = $3, version = version + 1, updated_at = now()
                         WHERE tenant_id = $1 AND id = $2 AND version = $4
                         RETURNING version",
                    &[&tenant_id, &session.id, &state, &version],
                )
                .await
                .context("updating session")?,
            None => client
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
        Ok(row.get(0))
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
    /// ledger, in one transaction.
    ///
    /// Upserts rather than replaces: another session under the same tenant
    /// may have written rows for the same authorization, and this one's
    /// snapshot is not entitled to delete them. Reservations that this
    /// session no longer holds are removed, because a reservation is a
    /// claim about right now and a stale one blocks a payment nobody is
    /// making.
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
                     $1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric,
                     $11::numeric, $12, $13, $14, $15, $16, $17, $18, $19
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
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::numeric, $14, $15
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
        for reservation in session.payment_reservations() {
            tx.execute(
                "INSERT INTO moat.payment_reservations (
                     tenant_id, fingerprint, authorization_id, session_id, amount_minor
                 ) VALUES ($1, $2, $3, $4, $5::numeric)
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

        tx.commit().await.context("committing payment ledger")?;
        Ok(())
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
                 ) VALUES ($1, $2, $3, $4, $5::numeric)
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
