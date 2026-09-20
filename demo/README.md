# demo

The public try-it page. One page, a live gateway behind it, and one button
that moves real value on a public test network.

## What a visitor gets

Five scenarios drawn from the measured corpus, not invented for the page.
Each one registers the user's own words as an intent, registers the
approver's mandate where the scenario has one, and then has an agent
attempt a payment that either matches or does not. The page shows what the
user asked, what the agent read, what it tried, what Moat decided, the
rule that decided it, and whether the provider was actually paid.

Then the same decision in front of a real Base Sepolia wallet: the
approved payment produces a transaction you can open in a block explorer,
and the forged one produces nothing, because Moat refuses before the
wallet is asked.

## Why it is safe to expose

**Every run is its own gateway process, with its own session, killed
afterwards.** One visitor cannot see or affect another's state. That costs
about two seconds a run; a shared session on a public endpoint would be a
different demonstration entirely.

**The scenario buttons talk to a mock provider.** Nothing moves anywhere.

**The chain button uses a wallet funded on purpose with almost nothing**,
separate from the one the smoke scripts use, so the worst case is that
this page stops working. On top of that:

- a hard cap on how many real payments the page will ever make, counted in
  memory, so a restart is the only way to raise it;
- a floor on the balance, so the wallet stops while it can still pay gas
  rather than stranding every later visitor on an error;
- two payments per caller, because the third proves nothing;
- a per-address run limit;
- and `MOAT_EVM_MAX_SEND` set two orders of magnitude below anything the
  page asks for, so a bug here cannot become a large payment.

The refusal path costs nothing at all, which is the point.

**There is no database, no account and no persistence.** The only mutable
state is a spend counter in memory.

## Running it

```bash
cargo build -p moat-gateway --release
cd demo && pnpm install && pnpm start          # 127.0.0.1:8787
cloudflared tunnel --url http://127.0.0.1:8787 # prints a random URL
```

The tunnel is a quick tunnel: a random `trycloudflare.com` hostname, no
DNS record, no account, nothing attached to a domain. Stop it and the URL
is gone.

| Variable | Meaning |
|---|---|
| `MOAT_DEMO_PORT` | Listen port. Default 8787, bound to loopback only. |
| `MOAT_DEMO_MAX_SENDS` | Real payments before the page refuses. Default 40. |
| `MOAT_DEMO_CONFIG` | Gateway config for the mock scenarios. |
| `MOAT_DEMO_WALLET_ADDRESS` | The chain demo's wallet; absent disables that section. |

`.env.evm-demo` holds the demo wallet's key, is mode 0600 and is ignored
by Git. It is a testnet key holding a few thousandths of an ether and it
should still never be committed.

## What this page is not

It is not the product. There is no approval console here — when Moat steps
up, a real deployment needs a human surface for that, and building one is
separate work. And the page demonstrates; the arena measures. The numbers
in the header come from the published run, not from anything a visitor
clicks.
