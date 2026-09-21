# interop

What the other agent-payment protocols can and cannot decide, tested against
their own code rather than described.

Each probe asks one question, holds everything else constant, and prints what
it asked so the run can be checked rather than believed.

## x402

```bash
pnpm --filter @moat/interop x402
```

Builds two x402 payments that differ only in where the money goes: one to the
address the user approved, one to an address the user never named. Both are
built by x402's own client and verified by x402's own `ExactEvmScheme`, at the
versions in `package.json`. Then the same two destinations are put to the real
`moat-gateway` binary on the arena's EVM rail.

**What is real:** the x402 packages, the payload construction, the EIP-3009
typed-data signature, the signature recovery (viem, offline), the scheme's
`verify()` called unmodified, and the whole Moat half — real binary, real
policy, real intent and authorization.

**What is not:** two chain reads. `verify()` asks for the payer's USDC balance
and whether the authorization nonce has been used, and a throwaway key on a
public testnet has neither. A stub answers "funded, unused" and records every
call it receives, which the run prints. The substitution is deliberate: the
question is about the destination, so the funding question has to be removed
rather than allowed to fail first and hide the answer.

**Fairness.** The Moat half runs each destination in its own gateway session.
Sharing one would let the first payment spend the mandate, so the second would
be refused as a duplicate as well as for its destination, and the result would
no longer isolate the single variable under test.

x402 is not doing this job badly. It is not doing this job: the protocol has no
field for what the user asked for, and `payTo` is supplied by the resource
server being paid.

## AP2

```bash
uv venv .venv && VIRTUAL_ENV=.venv uv pip install "git+https://github.com/google-agentic-commerce/AP2.git@main"
.venv/Scripts/python.exe src/ap2_probe.py
```

Three questions put to AP2's own constraint evaluators, imported from the SDK
and called unmodified. Nothing is reimplemented and nothing is stubbed.

| | AP2 |
|---|---|
| a homoglyph merchant, against an allowlist the user authored | **catches it** |
| the real merchant, at 499 where the user approved 480 | verifies |
| the attacker, allowlisted by a mandate the agent wrote from the page | verifies |

The first result is a real check working and should be reported as such:
`merchant_matches` compares by id, or by name and website, exactly, so a
lookalike name is a different merchant.

The third is the one that matters. The chain verifies that the checkout
matches the constraints; it has no opinion about where the constraints came
from, and in an agent flow they are authored from content the agent read.

That is the shape of the allowlist arm in the arena's own table: it catches a
wrong name and it does not catch a right name doing the wrong thing. AP2 is
not doing this badly. Provenance is outside what it is for.

## Injection classifiers

`pnpm --filter @moat/interop classifier`

Not a product comparison, and no model is downloaded. The detector here is a
deliberately generous one: it never misses an instruction, because the
instructions were written into this corpus and it is handed the patterns for
them. HTML comments and `alt` text are extracted before tags are stripped,
since that is where three of these attacks hide their payload.

Over all 21 attacks, 9 put an instruction on the page and 12 put nothing there
to object to. Three of the nine matched only a line of the form "pay Supplier
Ltd", which every real invoice carries, and are counted anyway; the arena's
controls are too terse to price that, so the cost of reaching nine is untested
rather than zero.

The twelve are the argument. An invoice quoting 499 where the user approved
480 is not lying about anything a reader could check, so there is no sentence
to flag. Every match is printed and every unflagged page is listed with its
class. `--model <hf-id>` runs a real classifier over the same pages.
