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
reverse record is the server's hostname.

Exim signs with selector `default` and the key at
`/var/cpanel/domain_keys/private/moatgateway.dpdns.org` (generated
2026-10-30; the public half is beside it under `public/`).

## Inbound mail

Mail to the domain is received by the same Exim. On 2026-10-30
`moatgateway.dpdns.org` was added to the `skylightchat` cPanel account as an
addon domain (parked on `moatgateway.skylightchat.com`, document root
`/home/skylightchat/moatgateway-mail`, unused), which is what makes Exim treat
the domain as local. Cloudflare Email Routing is no longer used.

The addon makes cPanel generate Apache vhosts for the names too. Those lose
to the hand-written ones: `httpd.conf` includes `conf.d/*.conf` before its own
vhosts, so `moat-domains.conf` is first for `moatgateway.dpdns.org` and
`api.moatgateway.dpdns.org` on both ports (`httpd -S` shows which file each
name resolves to). Do not remove the addon without reading this: it is also
what receives the mail.

Addresses, managed in cPanel → Email for the `skylightchat` account:

| Address | Today |
| --- | --- |
| `license@moatgateway.dpdns.org` | forwarder to the founder's mailbox |
| `security@moatgateway.dpdns.org` | forwarder to the founder's mailbox |
| `support@moatgateway.dpdns.org` | forwarder to the founder's mailbox; the address the dashboard's assistant gives for a person |
| `no-reply@moatgateway.dpdns.org` | sender only; no mailbox, no forwarder |

Mailboxes can be added there as well; IMAP and SMTP for them are on
`srv1158265.hstgr.cloud`, whose certificate covers that name.

## Mail DNS

In the Cloudflare zone, all DNS-only (grey cloud):

| Type | Name | Value | Status |
| --- | --- | --- | --- |
| MX | `@` | `srv1158265.hstgr.cloud`, priority 10 | receiving; **required** |
| TXT | `@` | `v=spf1 ip4:72.62.47.83 ~all` (the `include:_spf.mx.cloudflare.net` from Email Routing can go) | sending |
| TXT | `default._domainkey` | `v=DKIM1; k=rsa; p=` followed by the public key, printed by `grep -v -- ----- /var/cpanel/domain_keys/public/moatgateway.dpdns.org \| tr -d '\n'` | sending; in place 2026-10-30 |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:nadjisabri@gmail.com`; `p=quarantine` once the reports are clean | both; in place 2026-10-30 |

cPanel also keeps its own zone for the domain, which nothing queries:
Cloudflare's nameservers are authoritative, so the records above are the
only ones that count.

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
