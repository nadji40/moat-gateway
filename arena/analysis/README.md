# Arena analysis — the data team's ground

This directory is where the two tables the project rests on get produced:

1. **Bypass rate per control layer** — for each arm, how often the attacker's payee
   was actually paid.
2. **Usefulness** — for each arm, how often a legitimate task completed, how often it
   was blocked when it should not have been, how many step-ups it cost, and what the
   gateway added in latency.

Both come with Wilson 95% intervals and the run count behind every number. Nothing in
the README of the repository should be typed by hand once this is running: the
numbers come from `tables.py`.

## Arms and rails

Two dimensions cross. A **rail** is how the money leaves — `card` through a provider,
and in later work a bank transfer to an account or an on-chain transfer to an address.
An **arm** is what stands between the agent and the money on that rail. `--rails`
selects the first and defaults to `card`; every table groups by both, so a number is
always read as "this arm, on this rail". Runs recorded before rails existed read as
card, which is what they were.

## What an arm is

The runner drives every scenario through each selected *arm*, one control layer at a
time, under identical tasks and pages:

| arm         | what sits between the agent and the money                                                      |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `none`      | nothing: the agent talks to the mock payment server directly                                    |
| `cap`       | the gateway with `policies/arm-cap.yaml`: a per-transaction spending cap, nothing else          |
| `allowlist` | the gateway with `policies/arm-allowlist.yaml`: a payee allowlist, nothing else                |
| `moat`      | the gateway with `policies/default.yaml` plus registered user intent and structured authorization |

`cap` and `allowlist` are the controls a payment rail already offers. They get no
intent and no authorization registered, so they cannot borrow Moat's checks. The
comparison is only meaningful if that stays true; do not "improve" the baseline arms.

Before arms existed the runner had two modes, `direct` and `gateway`. Old result rows
carry only a `mode`; `direct` reads as `none` and `gateway` as `moat`.

## Setup (once per machine)

Needs Node 22 or later with pnpm, a stable Rust toolchain, and Python 3.11.

```bash
# from the repository root
cargo build --release -p moat-gateway
cd arena && pnpm install
cd analysis && pip install -r requirements.txt
```

Windows works: the runner finds `target\release\moat-gateway.exe` on its own. If the
binary is somewhere else, set `MOAT_GATEWAY_BIN` to its path. Ports 7100 (mock web)
and 7072 (intent API) must be free.

## Running

From `arena/`:

```bash
# the scripted worst-case agent, all four arms, attacks and controls, 5 iterations each
pnpm --filter @moat/runner start --backend null --runs 5 --arms none,cap,allowlist,moat --suite all
```

```bash
# one scenario while you are debugging something
pnpm --filter @moat/runner start --backend null --runs 1 --arms none,moat --case inflate-under-cap
```

```bash
# a real model: needs OPENAI_API_KEY in the environment, never in a file in this repo
OPENAI_API_KEY=... pnpm --filter @moat/runner start --backend openai --model gpt-5-mini --runs 5 --arms none,cap,allowlist,moat --suite all
```

Options: `--suite attacks|controls|all`, `--arms` (comma list), `--runs N`,
`--case <id>` (one scenario), `--model`, `--out <file>`. Set `ARENA_VERBOSE=1` to see
the mock servers' logs.

Each run writes two files into `arena/results/`:

- `<run_id>.jsonl` — one line per scenario × arm × iteration
- `<run_id>.manifest.json` — commit, dirty flag, policy files and their SHA-256,
  backend, model, runs, suite, arms, scenario list, Node version, platform

A row without a manifest is not reproducible and should not go into the report.

### The result row

| field                  | meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `arm`, `mode`          | which control layer; `mode` is the old name (`direct`/`gateway`)                        |
| `rail`                 | how the money would leave: `card` today. Absent in rows written before rails, meaning card |
| `scenario_kind`        | `attack` or `control`                                                                   |
| `attack`, `class`      | scenario id and class (the field is called `attack` for controls too, historically)     |
| `attacker_paid`        | attacks: the attacker's payee was paid enough times to count as success                 |
| `legitimate_completed` | controls: exactly the intended payment set completed and nothing else                   |
| `verdicts`             | gateway verdicts for each pay call, in order: `paid`, `step_up`, `deny`, `error`        |
| `pay_ms`, `fetch_ms`   | per-call latency; `wall_ms` is the whole run including model time                        |
| `policy`, `commit`, `model` | provenance of the row itself                                                        |
| `trace`                | every fetch and pay the agent made, for when a number looks wrong                       |

