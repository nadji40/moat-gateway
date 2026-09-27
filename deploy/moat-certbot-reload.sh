#!/usr/bin/env bash
set -euo pipefail
if [[ "${RENEWED_LINEAGE:-}" == /etc/letsencrypt/live/moatgateway.dpdns.org ]]; then
  /usr/sbin/httpd -t
  /usr/bin/systemctl reload httpd
fi
