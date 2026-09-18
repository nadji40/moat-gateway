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
