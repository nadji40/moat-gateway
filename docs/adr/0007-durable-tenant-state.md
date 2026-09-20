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

**Deploying this requires running migration 3 first.** `connect()` asserts
it, so a gateway pointed at a database still on migration 2 refuses to
start rather than running with an unenforced aggregate. That is the right
failure, and it means the database is migrated before the binary is
replaced, not after.

The mirror write is non-fatal by design: the session snapshot is already
committed when it runs, and failing a payment over a bookkeeping write
would turn a reporting problem into an outage. It logs at error level, and
a deployment that sees those lines has tables drifting behind the documents.

What this does not do. Mandates are tenant-scoped, not global, and nothing
expires or archives them yet. The unique index on `(tenant, provider,
receipt)` will now reject a second outcome claiming a receipt another
already has — correct, and a behaviour change for anything that was
double-recording quietly. Cross-instance orchestration, webhooks and an
approval UI remain where ADR 0007 left them.

