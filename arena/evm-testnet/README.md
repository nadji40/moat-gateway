# evm-testnet

A real wallet on Base Sepolia, with Moat in front of it. This is the chain
counterpart of `stripe-sandbox`: the mock arena measures, this demonstrates.

Everything here is a public testnet. The ether has no value. The
transactions are real and permanent.

## What it shows

Five transactions go out and two are refused before the wallet hears of
them, all under one policy and one signed evidence chain:

| Step | What happens | Who stops it |
|---|---|---|
| Approved invoice | Sent, mined, hash recorded against the authorization | nobody, correctly |
| Approved invoice in USDC | The same through the real six-decimal contract, when the wallet holds any | nobody, correctly |
| Forged invoice | Right supplier name, attacker's address | Moat: `destination-provenance` |
| Right address, wrong chain | `eip155:1` against an authorization for `eip155:84532` | Moat: `authorization-network` |
| Lost reply | Broadcast, then the reply is dropped | Moat holds and quarantines it |
| Retry while held | Same invoice again | Moat: `authorization-quarantine` |
| After reconciliation | Operator confirms the hash on chain; retry again | Moat: `authorization-duplicate` |

The last three are the outcome state machine (ADR 0009) running against a
node instead of a mock. The wallet signed exactly one transaction for that
invoice, and the script checks the on-disk record against Moat's.

## Setup

Node 22 on `PATH` and the gateway built:

```bash
cargo build -p moat-gateway --release
```

Generate the keys. This writes `.env.evm-testnet` at the repository root,
ignored by Git, and prints two addresses. It will not overwrite an existing
file.

```bash
cd arena && pnpm --filter @moat/evm-testnet keygen
```

Fund the first address twice.

**Ether**, for gas and the native-asset payments. A few thousandths is
plenty; each run costs about four times `0.0001` plus gas. Faucets change;
at the time of writing the [Coinbase Developer Platform
faucet](https://portal.cdp.coinbase.com/) gives 0.1 per day behind a free
account, [Alchemy's](https://www.alchemy.com/faucets/base-sepolia) wants a
small mainnet balance, and the [Superchain
faucet](https://docs.base.org/base-chain/network-information/network-faucets)
wants an onchain identity. All of them want a human, which is the one step
nobody can do for you.

**USDC**, for the six-decimal token payment. [Circle's
faucet](https://faucet.circle.com/) is permissionless: paste the address,
pick Base Sepolia, and it sends 20 USDC, once per two hours. The contract it
funds is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, which `keygen` has
already written into the file, and whose symbol and six decimals were read
back from the chain before they were written here. Nothing needs deploying.

Check the wallet sees the chain and the funds:

```bash
cd arena && pnpm --filter @moat/evm-testnet start
```

then, from another MCP client, call `inspect_wallet`. It reports the address,
the chain id the node actually returned, and `funded`.

## Run

```bash
cd arena && MOAT_EVM_SMOKE_CONFIRM=YES pnpm --filter @moat/evm-testnet smoke
```

It prints a `PASS` document with a block-explorer link for every transaction,
the deny reasons for every refusal, and the balances afterwards; or it exits
non-zero naming the step that failed. If the wallet is unfunded it says so and
prints the address again.

To drive the gateway by hand:

```bash
cd arena && ../target/release/moat-gateway --config moat.evm-testnet.yaml --session-id evm-demo
```

The intent API is on `127.0.0.1:7075`. Register an authorization with a
`network` of `eip155:84532` and a `currency` of `ETH`, then call
`wallet__send` with the same address on the same chain.

## Configuration

Read from `.env.evm-testnet`. `keygen` writes all of it with comments.

| Variable | Meaning |
|---|---|
| `MOAT_EVM_PRIVATE_KEY` | The sender. Testnet only, and still never committed. |
| `MOAT_EVM_AUTHORIZED_ADDRESS` / `_PAYEE` | The approved supplier. `keygen` gives you this key too. |
| `MOAT_EVM_UNAUTHORIZED_ADDRESS` / `_PAYEE` | The address on the forged invoice. Nobody holds it. |
| `MOAT_EVM_TOKEN_ADDRESS` / `_SYMBOL` / `_DECIMALS` | The ERC-20 the wallet can move. `keygen` sets Circle's Base Sepolia USDC. Remove to run ether-only. |
| `MOAT_EVM_MAX_SEND` | Largest single send in ether. A guard on faucet funds, not a policy. Default `0.001`. |
| `MOAT_EVM_CONFIRMATIONS` | Blocks to wait before reporting `confirmed`. Default `1`. |
| `MOAT_EVM_FINALITY` | Confirmations after which `get_transaction` reports `finalized`. Default `12`. |
| `MOAT_EVM_RPC_URL` | Defaults to the public Base Sepolia endpoint. |
| `MOAT_EVM_STATE_DIR` | Where signed transactions are kept. Default `./state`, ignored by Git. |

## How a retry stays a retry

A transaction is signed first; its hash is known from the signature; the
signed bytes are written to `state/sent.json` under a key derived from the
sender, the authorization and the invoice — and only then broadcast. A retry
finds the bytes and broadcasts the same ones. The chain has one nonce for
them and mines them once. Re-signing on retry would mint a second nonce and a
second payment, which is the failure the whole exercise is about.

## What this does not show

The wallet obeys Moat because the wallet is behind Moat. An agent holding the
key can bypass the proxy and the chain will not stop it. Making the chain
require Moat's signature — a Safe transaction guard, an ERC-7579 validator —
is the co-signer design, and it is not built. This adapter makes the
demonstration real; it does not make the enforcement real.

There is no `approve` here. The mock wallet has one because the
standing-allowance attack needs it; this wallet moves value and grants
nothing, which is all the demonstration calls for. The token payment goes
through the real USDC contract's `transfer`, so the six-decimal path is
exercised end to end without deploying anything.
