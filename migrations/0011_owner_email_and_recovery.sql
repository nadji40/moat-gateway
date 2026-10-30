-- A way back in when the admin key is gone.
--
-- A workspace's only credential is its admin key, shown once. Lose it and
-- the workspace is unreachable: nothing in the gateway can prove who you
-- are. This gives a workspace an owner's address, given at signup and
-- optional, and a table of recovery tokens: one is mailed to that address
-- on request, works once, and expires in half an hour. Redeeming it mints a
-- new admin key and withdraws the previous admin keys, since a key that was
-- lost may have been found by somebody else.
--
-- The token is stored as its SHA-256, like every other credential here, so
-- the database never holds anything a reader of it could present.
--
-- No grant block: migration 4 set default privileges on the schema, so the
-- runtime role inherits SELECT, INSERT, UPDATE and DELETE on this table.
SET ROLE moat_owner;
BEGIN;

ALTER TABLE moat.tenants
    ADD COLUMN owner_email text;

ALTER TABLE moat.tenants
    ADD CONSTRAINT tenants_owner_email_shape
    CHECK (
        owner_email IS NULL
        OR (
            owner_email = lower(owner_email)
            AND length(owner_email) <= 254
            AND owner_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        )
    );

CREATE TABLE moat.recovery_tokens (
    token_hash char(64) PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES moat.tenants(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CHECK (expires_at > created_at)
);

-- How many a tenant asked for lately: the rate limit reads this.
CREATE INDEX recovery_tokens_tenant_recent_idx
    ON moat.recovery_tokens (tenant_id, created_at DESC);

INSERT INTO moat.schema_migrations (version, name)
VALUES (11, 'an owner address and single-use recovery tokens');

COMMIT;
