# solana-devnet

A real wallet on Solana devnet, with Moat in front of it. The sibling of
`evm-testnet` for the other chain family, so that "crypto" in the arena
means two chains and not one chain plus a mock.

Everything here is a public cluster. The SOL has no value. The
transactions are real and permanent.

## The one thing that is genuinely different

Not the address format. Idempotency.

An EVM transaction carries a per-account nonce, so signing once and
rebroadcasting the same bytes is exactly safe: the chain has one nonce for
them and mines them once. A Solana transaction instead carries a **recent
blockhash**, which expires after about 150 slots — a minute or two. Inside
that window rebroadcasting is safe, because the cluster dedupes by
signature. Outside it the transaction can never land, and a retry has to
re-sign with a fresh blockhash, producing a **different signature**. If the
first one did land and the reply was lost, that retry pays twice.

Which is the exact failure this repository exists to stop, arriving through
a door that does not exist on the other chain.

The answer the chain provides is a **durable nonce account**: the
transaction carries a stored nonce instead of a blockhash, and that nonce
only advances when the transaction is processed. One signed transaction
stays valid indefinitely and lands exactly once, ever. So `fund` creates
one, every transfer is built on it, and the retry path rebroadcasts the
same signed bytes the way the EVM adapter does.

Without this the adapter would look correct and be wrong in the one case it
was written for.

## Setup

Node 22 on `PATH` and the gateway built:

```bash
cargo build -p moat-gateway --release
```

Generate the keys. Writes `.env.solana-devnet` at the repository root,
ignored by Git, mode 0600, and refuses to overwrite.

```bash
cd arena && pnpm --filter @moat/solana-devnet keygen
```

Fund the sender and create the nonce account:

```bash
cd arena && pnpm --filter @moat/solana-devnet fund
```

**The airdrop is unreliable.** Devnet has an airdrop RPC, so in principle
the cluster funds itself with no faucet and no human. In practice
`api.devnet.solana.com` rate-limits per address *and per IP*, and spends
long stretches answering 429 or a bare internal error. When that happens
`fund` says so and prints the address; paste it at
[faucet.solana.com](https://faucet.solana.com/) with devnet selected, which
wants a GitHub login — the one step nobody can do for you. Then run `fund`
again; it is idempotent and picks up where it stopped.

Half a SOL is plenty. The nonce account costs about 0.0015 SOL in rent and
each transfer costs 5,000 lamports.

## Run

```bash
cd arena && MOAT_SOLANA_SMOKE_CONFIRM=YES pnpm --filter @moat/solana-devnet smoke
```

| Step | What happens | Who stops it |
|---|---|---|
| Approved invoice | Sent, confirmed, signature recorded against the authorization | nobody, correctly |
| Forged invoice | Right supplier name, attacker's address | Moat: `destination-provenance` |
| Right address, wrong cluster | `solana:mainnet` against an authorization for `solana:devnet` | Moat: `authorization-network` |
| Lost reply | Broadcast, then the reply is dropped | Moat holds and quarantines it |
| Retry while held | Same invoice again | Moat: `authorization-quarantine` |
| After reconciliation | Operator confirms the signature on chain; retry again | Moat: `authorization-duplicate` |

The retry rebroadcasts the same signed bytes, and the script checks that
the wallet signed exactly one transaction per authorization.

## Configuration

| Variable | Meaning |
|---|---|
| `MOAT_SOLANA_SECRET_KEY` | The sender, base64 or JSON array. Devnet only, and still never committed. |
| `MOAT_SOLANA_AUTHORIZED_ADDRESS` / `_PAYEE` | The approved supplier. |
| `MOAT_SOLANA_UNAUTHORIZED_ADDRESS` / `_PAYEE` | The address on the forged invoice. Nobody holds it. |
| `MOAT_SOLANA_NONCE_ACCOUNT` | The durable nonce. Written by `fund`. |
| `MOAT_SOLANA_MAX_SEND` | Largest single send in SOL. A guard on airdropped funds, not a policy. Default `0.01`. |
| `MOAT_SOLANA_RPC_URL` | Defaults to the public devnet endpoint. |
| `MOAT_SOLANA_STATE_DIR` | Where signed transactions are kept. Defaults to `state/` inside this package — not the working directory, because the wallet runs as a child of the gateway while the smoke script audits the same file from elsewhere. |

## What this does not show

The wallet obeys Moat because the wallet is behind Moat. An agent holding
the key can bypass the proxy and the cluster will not stop it. The EVM half
of this repository no longer has that hole — `MoatGuardedWallet` makes the
chain require Moat's signature — and **Solana does not yet**. The design is
in ADR 0010: a program owning the funds, a PDA holding Moat's pubkey, and
an `Ed25519SigVerify` precompile instruction the program checks through the
instructions sysvar. It is not built.

There are no SPL tokens here. The wallet moves SOL, which exercises the
nine-decimal path end to end; a six-decimal SPL mint would exercise nothing
the EVM adapter's USDC path does not already cover, and would need a mint
deploying.

The memo carries `moat:auth=…;inv=…` so a chain entry can be matched to a
verdict later. It is not a control: anybody can write anything there.
