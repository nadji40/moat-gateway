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

# Ask as moat_owner, the way the migrations themselves do.
#
# moat_migrator has no USAGE on the moat schema -- every migration file
# opens with SET ROLE moat_owner, so the bodies worked and only this
# check did not. It asked as moat_migrator, got "permission denied for
# schema moat", and the error was discarded, so a schema it could not
# read was indistinguishable from a migration that had never run. The
# script then tried to re-apply migration 1 to a live database and
# failed on a table that had existed for days.
#
# Errors are no longer swallowed. A check that cannot answer stops the
# run, because the alternative is re-applying migrations blindly.
for version in 1 2 3; do
  if ! applied="$(psql "$MOAT_MIGRATOR_DATABASE_URL" -XAtqc \
    "set role moat_owner; select to_regclass('moat.schema_migrations') is not null and exists (select 1 from moat.schema_migrations where version = ${version})" 2>&1)"; then
    echo "cannot tell whether migration $version is applied: $applied" >&2
    exit 1
  fi
  if [[ "$applied" == "t" ]]; then
    echo "migration $version already applied"
    continue
  fi
  migration="$(find "$repo_root/migrations" -maxdepth 1 -type f -name "$(printf '%04d' "$version")_*.sql" -print -quit)"
  [[ -n "$migration" ]] || { echo "migration file $version not found" >&2; exit 1; }
  psql "$MOAT_MIGRATOR_DATABASE_URL" -X -v ON_ERROR_STOP=1 --file "$migration"
  echo "migration $version applied to moat_gateway"
done
