-- Let the runtime role use the tables migration 3 created.
--
-- Nothing in this repository has ever granted anything to the runtime
-- role. The pilot's `moat_app` privileges were set up by hand when the
-- database was first built, and whether new tables inherit them depends
-- entirely on whether that setup used ALTER DEFAULT PRIVILEGES or granted
-- table by table -- which is not recorded anywhere.
--
-- So migration 3 may have created three tables the gateway cannot read.
-- It would start (its schema check only counts migrations) and then fail
-- on the first ledger write, which is the worst shape of failure
-- available: healthy at boot, broken on the first payment.
--
-- This grants explicitly, and sets the default privileges so the next
-- table added to this schema does not repeat the problem. GRANT is
-- idempotent, so re-running costs nothing and re-applying over a database
-- that already had the rights changes nothing.
--
-- It is deliberately tolerant of the role not existing: a scratch or
-- developer database typically has no separate runtime role, and a
-- migration that fails there would stop anyone testing the schema at all.
--
-- This migration must be run by moat_migrator in the dedicated moat_gateway
-- database. Objects are deliberately owned by the NOLOGIN moat_owner role.
SET ROLE moat_owner;
BEGIN;

DO $$
DECLARE
    runtime_role CONSTANT text := 'moat_app';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
        RAISE NOTICE
            'role % does not exist; skipping runtime grants. A deployment '
            'that uses a differently named runtime role must grant it '
            'SELECT, INSERT, UPDATE and DELETE on the moat.payment_* tables '
            'by hand, or the gateway will start and then fail on its first '
            'ledger write.', runtime_role;
        RETURN;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA moat TO %I', runtime_role);
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON
             moat.payment_authorizations,
             moat.payment_outcomes,
             moat.payment_reservations
         TO %I',
        runtime_role
    );
    -- The ledger takes no sequences today. Granting anyway costs nothing
    -- and means a future serial column is not a fourth version of this
    -- same surprise.
    EXECUTE format(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA moat TO %I',
        runtime_role
    );
    -- And the next table somebody adds inherits the rights rather than
    -- needing another migration like this one.
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE moat_owner IN SCHEMA moat
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
        runtime_role
    );
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE moat_owner IN SCHEMA moat
             GRANT USAGE, SELECT ON SEQUENCES TO %I',
        runtime_role
    );
END
$$;

INSERT INTO moat.schema_migrations (version, name)
VALUES (4, 'grant the runtime role the payment ledger tables');

COMMIT;
