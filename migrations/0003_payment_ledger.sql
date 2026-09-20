-- The payment ledger: mandates and their outcomes as rows, not as a blob.
--
-- Until this migration, an authorization, the payments made under it and the
-- reservations in flight all lived inside one JSONB document per session.
-- That works exactly as long as a mandate never outlives the conversation
-- that created it, and two things break the moment it does.
--
-- A mandate cannot span sessions. "Pay this supplier up to 5,000 a month"
-- is a sentence about a month, not about a chat window, and a limit that
-- resets whenever the agent reconnects is not a limit.
--
-- An aggregate cannot be enforced across concurrent sessions. Two agents
-- under one tenant, each reading its own document, each see the whole
-- allowance unspent. The JSONB row has a version column and optimistic
-- concurrency, which protects one session's document from itself and does
-- nothing about the other session.
--
-- So authorizations, outcomes and reservations become tables, keyed by
-- tenant rather than by session, and the aggregate is computed and reserved
-- in one statement under a row lock. The session document stays where it is
-- and keeps what only it needs: intents, observed values, the event log.
--
-- Amounts are numeric(39,0) and passed as text. u128 does not fit in bigint,
-- an eighteen-decimal token in base units leaves bigint behind at about 9.2
-- units, and float would be an unforced error in a ledger.
--
-- This migration must be run by moat_migrator in the dedicated moat_gateway
-- database. Objects are deliberately owned by the NOLOGIN moat_owner role.
SET ROLE moat_owner;
BEGIN;

CREATE TABLE moat.payment_authorizations (
    tenant_id text NOT NULL REFERENCES moat.tenants(id) ON DELETE RESTRICT,
    id text NOT NULL,
    -- The session that registered it, for provenance. Deliberately not part
    -- of the key and deliberately not a foreign key: the mandate outliving
    -- the session is the entire point of this table.
    origin_session_id text,
    -- No rail column. An authorization does not carry one: the rail is a
    -- property of the call and of the upstream it goes to, and the same
    -- mandate could in principle be satisfied on more than one. A column
    -- here would say 'card' for everything, which is worse than nothing.
    -- The outcome knows, and records it.
    payee text NOT NULL,
    destination text,
    network text,
    asset_contract text,
    currency text NOT NULL,
    amount_minor numeric(39, 0) NOT NULL,
    tolerance_minor numeric(39, 0) NOT NULL DEFAULT 0,
    aggregate_limit_minor numeric(39, 0),
    invoice_id text NOT NULL,
    invoice_fingerprint text,
    require_invoice_fingerprint boolean NOT NULL DEFAULT false,
    repeat_payments boolean NOT NULL DEFAULT false,
    max_payments integer NOT NULL DEFAULT 1,
    expires_unix_ms bigint NOT NULL,
    cancelled boolean NOT NULL DEFAULT false,
    -- The authorization exactly as registered, so a reader never has to
    -- reconstruct it from columns and a future field costs no migration.
    body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CHECK (amount_minor >= 0),
    CHECK (tolerance_minor >= 0),
    CHECK (aggregate_limit_minor IS NULL OR aggregate_limit_minor >= 0),
    CHECK (max_payments >= 1),
    CHECK (jsonb_typeof(body) = 'object')
);

CREATE INDEX payment_authorizations_live_idx
    ON moat.payment_authorizations (tenant_id, expires_unix_ms)
    WHERE NOT cancelled;

CREATE TABLE moat.payment_outcomes (
    tenant_id text NOT NULL REFERENCES moat.tenants(id) ON DELETE RESTRICT,
    -- The evidence record the outcome belongs to. One verdict, one outcome.
    evidence_id text NOT NULL,
    authorization_id text NOT NULL,
    session_id text,
    rail text NOT NULL DEFAULT 'card',
    provider text,
    network text,
    invoice_id text,
    status text NOT NULL,
    status_kind text NOT NULL,
    -- Whether this counts against the mandate. Not derivable from
    -- status_kind alone: on a reversible rail an ambiguous result releases,
    -- and on an irreversible one the identical status commits. See ADR 0009.
    committed boolean NOT NULL,
    terminal boolean NOT NULL,
    quarantined boolean NOT NULL DEFAULT false,
    amount_minor numeric(39, 0) NOT NULL DEFAULT 0,
    settled_amount_minor numeric(39, 0),
    currency text,
    destination text,
    receipt text,
    fee_minor numeric(39, 0),
    fee_currency text,
    body jsonb NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, evidence_id),
    FOREIGN KEY (tenant_id, authorization_id)
        REFERENCES moat.payment_authorizations (tenant_id, id) ON DELETE RESTRICT,
    CHECK (amount_minor >= 0),
    CHECK (settled_amount_minor IS NULL OR settled_amount_minor >= 0),
    CHECK (jsonb_typeof(body) = 'object')
);

-- What the aggregate reads, and the only index it needs.
CREATE INDEX payment_outcomes_committed_idx
    ON moat.payment_outcomes (tenant_id, authorization_id)
    WHERE committed;

-- Anything an operator has to clear by hand.
CREATE INDEX payment_outcomes_open_idx
    ON moat.payment_outcomes (tenant_id, updated_at DESC)
    WHERE quarantined OR NOT terminal;

