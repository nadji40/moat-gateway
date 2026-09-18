#!/usr/bin/env bash
set -euo pipefail

agent_key_file="${1:-/etc/moat/tenants/pilot-agent.env}"
approver_key_file="${2:-/etc/moat/tenants/pilot-approver.env}"
other_approver_key_file="${3:-}"
mcp_url="${MOAT_MCP_URL:-http://127.0.0.1:7081/mcp}"
intent_url="${MOAT_INTENT_URL:-http://127.0.0.1:7082}"
mcp_origin="${mcp_url%/mcp}"

if [[ ! -r "$agent_key_file" || ! -r "$approver_key_file" ]]; then
  echo "cannot read pilot agent and approver key files" >&2
  exit 1
fi
agent_key="$(sed -n 's/^MOAT_API_KEY=//p' "$agent_key_file")"
approver_key="$(sed -n 's/^MOAT_API_KEY=//p' "$approver_key_file")"
[[ -n "$agent_key" && -n "$approver_key" ]] || { echo "pilot key file is invalid" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"moat-pilot-smoke","version":"1"}}}'

expect_code() {
  local expected="$1"
  shift
  local actual
  actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected HTTP $expected, got $actual" >&2
    exit 1
  fi
}

expect_code 200 "$mcp_origin/health/ready"
expect_code 200 "$intent_url/health/ready"
expect_code 401 -H 'content-type: application/json' --data "$initialize" "$mcp_url"
expect_code 401 -H 'content-type: application/json' -H 'authorization: Bearer invalid' \
  --data "$initialize" "$mcp_url"
expect_code 401 -H 'content-type: application/json' -H "authorization: Bearer $approver_key" \
  --data "$initialize" "$mcp_url"

code="$(curl --silent --show-error --dump-header "$work/headers" --output "$work/body" \
  --write-out '%{http_code}' -H 'content-type: application/json' \
  -H "authorization: Bearer $agent_key" --data "$initialize" "$mcp_url")"
[[ "$code" == "200" ]] || { echo "authenticated initialize failed: HTTP $code" >&2; exit 1; }
session="$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub("\\r", "", $2); print $2}' "$work/headers" | tail -n 1)"
[[ "$session" == s_* ]] || { echo "initialize did not return a valid session id" >&2; exit 1; }

expect_code 401 -H 'content-type: application/json' -H "authorization: Bearer $agent_key" \
  --data '{"text":"This agent key must not control human authorization state."}' \
  "$intent_url/v1/session/$session/intent"
expect_code 200 -H 'content-type: application/json' -H "authorization: Bearer $approver_key" \
  --data '{"text":"Pay the approved supplier invoice only within its explicit authorization."}' \
  "$intent_url/v1/session/$session/intent"
expect_code 200 -H "authorization: Bearer $approver_key" \
  "$intent_url/v1/session/$session/workflow"

# Concurrent control-plane writes must serialize rather than lose a newer
# snapshot or report success for a stale one.
pids=()
for n in {1..8}; do
  (
    expect_code 200 -H 'content-type: application/json' \
      -H "authorization: Bearer $approver_key" \
      --data "{\"text\":\"Concurrent durable intent $n for session safety verification.\"}" \
      "$intent_url/v1/session/$session/intent"
  ) &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "$pid"
done

# Exercise durable, single-use step-up with the approver credential. The
# payment is intentionally not retried, so this smoke creates no provider charge.
accounts="$(curl --silent --show-error --fail-with-body \
  -H 'content-type: application/json' -H "authorization: Bearer $agent_key" \
  -H "mcp-session-id: $session" \
  --data '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"stripe__inspect_accounts","arguments":{}}}' \
  "$mcp_url")"
account="$(jq -cer '.result.structuredContent.accounts[] | select(.role == "authorized")' <<<"$accounts")"
account_id="$(jq -r '.id' <<<"$account")"
payee="$(jq -r '.payee' <<<"$account")"
run="$(date -u +%Y%m%d%H%M%S)"
authorization_id="smoke-approval-$run"
invoice_id="SMOKE-APPROVAL-$run"
expires_at="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
authorization="$(jq -nc --arg authorization_id "$authorization_id" \
  --arg invoice_id "$invoice_id" --arg payee "$payee" --arg account "$account_id" \
  --arg expires "$expires_at" \
  '{authorization_id:$authorization_id,invoice_id:$invoice_id,payee:$payee,recipient_account_id:$account,amount:1,tolerance:0,currency:"USD",aggregate_limit:1,expires_at:$expires,repeat_payments:false,max_payments:1,require_invoice_fingerprint:false}')"
expect_code 200 -H 'content-type: application/json' -H "authorization: Bearer $approver_key" \
  --data "$authorization" "$intent_url/v1/session/$session/authorizations"
proposal="$(jq -nc --arg payee "$payee" --arg account "$account_id" \
  --arg authorization_id "$authorization_id" --arg invoice_id "$invoice_id" \
  '{jsonrpc:"2.0",id:11,method:"tools/call",params:{name:"stripe__pay",arguments:{payee:$payee,amount:1.1,currency:"USD",authorization_id:$authorization_id,invoice_id:$invoice_id,recipient_account_id:$account}}}')"
step_up="$(curl --silent --show-error --fail-with-body \
  -H 'content-type: application/json' -H "authorization: Bearer $agent_key" \
  -H "mcp-session-id: $session" --data "$proposal" "$mcp_url")"
step_up_code="$(jq -r 'if .error and .error.code then (.error.code | tostring) else "missing" end' <<<"$step_up")"
[[ "$step_up_code" == "-31050" ]] || {
  echo "unexpected price increase did not require approval (code $step_up_code)" >&2
  exit 1
}
resume_token="$(jq -r '.error.data.moat.resume_token // empty' <<<"$step_up")"
[[ "$resume_token" == rt_* ]] || { echo "step-up token missing" >&2; exit 1; }
resume_body="$(jq -nc --arg token "$resume_token" '{resume_token:$token,approved:true}')"
expect_code 200 -H 'content-type: application/json' -H "authorization: Bearer $approver_key" \
  --data "$resume_body" "$intent_url/v1/session/$session/resume"
expect_code 404 -H 'content-type: application/json' -H "authorization: Bearer $approver_key" \
  --data "$resume_body" "$intent_url/v1/session/$session/resume"

if [[ -n "$other_approver_key_file" ]]; then
  other_key="$(sed -n 's/^MOAT_API_KEY=//p' "$other_approver_key_file")"
  [[ -n "$other_key" ]] || { echo "second key file is invalid" >&2; exit 1; }
  expect_code 404 -H "authorization: Bearer $other_key" \
    "$intent_url/v1/session/$session/workflow"
fi

if [[ "${MOAT_SMOKE_RESTART:-0}" == "1" ]]; then
  systemctl restart moat-gateway.service
  for _ in {1..20}; do
    if curl --silent --fail "$intent_url/health/ready" >/dev/null; then
      break
    fi
    sleep 0.25
  done
  expect_code 200 -H "authorization: Bearer $approver_key" \
    "$intent_url/v1/session/$session/workflow"
  expect_code 200 -H 'content-type: application/json' -H "authorization: Bearer $agent_key" \
    -H "mcp-session-id: $session" --data '{"jsonrpc":"2.0","id":2,"method":"ping"}' "$mcp_url"
fi

echo "pilot smoke passed: split roles, concurrency, single-use approval, tenant boundary and restart recovery"
