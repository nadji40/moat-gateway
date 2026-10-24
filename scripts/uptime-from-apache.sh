#!/usr/bin/env bash
# Reconstruct the public site's daily availability from Apache's access log,
# for the days before the uptime recorder was writing anything down.
#
# The recorder samples the gateway once a minute and keeps the tally itself
# (demo/src/uptime.ts). Before it existed, the only record of whether the
# site answered is the web server's log: every request a visitor made and
# the status they got. A minute in which Apache answered a visitor with a
# 5xx is a minute the site was down for somebody; a day with none is a day
# nobody was turned away. That is a weaker measure than sampling (a minute
# in which nobody asked is unknown, and is counted as fine), so the page
# labels these days as coming from logs and never as measured.
#
#   scripts/uptime-from-apache.sh [access_log] [out.json]
#
# Run as root on the server (the log is root-only); the output is owned by
# the service user. deploy-site.sh runs it on every deploy.
set -euo pipefail

log="${1:-/usr/local/apache/logs/moat-domains-access_log}"
out="${2:-/var/lib/moat/demo-state/uptime-logs.json}"
owner="${MOAT_DEMO_USER:-moat}"

[[ -r "$log" ]] || { echo "no access log at $log" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Fields: vhost client - - [dd/Mon/yyyy:HH:MM:SS +0000] "req" status ...
awk -v generated="$(date -u +%FT%TZ)" -v log="$log" '
BEGIN {
  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", names, " ")
  for (i = 1; i <= 12; i++) month[names[i]] = sprintf("%02d", i)
}
{
  stamp = substr($5, 2)                       # dd/Mon/yyyy:HH:MM:SS
  split(stamp, p, "[/:]")                     # p[1]=dd p[2]=Mon p[3]=yyyy p[4]=HH p[5]=MM
  day = p[3] "-" month[p[2]] "-" p[1]
  requests[day]++
  if ($10 ~ /^5/) {
    errors[day]++
    minute = day " " p[4] ":" p[5]
    if (!(minute in seen)) { seen[minute] = 1; down[day]++ }
  }
}
END {
  n = asorti(requests, days)
  printf "{\n  \"source\": \"apache access log\",\n  \"log\": \"%s\",\n  \"generated\": \"%s\",\n  \"days\": {\n", log, generated
  for (i = 1; i <= n; i++) {
    d = days[i]
    printf "    \"%s\": { \"requests\": %d, \"errors\": %d, \"minutesDown\": %d }%s\n",
      d, requests[d], errors[d] + 0, down[d] + 0, (i < n ? "," : "")
  }
  printf "  }\n}\n"
}' "$log" > "$tmp"

install -o "$owner" -g "$owner" -m 0644 "$tmp" "$out"
echo "uptime from logs: $(grep -c '"requests"' "$out") days -> $out"