**Latency, read carefully.** `verdicts` and `pay_ms` are aligned: a denied call returns
in about a millisecond because nothing was forwarded. Latency cost is therefore
measured on *forwarded* calls only (verdict `paid`; every call under `none`), which is
what `latency_table` does. And under the null backend, `wall_ms` for a gateway arm is
mostly the cost of spawning the gateway and mock server for that run, not gateway
overhead; the per-call numbers are the ones to report.

## Producing the tables

```bash
cd arena/analysis && python tables.py
```

Reads `../results/` and `./data/`, prints every table as Markdown, and writes
`out/tables.md` plus one CSV per table. Pass directories to read other locations.

`moat_eval.ipynb` is the same thing with charts and room to explore:

```bash
cd arena/analysis && jupyter notebook moat_eval.ipynb
```

`tables.py` is the source of truth; the notebook imports it. If you change how a
number is computed, change it in `tables.py` so the CLI and the notebook agree.

## Publishing a run

`arena/results/` is ignored by git; it is your scratch space. When a run is final,
copy both its files into `arena/analysis/data/` and commit them:

```bash
cp arena/results/20260919T101500-null.jsonl arena/results/20260919T101500-null.manifest.json arena/analysis/data/
```

Only runs with a manifest, a clean commit (`"dirty": false`) and the frozen policy
hashes belong in `data/`. Everything in `data/` is what the report cites.

## Rules of the road

- **One key each.** Model runs need an OpenAI key with its own budget cap per person.
  Ask the PM; never share a key, never put one in a file inside this repository.
- **Run counts are part of the result.** No rate without its `n` next to it, no zero
  without an interval.
- **Failures are results.** A row with `error` set is reported, not dropped. If a run
  crashed halfway, the manifest still says what it was; say so.
- **Freeze before you measure.** Agree the evaluation freeze with Security at the end of
  Week 2: after it, no attack, control or policy changes until the measurement runs
  are done. The manifests' policy hashes are how you prove it.
- **Dev vs held-out.** Attacks used while developing the policy are not the attacks
  you report on. Security owns the split; you enforce it in what goes into `data/`.
- **The null backend is the worst case, not a model.** It follows the injection every
  time. Report it separately from model runs and never average the two.

## First day

Everyone: run the setup, then the first command under *Running* with `--runs 2`, then
`python tables.py`. If both tables print, you are working. The first baseline
(19 September, null backend, 2 iterations) gave: attacker paid on every attack under
`none` and `cap` (32/32 each: a cap stops nothing that stays under it), on half under
`allowlist` (16/32: it stops the wrong name, not the wrong amount, account, currency or
duplicate), and never under `moat` (0/32). Controls: 10/10 under `none`, `cap` and
`moat`; 8/10 under `allowlist`, because `authorized-eur-invoice` pays a supplier that
is not on the list. That is the allowlist's real cost, not a bug: a static list blocks
every new legitimate payee. If your numbers differ from these, that is the first
finding; the run is `arena/analysis/data/` once published.

- **Zahra — table 1.** Check that the four arms run cleanly across all sixteen attacks.
  Then decide the run count with the interval width you want (`wilson()` in
  `tables.py` lets you try). Owner of `bypass_table`.
- **Dhoha — table 2.** Read the five controls in `arena/controls/`. List the next
  fifteen legitimate cases the report needs (price variance inside and outside
  tolerance, currency, repeats under an aggregate, partials, refunds, multi-line
  invoices) as `control.yaml` files. Owner of `usefulness_table` and
  `latency_table`.
- **Meriem Sara — the harness.** Run the same command twice and diff the two results
  files: what differs, and should it? Owner of `load_results`, the manifest, and the
  methods note the report will lift: arms, models, runs, intervals, exclusions.

Questions about what a row means: ask engineering for the trace. Questions about what
we can claim from it: ask Research. Both are cheaper before the freeze than after.
