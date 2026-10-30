# Moat public hostnames

- Website: `https://moatgateway.dpdns.org`
- API base: `https://api.moatgateway.dpdns.org`
- MCP: `https://api.moatgateway.dpdns.org/mcp`
- Readiness: `https://api.moatgateway.dpdns.org/health/ready`

## DNS and HTTPS

In the Cloudflare zone for `moatgateway.dpdns.org`:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | `72.62.47.83` | Auto |
| A | `api` | `72.62.47.83` | Auto |

Both hostnames support a Cloudflare proxy or direct DNS access. Use **Full
(strict)** for Cloudflare origin encryption. SkyLight has a Let's Encrypt
certificate covering both names. HTTP redirects to HTTPS, except the ACME
challenge path used for renewal.

## Outbound mail

The gateway sends one kind of message: a recovery key to a workspace's owner
(`mail:` in `moat.pilot.yaml`, [TECHNICAL.md](TECHNICAL.md#authenticated-pilot-deployment)).
It hands the message to the server's own mail server, cPanel's Exim, over
SMTP on loopback; Exim accepts relay from the machine itself, signs the
message with the domain's DKIM key and delivers it from `72.62.47.83`, whose
reverse record is the server's hostname. Receiving is separate and unchanged:
Cloudflare Email Routing holds the zone's MX records and forwards the
mailboxes, so `moatgateway.dpdns.org` is not a cPanel domain and gets no
cPanel vhost.

Exim signs with selector `default` and the key at
`/var/cpanel/domain_keys/private/moatgateway.dpdns.org` (generated
2026-10-30; the public half is beside it under `public/`). Receivers trust
that signature, and the sending IP, through three records in the Cloudflare
zone, all DNS-only (grey cloud):

| Type | Name | Value |
| --- | --- | --- |
| TXT | `@` | `v=spf1 include:_spf.mx.cloudflare.net ip4:72.62.47.83 ~all`, replacing the existing SPF record, which lacked the `ip4` term |
| TXT | `default._domainkey` | `v=DKIM1; k=rsa; p=` followed by the public key, printed by `grep -v -- ----- /var/cpanel/domain_keys/public/moatgateway.dpdns.org \| tr -d '\n'` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<a mailbox Email Routing forwards>`; `p=quarantine` once the reports are clean |

The MX records stay Cloudflare's. Until the SPF and DKIM records exist the
gateway sends anyway, and the message is more likely to land in spam than in
the inbox; nothing else changes.

## Routing

Apache loads [`deploy/moat-domains.conf`](../deploy/moat-domains.conf) from
`/etc/apache2/conf.d/moat-domains.conf`. These are exact-name virtual hosts
on the server's existing Apache installation.
The API index is [`deploy/moat-api-index.json`](../deploy/moat-api-index.json),
installed at `/var/www/moat-domain/index.json`.

The root hostname proxies to the website service at `127.0.0.1:8787`.
Same-origin browser requests continue to work. The website's copied API and
MCP examples use the `api` hostname.

On the API hostname:

| Path | Destination |
| --- | --- |
| `/` | JSON identifying the API and its entry points |
| `/mcp` | Existing public MCP proxy on port 8787 |
| `/v1/*` | Existing public API router on port 8787 |
| `/health/*` | Gateway health routes on port 7081 |

The public router retains its existing route allowlist, rate limits and
gateway authentication. Agent keys authenticate MCP clients; admin and
approver keys are checked by their respective gateway routes. This hostname
configuration does not expose Redis, raw model completions or the private
reader port 7083. The reader architecture is documented in
[Colab serving](../research/intent-reader/colab-serving.md).

Apache preserves the public Host header for MCP origin checks. Its existing
trusted-Cloudflare configuration resolves client addresses. Incoming forwarding
headers are cleared before Apache supplies the proxy's client address, so
untrusted caller headers cannot directly select the website's rate-limit key.

## Certificate operation

The certificate lineage is `/etc/letsencrypt/live/moatgateway.dpdns.org`.
Certbot uses `/var/www/moat-domain` as its ACME webroot. The existing
`certbot-renew.timer` handles renewal. Install
[`moat-certbot-reload.sh`](../deploy/moat-certbot-reload.sh) as executable
`/etc/letsencrypt/renewal-hooks/deploy/moat-reload.sh` so a renewed Moat
certificate is loaded after an Apache syntax check.

Configuration validation and graceful reload:

```sh
httpd -t
systemctl reload httpd
```

Health and authentication checks that do not create payments:

```sh
curl -i https://api.moatgateway.dpdns.org/health/ready
curl -i https://api.moatgateway.dpdns.org/v1/usage
```

Readiness returns HTTP 200 when ready. Usage without a bearer credential must
be rejected. API root and error responses must not resolve to website HTML.
