# Contributing to Moat

Thanks for looking. Moat is small enough that a good pull request from a
stranger can change what it is, and disciplined enough that a careless one
cannot. This page is the discipline.

## Ground rules

- **Sign your commits off (DCO).** Every commit needs a `Signed-off-by:` line
  with your real name and email, which `git commit -s` adds for you. It says you
  wrote the change or have the right to submit it. We do not use a CLA.
- **No secrets, ever.** Not in code, tests, fixtures, docs or commit messages.
  Provider keys come from the environment; `.env*`, `keys/` and evidence logs
  are ignored by git for a reason. A pull request that adds one is closed and
  the key is assumed burned.
- **Claims match evidence.** If a change affects what Moat catches or lets
  through, the pull request says so and the arena run that shows it is attached.
  "Should be more secure now" is not a description.

## Building and testing

Stable Rust, Node 22 or later with pnpm, Python 3.11 for the analysis tools.

```bash
cargo build --release -p moat-gateway
cd arena && pnpm install
```

Before you open a pull request, this must be green, exactly as CI runs it:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd arena && pnpm test && pnpm typecheck
```

The gateway tests spawn real processes and bind ports 7071, 7072 and 7100;
nothing else may be listening there while they run.

## What goes where

| you are changing                                | it lives in                | it needs                                      |
| ----------------------------------------------- | -------------------------- | --------------------------------------------- |
| provenance, policy, verdicts, evidence          | `crates/moat-core`         | a unit test; a golden-file update if the evidence bytes change |
| MCP types or framing                            | `crates/moat-mcp`          | a round-trip test                             |
| transports, interception, intent API, storage   | `crates/moat-gateway`      | an integration test under `tests/`            |
| an attack, a control, the runner, the mocks     | `arena/`                   | a run showing the result, per arm             |
| how results are computed                        | `arena/analysis/tables.py` | the notebook imports it; change it there only |
| an architectural decision                       | `docs/adr/`                | a new numbered ADR; do not edit old ones      |

`moat-core` must stay free of MCP and gateway knowledge; that is what lets it be
wrapped by other runtimes later. If a change to it needs an import from the
gateway, the change is in the wrong place.

## Adding an attack

An attack is a directory `arena/attacks/<id>/` with an `attack.yaml` and the
page(s) it needs. The id is lowercase with hyphens and matches the directory.
Every attack states the user's task, the pages, the payee who must **not** get
paid (`expected`) and the calls a fully compromised agent would make
(`injection.calls`). See any existing one for the shape; `attacks.ts` validates
it strictly and will tell you what is missing.

A good attack is one that a real control might plausibly miss. Before adding a
variant of an existing class, check whether it changes any arm's result. If it
does not, it is a duplicate, not coverage.

## Adding a legitimate control

Controls live in `arena/controls/<id>/control.yaml` and describe a payment that
**should** complete. They are how we measure what a control costs, not only
what it catches, and they are under-represented. A control passes only when
exactly the intended payment set completes and nothing else.

## Evaluation arms

The runner drives every scenario through each arm under identical conditions:
`none`, `cap`, `allowlist`, `moat`. The baseline arms register no intent and
no authorization by design. Pull requests that make a baseline arm smarter are
declined: the comparison is only meaningful while those arms are what a
payment rail already offers.

## Settlement rails

A rail is how the money leaves: `card`, `bank`, `crypto`. It is declared per
upstream in the gateway config and never taken from a call argument — a
payment must not be able to select the rail whose checks it prefers. The
arena names four, because `crypto` is two families with different address
shapes: `card`, `bank`, `evm`, `solana`.

Adding a rail is a new entry in `arena/runner/src/rails.ts`, a block of
fixtures in `arena/rails/fixtures.json`, a mock package and a set of policies.
It is not edits spread through the runner: if you find yourself special-casing
a rail outside its `RailSpec`, the registry is missing a field.

Write a scenario once. Anything that is a property of the rail rather than of
the attack — the asset, the currency symbol, an account — is a `{{rail.*}}`
placeholder, and the arguments are the canonical ones (`payee`,
`recipient_account_id`, `currency`), which expansion renames to whatever that
rail's tool takes. Two corpora would drift within a month, and the moment
they did the comparison between rails would stop meaning anything.

Read arguments through the policy's field mapping, never by literal name.
This has now been the same bug twice: the destination check read
`recipient_account_id` and broke on a rail calling it `beneficiary_iban`,
and `payment_amount` read `currency` and broke on a rail calling it `token`
— which denied every legitimate chain payment with a message about
reservations. Card and bank agree on most argument names, so a new rail is
where these surface. If a new rail's controls all fail, look here first.

A rail's baseline arms are that rail's own controls, not a copy of the card
ones. Giving a rail a weaker baseline than the one it ships in production
inflates Moat's result, and an inflated number is the first thing a reviewer
takes apart. Where a baseline differs between rails, say so in
`arena/analysis/README.md`.

The card numbers are the regression: `--rails card` across all four arms must
reproduce the published run cell for cell. Compare against the committed
baseline in `arena/analysis/data/` before opening a pull request.

## Outcomes

Two questions about a payment are not the same question, and the code keeps
them apart deliberately. *What did the provider say* is an observation and
lives in `OutcomeStatus`. *Does this count against the mandate* is a
decision, depends on whether the rail can reverse, and is made in exactly
one place: `OutcomeStatus::disposition`. If you find yourself deciding it
anywhere else, move the logic there instead.

Anything a provider says that Moat does not recognise is `Unknown`, never
`Failed`. Adding a synonym to the mapping table is fine. Making the
fallback anything other than `Unknown` is how a lost reply becomes a second
payment.

A change that touches this must show both rails: the same provider failure,
held on a transfer and retryable on a card. That pair is in
`crates/moat-gateway/tests/hold.rs` and a new behaviour belongs beside it.

## Policy changes

A change to `policies/default.yaml` changes the published numbers. It ships
with a fresh arena run across all arms, the manifest, and a sentence in the
pull request about what moved and why.

## Style

Match the code around you. Rust is `rustfmt` with Clippy warnings denied;
TypeScript is strict and typechecked. Comments explain why, not what. Commit
messages follow the existing history: a short conventional prefix
(`feat(gateway):`, `fix(core):`, `test(arena):`, `docs:`), a body that says what
changed and what it means, and your sign-off.

## Reporting security issues

Not here. See `SECURITY.md`.
