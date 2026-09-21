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
