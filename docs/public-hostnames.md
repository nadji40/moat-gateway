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
It is sent through Resend's HTTPS API, so the server runs no mail daemon and
port 25 stays closed. Receiving is separate and unchanged: Cloudflare Email
Routing holds the zone's MX records and forwards the mailboxes.

Resend verifies the sending domain with records it issues when the domain is
added in its dashboard. In the Cloudflare zone, all DNS-only (grey cloud):

| Type | Name | Value | Purpose |
| --- | --- | --- | --- |
| TXT | `resend._domainkey` | `p=MIGf...` as issued by Resend | DKIM: signs every message |
| MX | `send` | `feedback-smtp.<region>.amazonses.com`, priority 10, as issued | bounces for the return-path subdomain |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | SPF for the return-path subdomain |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<a mailbox Email Routing forwards>` | DMARC, reporting only to start |

The apex keeps the records Email Routing set (its MX records and
`v=spf1 include:_spf.mx.cloudflare.net ~all`); Resend's return path is the
`send` subdomain, so the two do not meet. Once Resend shows the domain as
verified, the API key goes in `/etc/moat/moat-db.env` as
`MOAT_MAIL_API_KEY=re_...` and the gateway is restarted; until then it starts
with recovery off and `/v1/recover` answers 503 saying so.

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
