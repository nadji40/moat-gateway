# Contributing to Moat

Thanks for looking. Moat is small enough that a good pull request from a
stranger can change what it is, and disciplined enough that a careless one
cannot. This page is the discipline.

## Ground rules

- **Sign your commits off (DCO).** Every commit needs a `Signed-off-by:` line
  with your real name and email, which `git commit -s` adds for you. It says you
  wrote the change or have the right to submit it under the project licence
  (Apache-2.0, see `LICENSE`). We do not use a CLA.
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
