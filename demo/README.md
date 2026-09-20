# demo

The public sandbox. A gateway anyone can point a payment at, with a page
for composing attacks by hand and an HTTP API for driving it from code.

## What it is

Not a tour. A visitor writes what the user asked for, writes what an
approver signed off, and then attempts whatever payment they like. Moat
compares the two and decides, and the page shows the verdict, the rule
that produced it, whether the mock provider was actually paid, and the
signed evidence id.

There is also one path that moves real value on Base Sepolia, so the
asymmetry is visible: the approved payment leaves a transaction anyone
can open in a block explorer, and the refused one leaves nothing at all,
because Moat refuses before the wallet is asked.

## The API

No key, no account. Sandboxes expire after ten idle minutes.

```bash
B=https://<host>
S=$(curl -s -XPOST $B/v1/sandbox | jq -r .id)

curl -s -XPOST $B/v1/sandbox/$S/intent -H 'content-type: application/json'   -d '{"text":"Pay the Acme Cloud Ltd invoice INV-4471 for 480 USD."}'

curl -s -XPOST $B/v1/sandbox/$S/authorization -H 'content-type: application/json'   -d '{"payee":"Acme Cloud Ltd","amount":"480","currency":"USD"}'

curl -s -XPOST $B/v1/sandbox/$S/pay -H 'content-type: application/json'   -d '{"payee":"Nordwind Handels GmbH","amount":480,"currency":"USD"}'

curl -s $B/v1/sandbox/$S/evidence
curl -s -XDELETE $B/v1/sandbox/$S
```

`GET /v1/limits` reports the pool and the limits below.

## Why each sandbox is its own everything

Running two at once is what proved this necessary, and every item here is
a bug that existed before it was.

**Its own port.** Each sandbox is a real gateway process, and they all
read one config, so they all bound one intent-API port. Only the first
won -- and every later sandbox's intent and mandate were registered
against the *first* sandbox's session. One visitor's words conferring
authority inside another visitor's sandbox is the worst failure a public
demonstration of an authorization layer could have.

**Its own evidence file.** The chain is hash-linked. Several processes
appending to one file produce a chain that verifies against nothing.

**Its own signing key.** The arena's key is readable only by whoever made
it, so a service running as another user dies at startup -- and the
caller sees an MCP connection closing with no reason attached. A key per
sandbox is more correct anyway: the chain is the sandbox's own and dies
with it.

**Its own config**, generated rather than committed, because the right
key directory and evidence path differ between a laptop and a hardened
service, and a committed file has to guess.

## Limits

Twelve live sandboxes; past that a request is refused rather than queued,
because a clear "try again shortly" beats a page that hangs. Ten idle
minutes, thirty absolute, forty payments each. Ninety requests a minute
per address, hashed rather than stored. A 64 KiB body cap.

The chain path has its own: a wallet funded on purpose with a few
thousandths of an ether and separate from the smoke scripts', a hard cap
on total payments, a balance floor so it stops while it can still pay
gas, two payments per caller, and a wallet-level maximum two orders of
magnitude below what the page asks. The worst case is that the page stops
working.

## Running it

```bash
cargo build -p moat-gateway --release
cd demo && pnpm install && pnpm start
```

Under systemd on the pilot host, `moat-demo.service` runs the page and
`moat-demo-tunnel.service` runs a Cloudflare quick tunnel. The tunnel is
deliberately **not** bound to the page: a quick tunnel mints a new
hostname every time it starts, so binding them would change the public
URL on every deploy. `moat-demo-url` prints the current one.

| Variable | Meaning |
|---|---|
| `MOAT_DEMO_PORT` | Listen port, loopback only. Default 8787. |
| `MOAT_DEMO_KEYS` | Writable directory for per-sandbox signing keys. |
| `MOAT_DEMO_MAX_SANDBOXES` | Live ceiling. Default 12. |
| `MOAT_DEMO_MAX_SENDS` | Real chain payments before refusing. Default 40. |
| `MOAT_EVM_STATE_DIR` | Where the chain wallet records signed transactions. Must be writable. |

The wallet secret lives in `/etc/moat/moat-demo.env`, read by systemd as
root and injected; the service user never needs access to it. Host paths
do not belong in that file -- one left there overrode the unit and sent
the wallet writing to a read-only directory.

## What this is not

It is not the product, and there is no approval console: when Moat steps
up, a real deployment needs a human surface for that and this has none.
The page demonstrates; the arena measures.
