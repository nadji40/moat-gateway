#!/usr/bin/env bash
# Deploy the gateway on the pilot server, in the order that keeps it safe:
#
#   migrate, build, test the ledger against the database, install, restart,
#   wait for ready.
#
# A failed step stops the deploy with the old binary still running. The
# ledger tests are the ones that need a database and are skipped everywhere
# else: the cross-session aggregate, its row lock, and the two-session race
# the tables exist to lose. Each test works inside a tenant of its own with a
# unique id and deletes it at the end; any such tenant a failed test leaves
# behind is removed here, so a failed deploy leaves no rows either.
#
#   scripts/deploy.sh            everything
#   scripts/deploy.sh --no-test  skip the ledger tests (a database outage,
#                                with a reason you can say out loud)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
env_file="${MOAT_DB_ENV_FILE:-/etc/moat/moat-db.env}"
binary="${MOAT_GATEWAY_BINARY:-/usr/local/bin/moat-gateway}"
service="${MOAT_GATEWAY_SERVICE:-moat-gateway.service}"
ready_url="${MOAT_READY_URL:-http://127.0.0.1:7081/health/ready}"
run_tests=1
[[ "${1:-}" == "--no-test" ]] && run_tests=0

step() {
  printf '\n\033[1m--- %s\033[0m\n' "$1"
}

# shellcheck disable=SC1090
source "$env_file"
: "${MOAT_MIGRATOR_DATABASE_URL:?missing MOAT_MIGRATOR_DATABASE_URL in $env_file}"

step "migrate"
scripts/migrate.sh

step "build"
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release -p moat-gateway

if (( run_tests )); then
  step "ledger tests against the database"
  # As moat_owner, which the migrator may become and which owns the schema.
  # The tests insert into moat.tenants, which moat_migrator itself may not.
  sep="?"
  [[ "$MOAT_MIGRATOR_DATABASE_URL" == *\?* ]] && sep="&"
  test_url="${MOAT_MIGRATOR_DATABASE_URL}${sep}options=-c%20role%3Dmoat_owner"
  cleanup_test_tenants() {
    # Every ledger test names its tenant "ledger test"; nothing else does.
    psql "$MOAT_MIGRATOR_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE moat_owner;
DELETE FROM moat.payment_reservations WHERE tenant_id IN (SELECT id FROM moat.tenants WHERE name = 'ledger test');
DELETE FROM moat.payment_outcomes WHERE tenant_id IN (SELECT id FROM moat.tenants WHERE name = 'ledger test');
DELETE FROM moat.payment_authorizations WHERE tenant_id IN (SELECT id FROM moat.tenants WHERE name = 'ledger test');
DELETE FROM moat.sessions WHERE tenant_id IN (SELECT id FROM moat.tenants WHERE name = 'ledger test');
DELETE FROM moat.tenants WHERE name = 'ledger test';
SQL
  }
  if ! MOAT_TEST_DATABASE_URL="$test_url" cargo test -p moat-gateway --bin moat-gateway ledger_tests; then
    cleanup_test_tenants
    echo "ledger tests failed; nothing was installed" >&2
    exit 1
  fi
  cleanup_test_tenants
else
  step "ledger tests skipped (--no-test)"
fi

step "install and restart"
install -m 755 -o root -g root target/release/moat-gateway "$binary"
systemctl restart "$service"

step "waiting for ready"
for _ in $(seq 1 30); do
  if code="$(curl -s -o /dev/null -w '%{http_code}' "$ready_url")" && [[ "$code" == "200" ]]; then
    printf '\n\033[32mdeployed: %s\033[0m\n' "$(git log --oneline -1)"
    exit 0
  fi
  sleep 1
done
echo "the gateway did not report ready within 30 s; check: journalctl -u $service -n 50" >&2
systemctl --no-pager status "$service" || true
exit 1
