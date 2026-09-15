# ADR 0003: A step-up is a JSON-RPC error, not a modified tool result

- Status: accepted
- Date: 2026-09-15

## Context

When Moat decides a payment needs a human, the gateway has to tell the agent
host something. There are two shapes it could use on the MCP wire:

1. **A tool result.** Return a normal `tools/call` response whose content says
   "this payment needs approval; ask the user and call again with token X",
   possibly with `isError: true`.
2. **A JSON-RPC error.** Return an error response with a Moat-specific code
   (`-31050`) and the details in `error.data`.

The same choice applies to `deny`.

## Decision

Step-up and deny are **JSON-RPC errors** with Moat-specific codes and a
structured `error.data.moat` payload. The upstream is never called, so there
is no upstream result to modify or synthesize.

## Rationale

**A tool result goes to the model. An error goes to the host.** MCP's tool
spec draws exactly this line: tool execution errors (`isError: true`) are
"actionable feedback that language models can use to self-correct and retry",
and clients "SHOULD provide tool execution errors to language models". Protocol
errors are the ones clients "MAY" show the model and are aimed at the
application. A step-up is a request for a *human*, delivered through the
*host*. Handing it to the model as text invites the model to "handle" it: to
paraphrase the prompt, to reassure the user, to retry with a slightly changed
payee, or — under the same injection that caused the step-up — to claim the
human approved. Nothing in the model's response should be able to resolve a
step-up, and the surest way to guarantee that is to never put the step-up in
the model's context in the first place.

**A synthesized result would be a lie about the upstream.** The gateway's
contract is that a `tools/call` result came from the tool. A fabricated result
breaks that for the one call where the truth matters most. The evidence
record would say "not forwarded" while the transcript shows a tool result;
that is the kind of discrepancy an audit is supposed to catch, not create.

**Errors carry structure without inventing a schema for content.** JSON-RPC
`error.data` is free-form by design. The host reads `data.moat.verdict`,
`data.moat.prompt`, `data.moat.resume_token` and `data.moat.evidence_id`
without parsing prose. A tool result would have to smuggle the same fields into
`content` text or `structuredContent`, neither of which the host is expected to
interpret.

**Hosts already have an error path.** Every MCP client handles a JSON-RPC
error on `tools/call`; the worst case is that a host that knows nothing about
Moat surfaces "Moat: payment needs human approval" to its user, which is the
correct behaviour for a host that has not integrated the resume flow.

## Consequences

- A host that wants the full flow must recognise code `-31050`, show
  `data.moat.prompt`, and call the intent API's `resume` endpoint with the
  token. Until it does, every step-up is a refusal. That is the safe default.
- The agent sees the error as the host chooses to present it. Most hosts
  relay an error string to the model; the model learns the call was refused,
  which is true, but has no token to replay. The token exists only on the
  host side.
- The resumed call is a *new* `tools/call` with a new id. Moat does not replay
  the original; it registers the approved values as `User` and evaluates the
  next identical call normally. This keeps one code path for evaluation and
  means the evidence for the resumed call shows `payee -> User (intent:N)` with
  the confirming intent, which is what happened.
- The error codes had to move out of the MCP-reserved range (ADR 0002). Codes
  are the one part of this design that a spec revision can invalidate; the
  `data.moat` payload is not.
