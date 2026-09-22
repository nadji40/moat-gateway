-- A third credential class, for issuing and revoking the other two.
--
-- Until now a key could be minted only by a human with root on the box, via
-- scripts/provision-tenant.sh. That is the right shape for one pilot and the
-- wrong shape for a tenant who wants to rotate their own agent key at 2am.
-- An `admin` key can call the control plane; it can never sign a payment or
-- approve one, because the gateway checks the role for the surface being
-- asked for and these three sets do not overlap.
SET ROLE moat_owner;
BEGIN;

ALTER TABLE moat.api_keys
    DROP CONSTRAINT api_keys_access_role_check,
    ADD CONSTRAINT api_keys_access_role_check
        CHECK (access_role IN ('agent', 'approver', 'admin'));

-- Who minted a key and when it stopped being usable. Revocation already runs
-- through `active`; this records the moment, so an evidence request months
-- later can say when a credential was withdrawn rather than only that it was.
ALTER TABLE moat.api_keys
    ADD COLUMN revoked_at timestamptz,
    ADD COLUMN created_by text REFERENCES moat.api_keys(id) ON DELETE SET NULL;

-- Listing a tenant's keys newest first is the control plane's only read.
CREATE INDEX api_keys_tenant_created_idx
    ON moat.api_keys (tenant_id, created_at DESC);

-- The runtime role has only ever read this table and stamped last_used_at on
-- it. The control plane inserts and revokes, and migration 4 records that the
-- original grants were made by hand with no note of what they covered, so
-- INSERT here may or may not exist. Granting explicitly rather than finding
-- out when a tenant tries to mint their first key. Same tolerance as
-- migration 4: a scratch database usually has no separate runtime role.
DO $$
DECLARE
    runtime_role CONSTANT text := 'moat_app';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
        RAISE NOTICE
            'role % does not exist; skipping. A deployment using another '
            'runtime role must grant it SELECT, INSERT, UPDATE on '
            'moat.api_keys or the control plane will fail on its first '
            'key.', runtime_role;
        RETURN;
    END IF;
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON moat.api_keys TO %I',
        runtime_role
    );
END
$$;

INSERT INTO moat.schema_migrations (version, name)
VALUES (5, 'admin role and key lifecycle');

COMMIT;
