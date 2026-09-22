-- Scopes on a key, so a role is a ceiling rather than a grant.
--
-- access_role says which door a key opens: agent keys reach /mcp, admin keys
-- reach the control plane. It does not say how much of the room behind that
-- door the key gets, and until now the answer was all of it. An admin key
-- minted so a colleague could read the verdict feed could also mint and revoke
-- keys, and an agent key issued for card payments could settle on chain.
--
-- A scope narrows a key within its role. It can never widen one: the role is
-- checked first and separately, so no scope written here reaches an endpoint
-- the role does not already open.
--
-- The empty array means the whole role, which is what every key minted before
-- this migration had and what a caller who names no scopes still gets. That
-- keeps existing keys working and keeps the simple case simple; it is also why
-- the column is NOT NULL with a default rather than nullable, so there is one
-- representation of "everything" instead of two.
--
-- The names are not constrained by the database on purpose. Which scopes exist
-- is the gateway's business and changes with the gateway; a CHECK constraint
-- here would mean a migration every time a rail is added, and a key carrying a
-- scope the gateway no longer knows is refused by the gateway rather than
-- rejected at write time in a way that cannot be undone.
SET ROLE moat_owner;
BEGIN;

ALTER TABLE moat.api_keys
    ADD COLUMN scopes text[] NOT NULL DEFAULT '{}';

-- Nothing may put a blank or a duplicate in there: both would read as a scope
-- the key does not actually have, and a membership test cannot tell them apart
-- from one it does.
ALTER TABLE moat.api_keys
    ADD CONSTRAINT api_keys_scopes_are_clean
    CHECK (
        array_position(scopes, NULL) IS NULL
        AND NOT EXISTS (
            SELECT 1 FROM unnest(scopes) AS s
            WHERE btrim(s) = '' OR s <> btrim(s) OR length(s) > 64
        )
        AND cardinality(scopes) = cardinality(ARRAY(SELECT DISTINCT unnest(scopes)))
        AND cardinality(scopes) <= 32
    );

INSERT INTO moat.schema_migrations (version, name)
VALUES (7, 'scopes on a key');

COMMIT;
