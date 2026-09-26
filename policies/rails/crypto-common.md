# The crypto rail policies

`evm.yaml` and `solana.yaml` are the full Moat policy for the two chain
families, and `arm-cap-crypto.yaml` / `arm-allowlist-evm.yaml` /
`arm-allowlist-solana.yaml` are the evaluation arms they are measured
against. They are near-identical by design, and the differences between
them are the point rather than an oversight.

## Why there are two full policies and not one

Nothing in the mechanism differs between an EVM chain and Solana. The
tool is `send`, the destination is an address, the unit is a token, and
the network is half of the address on both. What differs is the shape of
an address — twenty bytes in checksummed hex, thirty-two bytes in
case-sensitive base58 — and therefore which addresses are on the approved
list. A single file listing both chains' addresses would be a deployment
that approves an address on a chain it cannot reach, which is not a thing
anyone runs.

## What this rail takes from the bank rail unchanged

The destination is a declared `destination` field, so it is compared on its
canonical form and matched exactly. Sending to the wrong address is a deny
and not a step up, because it is not recoverable.

## What is different here, and why

**The name is not checked by anything.** A bank transfer carries a
beneficiary name, and Confirmation of Payee at least compares it to the
account. A chain carries bytes. `counterparty` exists because the tools an
agent is handed have a label field, it is recorded so a ledger is readable,
and it is worth exactly nothing as a control. `payee-provenance` is kept —
it still catches an agent that was talked into paying a different company —
but it is a check on the agent's story, not on where the money went. On
this rail the destination rule is the only one standing between the wallet
and an attacker.

**The network is bound.** `authorization-network` is the check that makes
an approved-address list insufficient rather than merely incomplete: the
address on the list, on a chain nobody approved, passes every list and
every eyeball. It is enforced only because the authorization names a chain,
which is something only the intent API can say and no page can.

**An allowance is a payment.** `approve` is listed under `payment_tools`
alongside `send`, because granting a spender the right to move money later
puts exactly as much at risk as moving it now, and a control layer that
only looks at transfers does not see it happen. What a per-transaction cap
cannot see is the difference between the two: the same number, once, versus
the same number whenever the holder likes, for as long as the allowance
stands.

**The asset is a contract, not a ticker.** `asset_contract` reads the
`token_address` (EVM) or `mint` (Solana) the wallet is told to move, and
`authorization-asset-contract` denies a payment in any other contract, or in
none. It is enforced because the authorization names a contract, which the
intent API requires for every token that is not the chain's own coin:
`symbol()` returns whatever a contract was written to return, and a contract
that returns "USDC" costs the gas to deploy. A wallet that can only be told a
symbol cannot make a token payment under an authorization until it can be
told a contract, and that is the point.
