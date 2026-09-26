# ADR 0008: Settlement rails are a property of the upstream

## Status

Accepted.

## Context

Moat was built against one way of moving money: a card-shaped provider call
with a payee name, an amount, a currency, and an optional account identifier
that the provider already knows. The measurement says the mechanism works —
the scripted attacker is paid 80/80 times through a spending cap and 0/80
through Moat — but the mechanism is not what is card-specific. Provenance is
the same question on every rail: did this payee come from the user, or from a
page the agent read?

Where the answer matters most is where Moat does not yet reach. A card payment
is reversible and the network runs its own fraud controls. A bank transfer and
an on-chain transfer are irreversible, settle asynchronously, and are
identified by an account number or an address rather than a name that a human
would recognise. Business email compromise — an invoice paid to a changed
account — is the largest reported loss category on bank transfers, and none of
the agent-payment controls the card networks are building apply to it. On
chain, the wallet-side primitives that exist (spending limits, counterparty
allowlists, session-key policies) are precisely the `cap` and `allowlist`
evaluation arms this project already measures as insufficient.

So the rails have to be first-class. The question this ADR settles is where
the rail is declared and what it is allowed to change.

## Decision

- A rail is one of `card`, `bank`, `crypto`. The set is **closed**: an
  unrecognised value in a config is a load error, never a silent fall back to
  card semantics. A rail that behaves unlike the three gets a variant and
  explicit handling, not a string that happens to parse.
- **The rail is declared per upstream in the gateway config**, as
  `upstreams[].rail`, defaulting to `card`. It is not an argument, not
  inferred from the tool name, and not something a call can assert. Arguments
  are reachable by whatever compromised the agent; configuration is not. A
  call must not be able to talk its way onto a rail with weaker checks.
- The rail reaches evaluation through an `EvalContext` passed to
  `evaluate_with`, not through `PaymentCall`. `PaymentCall` describes what the
  agent asked for; `EvalContext` describes what the deployment knows. Keeping
  them apart is what makes the previous point enforceable rather than a
  convention.
- **Each upstream may name its own policy**, falling back to the top-level
  one. Policies load and fail independently: an unusable bank policy denies
  bank payments and leaves the card upstream beside it working normally. One
  document cannot sensibly govern a card merchant and a bank beneficiary —
  the fields, the allowlists and the caps are different objects.
- The rail is recorded in every evidence record (ADR 0005 addendum), so a
  reader of a single file can tell a card decision from an on-chain one
  without inferring it from an upstream name that means nothing outside the
  deployment that chose it.
- `Rail::reversible()` states, in one place, the distinction the later work
  hangs on. Nothing reads it yet.

## Consequences

Adding a rail is a config change plus an adapter, not a fork. The provenance
engine, the evidence chain, step-up and resume, reservations and the intent
API are untouched by this ADR: they were already rail-agnostic, and this
records that rather than changing it.

`evaluate` keeps its signature and means "the card rail", so every existing
caller and test is unchanged in behaviour. `evaluate_with` is the honest entry
point. The pilot's config parses as card on every upstream, which a test
asserts against the deployed file.

What this ADR deliberately does **not** do: it does not change any check. A
bank upstream today is evaluated exactly as a card upstream is — the same
amount model, the same permissive treatment of a missing destination, the same
assumption that an ambiguous provider result may be retried. Those are wrong
for an irreversible rail, and each is a separate decision with its own
evidence. This ADR only creates the place where those decisions can be
expressed and makes the rail visible in the record. Tagging first, and
changing behaviour second, is what keeps the card path provably unmoved while
the rest is built.

## Addendum, September 2026: the bank rail is implemented

The first two follow-ons below are done. Assets carry their own exponent and
amounts are `u128` minor units; destinations are typed, canonical and matched
exactly (ADR 0001 addendum). On top of those, the arena runs the whole
scenario corpus against a mock bank: the tool is `transfer`, the arguments are
a beneficiary name and an IBAN, and the policy is its own document. Nothing in
the card path moved, which the cell-by-cell comparison against the published
run is there to keep true.

All three follow-ons below are now done. The third, the outcome state
machine, is ADR 0009: `Rail::reversible` finally decides something, and an
ambiguous provider result on a bank transfer is held and quarantined rather
than released for retry.

What this still does not claim. The replay key is the invoice id on every
rail, where a transfer rail's own reference field would be the natural
one. And no scenario yet follows a transfer that settles later: the two
lost-reply scenarios resolve to failed or to a second attempt, never to a
settlement arriving hours after the fact.

The follow-ons, each needing its own ADR: an asset and amount model
that can represent six- and eighteen-decimal tokens rather than two-exponent
fiat minor units; a typed destination with canonical comparison and
exact-only provenance matching, because substring matching an address is how
address poisoning succeeds; and a provider outcome state machine in which a
broadcast-but-unconfirmed transfer counts as committed rather than retryable.

## Addendum, September 2026: the crypto rails, and binding a network

