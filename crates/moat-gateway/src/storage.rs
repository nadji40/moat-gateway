//! Durable PostgreSQL state for authenticated gateway deployments.

use std::str::FromStr;

use anyhow::{Context, Result};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use moat_core::evidence::Record;
use moat_core::session::Session;
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
                "SELECT version FROM moat.schema_migrations WHERE version = 2",
                &[],
            )
            .await
            .context("checking storage migration")?;
        anyhow::ensure!(found.is_some(), "Moat database migration 2 is not applied");
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
