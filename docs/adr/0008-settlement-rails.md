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
