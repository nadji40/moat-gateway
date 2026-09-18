#!/usr/bin/env bash
set -euo pipefail

if [[ "${MOAT_STRIPE_WORKFLOW_CONFIRM:-}" != "YES" ]]; then
  echo "set MOAT_STRIPE_WORKFLOW_CONFIRM=YES to create a Stripe test-mode payment" >&2
  exit 2
fi

agent_key_file="${1:-/etc/moat/tenants/pilot-agent.env}"
approver_key_file="${2:-/etc/moat/tenants/pilot-approver.env}"
agent_key="$(sed -n 's/^MOAT_API_KEY=//p' "$agent_key_file")"
approver_key="$(sed -n 's/^MOAT_API_KEY=//p' "$approver_key_file")"
[[ -n "$agent_key" && -n "$approver_key" ]] || { echo "pilot key file is invalid" >&2; exit 1; }

mcp="http://127.0.0.1:7081/mcp"
intent="http://127.0.0.1:7082"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

request() {
  local body="$1"
  local -a headers=(
    -H 'content-type: application/json'
    -H "authorization: Bearer $agent_key"
  )
  if [[ -n "$session" ]]; then
    headers+=(-H "mcp-session-id: $session")
  fi
  curl --silent --show-error --fail-with-body \
    "${headers[@]}" \
    --data "$body" "$mcp"
}

initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"stripe-pilot-workflow","version":"1"}}}'
session=""
curl --silent --show-error --fail-with-body --dump-header "$work/headers" --output "$work/initialize" \
  -H 'content-type: application/json' -H "authorization: Bearer $agent_key" \
  --data "$initialize" "$mcp"
session="$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub("\\r", "", $2); print $2}' "$work/headers" | tail -n 1)"
[[ "$session" == s_* ]] || { echo "no session id from initialize" >&2; exit 1; }

account_response="$(request '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"stripe__inspect_accounts","arguments":{}}}')"
account="$(jq -cer '.result.structuredContent.accounts[] | select(.role == "authorized")' <<<"$account_response")"
account_id="$(jq -r '.id' <<<"$account")"
payee="$(jq -r '.payee' <<<"$account")"
[[ -n "$account_id" && -n "$payee" ]] || { echo "authorized Stripe account not available" >&2; exit 1; }

run="$(date -u +%Y%m%d%H%M%S)"
authorization_id="pilot-auth-$run"
invoice_id="PILOT-INV-$run"
expires_at="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
authorization="$(jq -nc \
  --arg authorization_id "$authorization_id" --arg invoice_id "$invoice_id" \
  --arg payee "$payee" --arg account "$account_id" --arg expires "$expires_at" \
  '{authorization_id:$authorization_id,invoice_id:$invoice_id,payee:$payee,recipient_account_id:$account,amount:1,tolerance:0,currency:"USD",aggregate_limit:1,expires_at:$expires,repeat_payments:false,max_payments:1,require_invoice_fingerprint:false}')"
curl --silent --show-error --fail-with-body --output "$work/authorization" \
  -H 'content-type: application/json' -H "authorization: Bearer $approver_key" \
  --data "$authorization" "$intent/v1/session/$session/authorizations"

payment_args="$(jq -nc --arg payee "$payee" --arg account "$account_id" \
  --arg authorization_id "$authorization_id" --arg invoice_id "$invoice_id" \
  '{payee:$payee,amount:1,currency:"USD",authorization_id:$authorization_id,invoice_id:$invoice_id,recipient_account_id:$account}')"
payment_call="$(jq -nc --argjson args "$payment_args" \
  '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"stripe__pay",arguments:$args}}')"
payment_response="$(request "$payment_call")"
status="$(jq -r '.result.structuredContent.status // empty' <<<"$payment_response")"
receipt="$(jq -r '.result.structuredContent.receipt // empty' <<<"$payment_response")"
[[ "$status" == "succeeded" && "$receipt" == pi_* ]] || {
  echo "Stripe test payment did not succeed" >&2
  jq -c '{error,result}' <<<"$payment_response" >&2
  exit 1
}

duplicate_response="$(request "$payment_call")"
[[ "$(jq -r '.error.code // empty' <<<"$duplicate_response")" == "-31051" ]] || {
  echo "duplicate payment was not denied" >&2
  exit 1
}

systemctl restart moat-gateway.service
for _ in {1..20}; do
  curl --silent --fail "$intent/health/ready" >/dev/null && break
  sleep 0.25
done

workflow="$(curl --silent --show-error --fail-with-body \
  -H "authorization: Bearer $approver_key" "$intent/v1/session/$session/workflow")"
[[ "$(jq -r --arg receipt "$receipt" \
  '[.payment_outcomes[] | select(.receipt == $receipt and .succeeded == true)] | length' <<<"$workflow")" == "1" ]] || {
  echo "persisted provider outcome not found after restart" >&2
  exit 1
}
[[ "$(jq -r '.evidence | length' <<<"$workflow")" -ge 2 ]] || {
  echo "persisted evidence records missing after restart" >&2
  exit 1
}

list_call="$(jq -nc '{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"stripe__list_payments",arguments:{limit:100}}}')"
list_response="$(request "$list_call")"
provider_count="$(jq -r --arg authorization_id "$authorization_id" --arg receipt "$receipt" \
  '[.result.structuredContent.payments[] | select(.authorization_id == $authorization_id and .id == $receipt)] | length' <<<"$list_response")"
[[ "$provider_count" == "1" ]] || {
  echo "Stripe reconciliation failed: expected exactly one provider record" >&2
  exit 1
}

echo "Stripe pilot workflow passed: one settled payment, duplicate denied, durable evidence and receipt reconciled"
