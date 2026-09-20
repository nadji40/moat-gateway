# ADR 0010: The chain requires Moat's signature, or the money does not move

## Status

Accepted. Implemented for EVM on Base Sepolia; the Solana half is designed
here and not built.

## Context

Everything Moat has measured assumes the agent goes through Moat.

That assumption is load-bearing and it is not enforced by anything. Moat is
an MCP proxy: the agent asks it to call a payment tool, Moat decides, and
the upstream executes. An agent that holds the provider's credential can
skip the proxy entirely. On a card that means calling Stripe directly with
the API key. On a chain it means signing a transaction with the private key
and broadcasting it to any node in the world. The chain has no idea Moat
exists and would not care if it did.

So the arena's headline — attacker paid 0/380 through Moat — is a statement
about what Moat decides, not about what an agent can do. A sceptic is right
to say: your control is a suggestion. The `evm-testnet` README has said so
since the adapter was written, under "What this does not show".

This is the difference between a policy engine and a control. Every wallet
policy product in the landscape has the same shape and the same hole: CDP
Wallet Policies, ERC-4337 session-key policies, Safe spending caps. They
are the `cap` and `allowlist` arms of our own table, which the table shows
to be insufficient, and they are enforced by the service that holds the key
rather than by the chain.

A chain can do better, because a chain can be made to check a signature.

## Decision

**Moat holds a second key, and the chain requires it.**

The funds live in a contract, not in an externally owned account. The agent
keeps its own key and remains the only party that can *propose* a payment.
The contract will not execute one without a signature from Moat's co-sign
key over the exact parameters of that payment. Neither party can move money
alone:

- the agent cannot, because it cannot forge Moat's signature;
- Moat cannot, because it holds no funds and the contract accepts only a
  call from the owner;
- and Moat's signature is over the parameters, so an agent that gets a
  signature for one payment cannot spend it on another.

"Moat decides, the customer executes" is preserved exactly. Moat still
never holds or moves money. What changes is that its decision stops being
advisory.

### What is signed

An EIP-712 typed structure, so a wallet or an auditor can read it:

```
MoatVerdict {
  address wallet;      // the guarded contract this is valid for
  address to;          // recipient
  address token;       // the ERC-20, or address(0) for native value
  uint256 value;       // in the token's base units
  bytes32 evidenceId;  // the Moat evidence record that allowed it
  uint256 expiry;      // unix seconds
}
```

with the domain bound to the chain id and the contract address.

Each field is there because leaving it out is an attack.

`wallet` and the domain's `chainId` stop a signature being replayed against
another deployment or another chain — the network-substitution attack, one
layer down. `token` stops a signature for 250 USDC authorizing 250 of
something else; without it, the counterfeit-token attack walks straight
through the co-signer even though `authorization-asset-contract` refused it
upstairs. `evidenceId` binds the signature to the verdict that produced it,
so the record and the transaction can be reconciled from either end, and it
doubles as the replay key: the contract stores spent ids and refuses a
second use. `expiry` bounds how long a verdict stays good, because a
signature with no expiry is a standing grant, which is the thing the
arena's `standing-approval` attack is about.

### Who can ask for one

`POST /v1/session/{id}/cosign {evidence_id, wallet, to, token, value,
expiry}` — approver role, the same role that reconciles outcomes.

Moat signs only when all of the following hold. The evidence record exists,
its verdict is `allow`, and the payment arguments it recorded hash to the
same `to`/`token`/`value`. The authorization it was allowed under is not
cancelled or expired. There is an open reservation for it, and no
quarantined outcome. Anything else is a refusal, and the refusal is
recorded.

That list is the point. The signature is not a second decision; it is the
first decision, made mechanically presentable to a contract.

### The co-sign key is not the evidence key

Evidence is signed with ed25519 (ADR 0005) and proves what Moat decided.
The co-sign key is secp256k1, because that is what the EVM recovers, and it
*causes* money to move. Different consequences, different keys, different
storage, and a compromise of one is not a compromise of the other. They are
generated separately and the co-sign key is never written into the evidence
chain.

**A key that gates real money cannot be a mode-0600 file.** On testnet it
is, and that is stated in the README rather than hidden. For anything
beyond testnet the co-sign key belongs in a KMS or an HSM, and that is the
first hard production dependency this design creates. It is not built.

### Solana

The same shape, different machinery, not implemented. A program owns a PDA
holding the funds and a `PolicyPDA(owner)` holding Moat's ed25519 pubkey.
The instruction carries the same fields and is preceded in the transaction
by an `Ed25519SigVerify` precompile instruction over them, which the
program checks by reading the instructions sysvar. Solana's native
signature scheme is ed25519, so this half could reuse the evidence key's
algorithm — and should still not reuse the key, for the reason above.

### What this does not solve

The contract enforces Moat's verdict on funds the contract holds. It does
nothing about funds held anywhere else, and an agent with its own wallet
and its own money is outside the system entirely. The guarantee is "this
wallet cannot move without Moat", not "this agent cannot spend".

It also cannot make a verdict correct. If Moat allows a payment it should
have refused, the chain will execute it faithfully. On-chain enforcement
closes the bypass, not the false negative; the arena measures the second
and this ADR is about the first.

## Consequences

The claim changes shape. Instead of "0/380 when the agent goes through
Moat" the claim becomes "0/380, and going around Moat does not help",
which is a different kind of statement and the one the design was always
reaching for.

Moat acquires a liveness role it did not have. Today a gateway that is down
blocks payments and nothing worse. With a co-signer in front of a
contract's funds, a Moat that is down or has lost its key means funds that
cannot move at all. Any real deployment needs a recovery path — a timelock
that lets the owner act alone after a long delay, a second co-signer, or an
owner-controlled migration — and the testnet contract deliberately has
none, so that the enforcement being demonstrated is not quietly weakened by
an escape hatch.

Gas and latency go up: a signature check and a storage write per payment.
On an L2 this is cents; it is still not nothing, and it is a cost the
`cap` and `allowlist` arms do not pay.

The attack surface moves into a contract. A contract is code that cannot be
patched in place and holds money while it is wrong. The one here is kept
deliberately small for that reason, and it is testnet-only and unaudited,
which is said plainly wherever it is offered.
