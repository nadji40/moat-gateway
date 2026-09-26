-- A session's end is a fact in its row.
--
-- DELETE /mcp ends a session, and until now the only record of that was a
-- set in the memory of the process that saw it. A restart forgot it, and so
-- did the idle sweep that drops a session's memory after half an hour; the
-- next request naming the id found the row and brought the session back as
-- if nothing had happened. The row is kept on purpose -- the evidence and
-- the mandates it holds are still there to read -- so the end has to be
-- written beside it rather than by removing it.
--
-- Nullable, because a live session has no end, and that absence is the
-- ordinary state of every row written before this migration.
SET ROLE moat_owner;
BEGIN;

ALTER TABLE moat.sessions
    ADD COLUMN ended_at timestamptz;

INSERT INTO moat.schema_migrations (version, name)
VALUES (8, 'a session end is durable');

COMMIT;
