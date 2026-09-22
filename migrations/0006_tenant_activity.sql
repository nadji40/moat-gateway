-- Reading a tenant's own activity.
--
-- Every verdict already lands in moat.evidence_records with the tenant on it,
-- so the dashboard's usage counts and verdict feed are reads over rows that
-- exist rather than a second place to write. What was missing is an index
-- that answers "this tenant, newest first".
--
-- evidence_session_idx leads with session_id, which serves the audit path
-- (one session, in order) and cannot serve this one: a tenant-wide feed would
-- scan every row the tenant has ever produced and sort it. Fine at a hundred
-- records, not at a million, and the dashboard reads it on every page load.
SET ROLE moat_owner;
BEGIN;

CREATE INDEX evidence_tenant_recent_idx
    ON moat.evidence_records (tenant_id, created_at DESC, evidence_id);

INSERT INTO moat.schema_migrations (version, name)
VALUES (6, 'index a tenant''s own activity');

COMMIT;
