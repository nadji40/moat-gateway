#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${MOAT_DB_ENV_FILE:-/etc/moat/moat-db.env}"

if [[ ! -r "$env_file" ]]; then
  echo "cannot read database environment file: $env_file" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$env_file"
: "${MOAT_MIGRATOR_DATABASE_URL:?missing MOAT_MIGRATOR_DATABASE_URL}"

database="$(psql "$MOAT_MIGRATOR_DATABASE_URL" -XAtqc 'select current_database()')"
role="$(psql "$MOAT_MIGRATOR_DATABASE_URL" -XAtqc 'select current_user')"
if [[ "$database" != "moat_gateway" || "$role" != "moat_migrator" ]]; then
  echo "refusing migration: expected moat_migrator@moat_gateway, got ${role}@${database}" >&2
  exit 1
fi

for version in 1 2; do
  applied="$(psql "$MOAT_MIGRATOR_DATABASE_URL" -XAtqc \
    "select to_regclass('moat.schema_migrations') is not null and exists (select 1 from moat.schema_migrations where version = ${version})" 2>/dev/null || true)"
  if [[ "$applied" == "t" ]]; then
    echo "migration $version already applied"
    continue
  fi
  migration="$(find "$repo_root/migrations" -maxdepth 1 -type f -name "$(printf '%04d' "$version")_*.sql" -print -quit)"
  [[ -n "$migration" ]] || { echo "migration file $version not found" >&2; exit 1; }
  psql "$MOAT_MIGRATOR_DATABASE_URL" -X -v ON_ERROR_STOP=1 --file "$migration"
  echo "migration $version applied to moat_gateway"
done
