# Authenticated pilot operations

This runbook covers the controlled Stripe test-mode pilot. It does not describe
a live-money production deployment.

## Boundaries

- Service: `moat-gateway.service`
- MCP listener: `127.0.0.1:7081`
- Intent API: `127.0.0.1:7082`
- Database: `moat_gateway`, schema `moat`
- Runtime role: `moat_app` (DML only)
- Credentials: a tenant `agent` key for MCP and a separate `approver` key for
  the intent/authorization API.
- Secrets: `/etc/moat/moat-db.env`, `/etc/moat/tenants/*.env`, and the ignored
  Stripe sandbox environment file. Never print or commit them.

Existing application databases are not migration targets. `scripts/migrate.sh`
checks the exact database and role before it can execute.

**The gateway asserts the schema version it needs and refuses to start
otherwise.** Since migration 3 (the payment ledger) that means a binary
installed against a database still on migration 2 will not come up. This is
deliberate: running with the tenant-wide aggregate unenforced is worse than
not running. It is also why the deploy below migrates before it installs --
keep that order.

## Deploy or update

```bash
scripts/migrate.sh
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release -p moat-gateway
install -m 755 -o root -g root target/release/moat-gateway /usr/local/bin/moat-gateway
systemctl restart moat-gateway.service
scripts/smoke-pilot.sh /etc/moat/tenants/pilot-agent.env /etc/moat/tenants/pilot-approver.env
```

Run `cargo fmt --all -- --check`, Clippy with warnings denied, the full Rust
workspace tests, and `pnpm test && pnpm typecheck` before installing a binary.

## Health and diagnosis

```bash
curl --fail http://127.0.0.1:7081/health/live
curl --fail http://127.0.0.1:7081/health/ready
curl --fail http://127.0.0.1:7082/health/ready
systemctl status moat-gateway.service
journalctl -u moat-gateway.service --since today
```

Liveness says the process can answer. Readiness also checks PostgreSQL. A
durable-write failure denies the payment rather than forwarding it.

## Key rotation

Provision a replacement key with the same role, update only that consumer,
verify it, then disable the old hash. Never use an approver key in an agent
runtime, and never copy a raw key into SQL or logs.

```sql
UPDATE moat.api_keys SET active = false WHERE id = '<old-key-id>';
```

Keep at least one verified active key until consumers have switched.

## Backup check

Back up only the dedicated database. Encrypt and retain backups according to the
pilot's data-retention policy.

```bash
pg_dump --format=custom --no-owner --no-privileges moat_gateway > moat_gateway.dump
pg_restore --list moat_gateway.dump >/dev/null
```

A listing check detects a malformed archive; a scheduled restore drill into a
separate disposable database is still required before live-money use.

## Verification workflows

- `scripts/smoke-pilot.sh` checks readiness, role separation,
  absent/invalid/valid auth, tenant isolation, concurrent durable writes,
  durable single-use approval and restart recovery without creating a payment.
- `MOAT_STRIPE_WORKFLOW_CONFIRM=YES scripts/stripe-pilot-workflow.sh` creates one
  $1 Stripe test-mode payment, verifies duplicate denial, restarts the service,
  and reconciles the durable receipt and signed evidence to the provider record.

## Known limits before live money

- Whole-session optimistic concurrency fails stale writers closed; automatic
  conflict recovery for multiple active instances is not implemented.
- No external TLS/reverse proxy or rate limiter is included here.
- No end-user approval console or operator administration UI.
- No Stripe webhook reconciliation loop; the pilot reconciles synchronously.
- No automated encrypted backup/restore drill or HA/failover exercise.
- Policy and attack coverage are meaningful but not a compliance certification.
