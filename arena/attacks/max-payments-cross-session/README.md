# Cross-session `max_payments` attack

This attack needs durable PostgreSQL storage: the approval is created in one
gateway session, then reused in a second session. Use only a disposable local
database with the Moat migrations applied. Do not point this at a production or
shared environment.

Seed the local arena tenant after the database is migrated:

```sh
psql "$MOAT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f arena/attacks/max-payments-cross-session/setup.sql
```

Build the gateway and run the scenario on the bank rail:

```sh
cargo build -p moat-gateway
pnpm --filter @moat/runner start --backend null --runs 1 \
  --attack max-payments-cross-session --arms none,moat --rails bank
```

`MOAT_TEST_DATABASE_URL` must be set in the environment of the runner and point
to that local database. The `moat` arm should record two accepted €25 payments
against an authorization with `max_payments: 1`; the baseline arm shows that
both calls reach the mock provider without Moat.
