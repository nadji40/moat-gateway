#!/usr/bin/env bash
# Deploy the public site: build the React pages in frontend/ and restart the
# process that serves them beside the classic pages. The gateway is untouched;
# that is scripts/deploy.sh.
#
#   scripts/deploy-site.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../frontend"
service="${MOAT_DEMO_SERVICE:-moat-demo.service}"
site_url="${MOAT_SITE_URL:-http://127.0.0.1:8787/}"

printf '\n\033[1m--- build frontend\033[0m\n'
npm ci --no-audit --no-fund --loglevel=error
npm run build

printf '\n\033[1m--- restart\033[0m\n'
systemctl restart "$service"

for _ in $(seq 1 20); do
  if code="$(curl -s -o /dev/null -w '%{http_code}' "$site_url")" && [[ "$code" == "200" ]]; then
    printf '\n\033[32msite deployed: %s\033[0m\n' "$(git log --oneline -1)"
    exit 0
  fi
  sleep 1
done
echo "the site did not answer within 20 s; check: journalctl -u $service -n 50" >&2
exit 1
