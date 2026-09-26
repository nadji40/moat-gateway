# ADR 0007: Durable tenant-bound gateway state

## Status

Accepted.

## Context

The prototype kept sessions and approval tokens in process memory and exposed
its loopback APIs without caller identity. That is useful for one local agent,
but a restart loses authorization state and a shared listener cannot prevent one
customer from reading or mutating another customer's session.

The server already runs PostgreSQL for other products. Those databases are out
of scope and must not receive Moat tables or migrations.

## Decision

- Use a dedicated `moat_gateway` database in the existing PostgreSQL cluster.
- Use separate owner, migrator and runtime roles. The runtime role cannot create
  schema objects.
- Store complete session snapshots, signed evidence records and hashed,
  single-use approval tokens in the `moat` schema.
- Authenticate MCP and intent requests with separate tenant API-key roles:
  `agent` can use MCP, while `approver` controls intents, authorizations,
  cancellations and approvals. Store only SHA-256 key hashes and bind every
  session lookup to the authenticated tenant.
- Serialize restore and persistence by tenant/session and use optimistic row
  versions so a stale process cannot overwrite newer state.
- Roll back control-plane mutations in memory when their durable write fails.
- Keep the append-only signed JSONL evidence stream as an independent audit
  artifact while PostgreSQL provides indexed retrieval and restart recovery.
- Run migrations through a script that refuses any role/database pair other
  than `moat_migrator@moat_gateway`.

## Consequences

Gateway and intent sessions survive process restarts, approval tokens are
single-use across processes, and cross-tenant session access returns not found.
Database availability is now part of readiness; authenticated deployments fail
closed when durable state cannot be written.

The current session persistence model is a whole-snapshot update with optimistic
concurrency. A stale writer fails closed and must reload; automatic conflict
retries and multi-instance orchestration remain future work.
Public TLS termination, rate limiting, provider webhooks and an approval UI are
separate production milestones.

## Addendum, 20 September 2026: the payment ledger

The session document was carrying two different kinds of state and only one
of them belongs to a session.

Intents, observed values and the event log are a conversation. They start
when it starts and they mean nothing outside it. Authorizations, the
payments made under them and the reservations in flight are a *mandate*,
and a mandate is not a conversation. "Pay this supplier up to 5,000 a
month" is a sentence about a month; a limit that resets whenever the agent
reconnects is not a limit.

Keeping both in one JSONB blob per session had two consequences that no
amount of care inside the blob could fix.

**A mandate could not outlive its session.** Register an authorization,
lose the connection, reconnect, and the mandate was gone. Every long-lived
agreement had to be re-granted, which in practice means an approver
clicking through the same approval repeatedly and learning not to read it.

**An aggregate could not be enforced across concurrent sessions.** Two
agents under one tenant each read their own document, each see the whole
allowance unspent, and each spend it. The `version` column and optimistic
concurrency protect one session's document from a stale writer of *that
document*; they say nothing about a different document. The check was real
and the scope was wrong.

### Decision

Migration 0003 adds `moat.payment_authorizations`,
`moat.payment_outcomes` and `moat.payment_reservations`, keyed by tenant
rather than by session.

- **Amounts are `numeric(39,0)`, passed as text.** A u128 does not fit in
  `bigint`, and an eighteen-decimal token in base units leaves `bigint`
  behind at about 9.2 units. Float in a ledger would be indefensible.
- **The aggregate is computed and reserved inside one row lock** on the
  authorization (`SELECT ... FOR UPDATE`). Two sessions that each read an
  aggregate and then decide separately will both decide yes; two sessions
  queueing on the same lock cannot. A new check,
  `authorization-tenant-aggregate`, denies when the tenant's committed and
  in-flight total would exceed the mandate, and it **fails closed** if the
  ledger cannot be reached, because an allow issued without it is an allow
  issued without the check.
- **A reservation is released in both places or neither.** Left in the
  session it blocks one agent; left in the ledger it blocks every session
  under the tenant, which is worse and much harder to see.
- **The ledger is a mirror, not yet the source.** The gateway still
  evaluates from the session document; a mandate the session does not have
  is fetched from the ledger and registered into it before evaluation. That
  keeps evaluation synchronous and keeps one code path deciding, whether the
  mandate was granted a minute ago or last week. A migration that moved the
  data and the reader in one step would have no way back if the reader were
  wrong.
- **Reservations are deliberately not backfilled.** A reservation is a claim
  that a payment is in flight *now*; every one in an old document belongs to
  a process that is no longer running, and carrying them over would start
  the ledger with phantom holds nobody can release.
- **There is no `rail` column on an authorization.** A mandate does not
  carry one — the rail is a property of the call and the upstream it goes
  to. A column there would say `card` for everything.
- Two operator endpoints follow from having the tables:
  `GET /v1/outcomes` lists everything open across the tenant, and
  `GET /v1/authorizations/{id}` returns a mandate with what it has spent.
  The per-session views answer "what is outstanding in this conversation";
  these answer the question an operator actually has.

