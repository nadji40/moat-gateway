-- An expiry on a key, so a credential can be issued for a while rather than
-- for good.
--
-- A key handed to a contractor for a week, or to a staging agent for a demo,
-- used to stay valid until somebody remembered to revoke it. An expiry is the
-- revocation written down in advance: past it, the key authenticates nowhere,
-- exactly as if it had been withdrawn, and it stays in the listing as part of
-- the record.
--
-- NULL means the key does not expire, which is what every key minted before
-- this migration has and what a caller who names no expiry still gets. The
-- check is that an expiry, when there is one, comes after the key existed:
-- a key born expired is a mistake, not a policy.
SET ROLE moat_owner;
BEGIN;

ALTER TABLE moat.api_keys
    ADD COLUMN expires_at timestamptz;

ALTER TABLE moat.api_keys
    ADD CONSTRAINT api_keys_expire_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at);

INSERT INTO moat.schema_migrations (version, name)
VALUES (10, 'expiry on a key');

COMMIT;
