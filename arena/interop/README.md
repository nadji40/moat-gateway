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