### Consequences

**Deploying this requires running migrations 3 and 4 first.** `connect()` asserts
it, so a gateway pointed at a database still on migration 2 refuses to
start rather than running with an unenforced aggregate. That is the right
failure, and it means the database is migrated before the binary is
replaced, not after.

The mirror write was non-fatal at first: the session snapshot was already
committed when it ran, and failing a payment over a bookkeeping write
looked like turning a reporting problem into an outage. That reasoning was
wrong in the one case that matters. A snapshot committed without its
ledger rows leaves the aggregate reading low until the next save, and a
payment in that gap is allowed against a limit that is not being counted.
**Amended 2026-09-26:** the ledger rows are written inside the session
snapshot's own transaction. Either both land or neither does, and a
failure refuses the payment the way any other failed decision write does.

**Amended 2026-09-26, reservations expire.** A session releases its own
reservations when their payments settle. A process that dies between
allowing a payment and hearing its outcome never does, and the row held
value against the mandate for every other session under the tenant until
somebody deleted it by hand. A reservation now carries the time it was
taken; nothing older than `RESERVATION_MAX_AGE_MS` (fifteen minutes, the
longest a co-signature lives) is written back to the ledger, a restored
session drops what it finds abandoned, and the gateway deletes ledger rows
that old at startup and once a minute after.

What this does not do. Mandates are tenant-scoped, not global, and nothing
expires or archives them yet. The unique index on `(tenant, provider,
receipt)` will now reject a second outcome claiming a receipt another
already has — correct, and a behaviour change for anything that was
double-recording quietly. Cross-instance orchestration, webhooks and an
approval UI remain where ADR 0007 left them.

### Addendum to the addendum: the grants nobody had written down

Applying migration 3 to the pilot found something worse than the thing it
was applying. **No migration in this repository has ever granted anything
to the runtime role.** `moat_app`'s privileges were set up by hand when
the database was first built and were never recorded, so whether a new
table is reachable by the gateway depends on whether that setup used
`ALTER DEFAULT PRIVILEGES` or granted table by table -- and nobody knows
which.

If it was table by table, migration 3 created three tables the gateway
cannot read, and the failure would have taken the worst available shape:
the binary starts, because its schema check only counts migrations, and
then fails on the first ledger write. Healthy at boot, broken on the
first payment.

Migration 4 grants the three tables explicitly and sets default
privileges so the next table added to the schema does not repeat it. It
is idempotent, and tolerant of the role being absent, because a scratch
or developer database usually has no separate runtime role and a
migration that failed there would stop anyone testing the schema at all.

The general lesson is the one worth keeping: **a migration that creates a
table and does not grant it is only half a migration**, and the half that
is missing fails later, in production, under load, rather than at the
point of change.

### Verified, 20 September 2026

The ledger now has tests and they have run against PostgreSQL 16, not
just compiled. Seven of them, gated on `MOAT_TEST_DATABASE_URL` so
`cargo test` stays green without a database:

```bash
docker run -d --rm --name moatpg -e POSTGRES_PASSWORD=test   -p 55432:5432 docker.io/library/postgres:16
export U="postgres://postgres:test@127.0.0.1:55432/postgres"
psql "$U" -q -c "CREATE ROLE moat_owner NOLOGIN"   -c "GRANT moat_owner TO postgres"   -c "CREATE SCHEMA moat AUTHORIZATION moat_owner"
for f in migrations/000*.sql; do psql "$U" -v ON_ERROR_STOP=1 -q -f "$f"; done
MOAT_TEST_DATABASE_URL="$U" cargo test -p moat-gateway ledger_tests
```

The one that matters is `two_sessions_cannot_both_spend_the_same_allowance`:
two tasks racing one mandate through `SELECT ... FOR UPDATE`, where
exactly one must be granted it. A row lock cannot be verified any other
way, and it is the specific bug the tables were built to close.

**Running them found that `save_payment_ledger` had never worked.** A
bare `$n::numeric` makes Postgres infer the parameter as numeric, and
tokio-postgres will not send a String for it; the cast has to be
`$n::text::numeric`. Every ledger write failed on its first parameter.

The way it failed is the part worth remembering. The mirror was then
non-fatal -- a bookkeeping write should not fail a customer's payment, the
thinking went -- so in production it would have logged an error and
carried on. The tables would have stayed empty, `aggregate_for` would
have read zero, and `authorization-tenant-aggregate` would have allowed
everything while appearing to work. A cross-session limit that silently
enforces nothing is worse than no limit, because somebody believes in it.

The schema was applied to the pilot and confirmed correct hours before
this was found. **Applying a migration proves the DDL; only running the
code proves the code.** Non-fatal error handling needs a test more than
fatal handling does, precisely because nothing shouts when it is wrong.

