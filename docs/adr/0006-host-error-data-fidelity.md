# ADR 0006: Not every host forwards `error.data`, and step-up has to survive that

- Status: accepted
- Date: 2026-09-16

## Context

[ADR 0003](0003-step-up-as-jsonrpc-error.md) decided that a step-up is a
JSON-RPC error with the detail in `error.data.moat`: the prompt to show a
human, the evidence id, and the resume token the host plays back through the
intent API. That decision assumed the host can read `error.data`.

Wiring the OpenAI Agents SDK into the arena (work order step 10) showed that
this assumption does not hold for at least one real host. When an MCP tool
call returns a JSON-RPC error, the SDK does not surface the error object to
the calling code. It converts it to a string and feeds that string to the
model as the tool's output. What arrives is:

```
An error occurred while running the tool. Please try again.
Error: ProtocolError: Moat: payment needs human approval
```

The code (`-31050`) is gone. `data.moat` — prompt, `evidence_id`,
`resume_token` — is gone. Only `error.message` survives, and it survives in
the one place ADR 0003 argued a step-up should never go: the model's context.

## What this does and does not break

**The security property holds.** The upstream was never called, so no payment
happened, and the agent is told the call was refused. Measured in the arena:
with the gateway, an injected payee is not paid. That is the claim Moat
makes, and it is unaffected.

**The resume flow does not hold.** A host that cannot see the resume token
cannot complete a step-up. For such a host, `step_up` is indistinguishable
from `deny` in practice — a refusal it can report but not resolve. That is
safe, and it is also less useful than intended.

**A second-order problem.** Because the message reaches the model, the model
may react to it: retry with a different payee, paraphrase it to the user, or
claim approval was obtained. Nothing it does can resolve the step-up — the
token only exists host-side and the next call is evaluated afresh — but the
message is now attacker-adjacent text in the model's context. This argues for
keeping `error.message` short, factual and free of anything resembling an
instruction.

## Decision

1. **Keep the structured payload in `error.data`.** It is correct, it is what
   the spec provides for, and hosts that read it get the full flow. ADR 0003
   stands.

2. **Treat `error.message` as a load-bearing interface, not decoration.**
   For hosts that drop `data`, the message is the entire signal. It must:
   - name Moat, so the refusal is attributable rather than a mystery failure;
   - state the verdict in words (`needs human approval` / `denied`);
   - contain no instruction, no payee, no amount, and no token, because it
     may be read by a model whose context is already compromised.

   The current strings satisfy this and are now pinned as constants in
   `arena/runner/src/mcp.ts` alongside the codes, with a pointer back to
   `crates/moat-gateway/src/proxy.rs`. Changing them is an interface change.

3. **The arena recognises a verdict by message first, code second.** This is
   deliberately the degraded path, because it is the one a real host takes.
   Recognising only the code would have made the arena measure something no
   host experiences.

4. **Document the integration requirement.** A host that wants step-up rather
   than refusal must read `error.data.moat`. The README says so, and says
   what happens if it does not.

## Addendum (2026-09-16, step 11)

The loss is in the Agents SDK's tool-error wrapping, not in MCP or its SDK.
The MCP TypeScript SDK's own `StreamableHTTPClientTransport`, tested against
the gateway's HTTP listener, throws `McpError` with `code` and the full
`data.moat` payload — resume token included. A host that uses the MCP SDK
directly, or any client that surfaces the JSON-RPC error object, gets the
complete step-up flow. The degradation described above applies to hosts that
put an agent framework between the MCP client and their own code and let it
flatten errors on the way through.

## Consequences

- Moat's usefulness is bounded by the host's error fidelity, and we cannot
  detect from inside the gateway whether a host preserves `data`. A host that
  silently drops it looks identical to one that reads it and declines to
  resume.
- Step-up degrading to refusal is the safe direction, which is why this is an
  accepted limitation rather than a blocker. A host that does nothing gets a
  blocked payment; it never gets a wrong one.
- If a future revision of MCP defines a structured way for a server to carry
  actionable detail through an error — or if enough hosts converge on
  preserving `data` — the fallback can be dropped. Until then the message is
  part of the contract and changing it breaks host integrations that match
  on it.
- This is a good argument for the arena existing. The property was verified
  by unit tests and an integration test against our own fake server, both of
  which read `error.data` correctly, and it still failed against the first
  real SDK we tried.
