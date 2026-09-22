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
-- The names are not constrained here on purpose. Which scopes exist is the
-- gateway's business and changes with the gateway; naming them in the schema
-- would mean a migration every time a rail is added, and a key carrying a
-- scope the gateway no longer knows is refused by the gateway rather than
-- rejected at write time in a way that cannot be undone. What is constrained
-- is the shape: no blanks, no duplicates, nothing unbounded.
SET ROLE moat_owner;
BEGIN;

-- The shape check lives in a function because a CHECK constraint may not
-- contain a subquery, and every per-element test over an array is one: you
-- cannot look at the members of a text[] without unnest. Inside a function
-- body the same SQL is ordinary SQL. IMMUTABLE is both true here -- the answer
-- depends on nothing but the argument -- and required, since PostgreSQL will
-- not accept a volatile function in a constraint.
CREATE OR REPLACE FUNCTION moat.scopes_are_clean(scopes text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT array_position(scopes, NULL::text) IS NULL
       AND cardinality(scopes) <= 32
       -- A blank, a padded, or an absurdly long name would all read as a scope
       -- the key does not actually have, and a membership test cannot tell any
       -- of them apart from one it does.
       AND NOT EXISTS (
           SELECT 1 FROM unnest(scopes) AS s
           WHERE btrim(s) = '' OR s <> btrim(s) OR length(s) > 64
       )
       -- Duplicates change no decision and make the key read as carrying more
       -- than it does.
       AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s);
$$;

ALTER TABLE moat.api_keys
    ADD COLUMN scopes text[] NOT NULL DEFAULT '{}';

ALTER TABLE moat.api_keys
    ADD CONSTRAINT api_keys_scopes_are_clean
    CHECK (moat.scopes_are_clean(scopes));

-- A function called from a CHECK still needs EXECUTE at the moment the row is
-- written. PUBLIC usually has it on a new function, but this database grants
-- explicitly rather than relying on that, and a runtime role that could not
-- run this would fail on the next key anyone issued. Same tolerance as
-- migrations 4 and 5: a scratch database usually has no separate runtime role.
DO $$
DECLARE
    runtime_role CONSTANT text := 'moat_app';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
        RAISE NOTICE
            'role % does not exist; skipping. A deployment using another '
            'runtime role must grant it EXECUTE on '
            'moat.scopes_are_clean(text[]) or issuing a key will fail.',
            runtime_role;
        RETURN;
    END IF;
    EXECUTE format(
        'GRANT EXECUTE ON FUNCTION moat.scopes_are_clean(text[]) TO %I',
        runtime_role
    );
END
$$;

INSERT INTO moat.schema_migrations (version, name)
VALUES (7, 'scopes on a key');

COMMIT;