-- One provider receipt is one payment. A second row claiming the same
-- receipt from the same provider means something recorded a payment twice,
-- and the database is a better place to find that out than a report is.
CREATE UNIQUE INDEX payment_outcomes_receipt_idx
    ON moat.payment_outcomes (tenant_id, provider, receipt)
    WHERE receipt IS NOT NULL AND provider IS NOT NULL;

CREATE TABLE moat.payment_reservations (
    tenant_id text NOT NULL REFERENCES moat.tenants(id) ON DELETE RESTRICT,
    -- The fingerprint of the proposed call. Two identical payments in flight
    -- collide here rather than both being sent.
    fingerprint text NOT NULL,
    authorization_id text NOT NULL,
    session_id text,
    amount_minor numeric(39, 0) NOT NULL,
    currency text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, fingerprint),
    FOREIGN KEY (tenant_id, authorization_id)
        REFERENCES moat.payment_authorizations (tenant_id, id) ON DELETE RESTRICT,
    CHECK (amount_minor >= 0)
);

CREATE INDEX payment_reservations_authorization_idx
    ON moat.payment_reservations (tenant_id, authorization_id);

-- Backfill from the session documents that already exist.
--
-- Idempotent, so it is safe to re-run, and lossless in the direction that
-- matters: the JSONB stays exactly as it is and remains the source the
-- gateway reads until it is taught otherwise. This table starts out as a
-- second copy on purpose -- a migration that moved the data and the reader
-- in one step has no way back if the reader is wrong.
INSERT INTO moat.payment_authorizations (
    tenant_id, id, origin_session_id, payee, destination, network,
    asset_contract, currency, amount_minor, tolerance_minor,
    aggregate_limit_minor, invoice_id, invoice_fingerprint,
    require_invoice_fingerprint, repeat_payments, max_payments,
    expires_unix_ms, cancelled, body
)
SELECT
    s.tenant_id,
    a.value ->> 'id',
    s.id,
    COALESCE(a.value ->> 'payee', ''),
    a.value ->> 'recipient_account_id',
    a.value ->> 'network',
    a.value ->> 'asset_contract',
    COALESCE(a.value ->> 'currency', ''),
    COALESCE((a.value ->> 'amount_minor')::numeric, 0),
    COALESCE((a.value ->> 'tolerance_minor')::numeric, 0),
    (a.value ->> 'aggregate_limit_minor')::numeric,
    COALESCE(a.value ->> 'invoice_id', ''),
    a.value ->> 'invoice_fingerprint',
    COALESCE((a.value ->> 'require_invoice_fingerprint')::boolean, false),
    COALESCE((a.value ->> 'repeat_payments')::boolean, false),
    COALESCE((a.value ->> 'max_payments')::integer, 1),
    COALESCE((a.value ->> 'expires_unix_ms')::bigint, 0),
    COALESCE((a.value ->> 'cancelled')::boolean, false),
    a.value
FROM moat.sessions s
CROSS JOIN LATERAL jsonb_array_elements(
    CASE
        WHEN jsonb_typeof(s.state -> 'authorizations') = 'array'
        THEN s.state -> 'authorizations'
        ELSE '[]'::jsonb
    END
) AS a(value)
WHERE a.value ->> 'id' IS NOT NULL
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO moat.payment_outcomes (
    tenant_id, evidence_id, authorization_id, session_id, rail, provider,
    network, invoice_id, status, status_kind, committed, terminal,
    quarantined, amount_minor, currency, destination, receipt, body
)
SELECT
    s.tenant_id,
    o.value ->> 'evidence_id',
    o.value ->> 'authorization_id',
    s.id,
    COALESCE(o.value ->> 'rail', 'card'),
    o.value ->> 'provider',
    o.value ->> 'network',
    o.value ->> 'invoice_id',
    COALESCE(o.value ->> 'status', 'unknown'),
    COALESCE(o.value ->> 'status_kind', 'unknown'),
    -- Records written before `committed` existed carried `succeeded`, and
    -- that is what the Rust deserializer falls back to as well.
    COALESCE(
        (o.value ->> 'committed')::boolean,
        (o.value ->> 'succeeded')::boolean,
        false
    ),
    COALESCE((o.value ->> 'terminal')::boolean, false),
    COALESCE((o.value ->> 'quarantined')::boolean, false),
    COALESCE((o.value ->> 'amount_minor')::numeric, 0),
    o.value ->> 'currency',
    o.value ->> 'destination',
    o.value ->> 'receipt',
    o.value
FROM moat.sessions s
CROSS JOIN LATERAL jsonb_array_elements(
    CASE
        WHEN jsonb_typeof(s.state -> 'payment_outcomes') = 'array'
        THEN s.state -> 'payment_outcomes'
        ELSE '[]'::jsonb
    END
) AS o(value)
WHERE o.value ->> 'evidence_id' IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM moat.payment_authorizations pa
      WHERE pa.tenant_id = s.tenant_id
        AND pa.id = o.value ->> 'authorization_id'
  )
ON CONFLICT (tenant_id, evidence_id) DO NOTHING;

-- Reservations are deliberately not backfilled. A reservation is a payment
-- believed to be in flight right now; every one in an old document is from
-- a process that is no longer running, and carrying them over would start
-- the new ledger with phantom holds nobody can release.

INSERT INTO moat.schema_migrations (version, name)
VALUES (3, 'payment ledger: authorizations, outcomes and reservations as rows');

COMMIT;
