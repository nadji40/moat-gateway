-- This migration must be run by moat_migrator in the dedicated moat_gateway
-- database. Objects are deliberately owned by the NOLOGIN moat_owner role.
SET ROLE moat_owner;
BEGIN;

CREATE TABLE IF NOT EXISTS moat.schema_migrations (
    version bigint PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moat.tenants (
    id text PRIMARY KEY,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (id ~ '^[a-z0-9][a-z0-9_-]{2,63}$')
);

CREATE TABLE moat.api_keys (
    id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES moat.tenants(id) ON DELETE CASCADE,
    label text NOT NULL,
    key_hash char(64) NOT NULL UNIQUE,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    CHECK (key_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX api_keys_tenant_active_idx ON moat.api_keys (tenant_id) WHERE active;

CREATE TABLE moat.sessions (
    tenant_id text NOT NULL REFERENCES moat.tenants(id) ON DELETE RESTRICT,
    id text NOT NULL,
    state jsonb NOT NULL,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CHECK (jsonb_typeof(state) = 'object')
);
CREATE UNIQUE INDEX sessions_global_id_idx ON moat.sessions (id);
CREATE INDEX sessions_updated_idx ON moat.sessions (tenant_id, updated_at DESC);

CREATE TABLE moat.resume_tokens (
    token_hash char(64) PRIMARY KEY,
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    pending jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES moat.sessions(tenant_id, id) ON DELETE CASCADE,
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CHECK (jsonb_typeof(pending) = 'object'),
    CHECK (expires_at > created_at)
);
CREATE INDEX resume_tokens_active_idx
    ON moat.resume_tokens (tenant_id, session_id, expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE moat.evidence_records (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    evidence_id text NOT NULL,
    record jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, evidence_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES moat.sessions(tenant_id, id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX evidence_session_idx
    ON moat.evidence_records (tenant_id, session_id, created_at, evidence_id);

INSERT INTO moat.schema_migrations (version, name)
VALUES (1, 'durable gateway state and tenant authentication');

COMMIT;
