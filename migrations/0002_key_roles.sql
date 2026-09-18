-- Split agent-plane credentials from human/control-plane credentials.
SET ROLE moat_owner;
BEGIN;

ALTER TABLE moat.api_keys
    ADD COLUMN access_role text NOT NULL DEFAULT 'agent',
    ADD CONSTRAINT api_keys_access_role_check
        CHECK (access_role IN ('agent', 'approver'));

CREATE INDEX api_keys_role_active_idx
    ON moat.api_keys (tenant_id, access_role)
    WHERE active;

INSERT INTO moat.schema_migrations (version, name)
VALUES (2, 'separate agent and approver credentials');

COMMIT;