Two more rails are implemented: `evm` and `solana`, both `Rail::Crypto`,
both irreversible and therefore inheriting every hold-and-quarantine
behaviour ADR 0009 built, without a line of new code deciding that. The
tool is `send`, the destination is an address, and the unit is a token.

Three things are new, and only one of them is a mechanism.

**A network is bound.** `PaymentAuthorization` gains an optional `network`,
and `authorization-network` denies a call that names another one. An
address is not an account on its own: the same twenty bytes exist on every
EVM chain, and value sent to the right address on the wrong network is as
gone as value sent to the wrong address, with the added trap that every
check a person makes by eye still passes. This is the one attack on which
an approved-address book is not merely incomplete but useless — the
address is on the list. The field is absent on every card and bank
authorization, where the check passes and says so, which is why adding it
moved no published cell.

**The amount is read through the field mapping.** `payment_amount` read
the literal arguments `amount` and `currency`. A wallet says `token`, so
no currency was found, so no asset, so no amount — and a payment with no
amount cannot be reserved. Every legitimate chain payment was denied with
a message about reservations that said nothing about the cause. This is
the same bug the bank rail hit with `recipient_account_id` in the previous
addendum, in the one place it had not been fixed, and the reason it took a
whole new rail to find it is that card and bank happen to agree on those
two argument names. It is now read the way the destination is: through the
mapping, falling back to the literal name.

**An allowance is listed as a payment tool.** `approve` grants a spender
the right to move funds later. It is evaluated as a payment of the size it
grants, because that is what it puts at risk, and it is recorded in the
ledger at that amount. What Moat does not do is treat a standing grant as
a different kind of thing from a payment: an allowance for exactly the
authorized amount is allowed and consumes the mandate while leaving the
invoice unpaid. That is a real gap, it is in `docs/attack-backlog.yaml`
under `standing-approval`, and the arena measures the part that does work
rather than claiming the part that does not.

What this still does not claim. There is no on-chain enforcement: Moat
decides and the customer's wallet executes, and a wallet that ignores the
verdict is not stopped by anything here. That is the co-signer design, and
it is not built. Nothing in the arena touches a real network; the testnet
adapters are the next piece of work. And the replay key is still the
invoice id rather than a reference or a memo.

## Addendum, 20 September 2026: binding the contract, not the ticker

The previous addendum closed by naming a gap: the network check bounds
which chain, not which contract on it, so a fake USDC deployed at another
address would pass the asset lookup. `PaymentAuthorization` now takes an
optional `asset_contract`, and `authorization-asset-contract` denies a
call that names another one.

A ticker is a label, not an identity. `symbol()` returns whatever the
contract was written to return, and a contract that returns "USDC" costs
the gas to deploy. A payment in it satisfies every check that reads the
ticker: the payee is right, the address is the supplier's own, the chain
is the approved one, the amount is exact to the minor unit. The supplier
is even credited -- in a token nobody will buy. A cap cannot see it,
because any amount of a worthless token is under any cap, and an
allowlist cannot see it, because the destination is on the list. It is
the lookalike payee one layer down, and a wallet that displays symbols
shows the user nothing wrong.

Three decisions worth recording.

It is compared through `Destination`, so an address is matched as an
address rather than as text: hex casing is a checksum and not an
identity, while a Solana mint's base58 is case-sensitive and is compared
as written. That is the same canonicalisation the destination uses, which
is the point -- a contract address is an address.

It fails closed on silence. Where the authorization binds a contract and
the call names none, the check denies. This is the opposite of the
network check's tolerance for an unbound authorization, and the
difference is deliberate: an authorization that binds nothing is an old
authorization, while a call that says nothing about which contract it is
spending is a call whose asset is unknown.

It is absent by default, so every fiat authorization and every
authorization written before the field existed passes and says so. The
golden evidence bytes did not move.

What this still does not claim. The field has to be filled to bind
anything: an authorization that names only a ticker is as weak as it was,
and nothing yet requires the approver to name a contract. The registry's
own per-asset contract is not consulted -- the binding is to what the
authorization says, not to what the policy believes USDC to be. And on
the testnet adapter the contract comes from configuration rather than
from the call, so there the agent cannot choose one; making that
demonstrable end to end means letting the wallet be asked for a contract
and letting Moat be the thing that refuses, which is the adapter's stated
philosophy and is not yet done.

## Addendum, 26 September 2026: the contract is required, and the policies read it

The field existed and nothing used it: no shipped policy mapped
`asset_contract`, no wallet took a contract as an argument, and every token
authorization was registered by ticker alone. The five crypto policies now
read it from `token_address` or `mint`; the arena's mock chain and the Base
Sepolia wallet accept those arguments and refuse a contract they do not hold
the token in; and the intent API refuses to register a token authorization
without one, the chain's own coin excepted. A wallet that can only be told a
symbol cannot make a token payment under an authorization until it can be
told a contract, and that is the point.
