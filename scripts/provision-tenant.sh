#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 TENANT_ID TENANT_NAME ACCESS_ROLE [OUTPUT_ENV_FILE]" >&2
  exit 2
fi

tenant_id="$1"
tenant_name="$2"
access_role="$3"
output="${4:-/etc/moat/tenants/${tenant_id}-${access_role}.env}"
env_file="${MOAT_DB_ENV_FILE:-/etc/moat/moat-db.env}"

if [[ ! "$tenant_id" =~ ^[a-z0-9][a-z0-9_-]{2,63}$ ]]; then
  echo "invalid tenant id" >&2
  exit 2
fi
if [[ "$access_role" != "agent" && "$access_role" != "approver" && "$access_role" != "admin" ]]; then
  echo "access role must be agent, approver or admin" >&2
  exit 2
fi
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
  echo "refusing provisioning: expected moat_migrator@moat_gateway, got ${role}@${database}" >&2
  exit 1
fi

raw_key="moat_sk_$(openssl rand -hex 32)"
key_hash="$(printf '%s' "$raw_key" | sha256sum | cut -d' ' -f1)"
key_id="key_$(openssl rand -hex 12)"

psql "$MOAT_MIGRATOR_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v tenant_id="$tenant_id" -v tenant_name="$tenant_name" \
  -v key_id="$key_id" -v key_hash="$key_hash" -v access_role="$access_role" <<'SQL'
SET ROLE moat_owner;
INSERT INTO moat.tenants (id, name)
VALUES (:'tenant_id', :'tenant_name')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
INSERT INTO moat.api_keys (id, tenant_id, label, key_hash, access_role)
VALUES (:'key_id', :'tenant_id', :'access_role' || ' key', :'key_hash', :'access_role');
SQL

install -d -m 700 "$(dirname "$output")"
umask 077
printf 'MOAT_API_KEY=%s\nMOAT_TENANT_ID=%s\nMOAT_ACCESS_ROLE=%s\n' \
  "$raw_key" "$tenant_id" "$access_role" >"$output"
chmod 600 "$output"
unset raw_key
echo "tenant $tenant_id $access_role key provisioned; raw key written to $output"
