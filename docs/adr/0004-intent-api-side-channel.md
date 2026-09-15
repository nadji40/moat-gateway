# ADR 0004: The intent API is a side channel, not parsed from the MCP stream

- Status: accepted
- Date: 2026-09-15

## Context

Provenance resolution (ADR 0001) needs to know what the human asked for. The
only values that can resolve to `User` are the ones that appear in registered
intent text. Where does that text come from?

The MCP stream between host and gateway carries `tools/list`, `tools/call`,
and the results. It does not carry the user's prompt: the host sends the prompt
to the model, not to the MCP servers. Two ways to get it:

1. **Infer it from the MCP stream.** Watch `tools/call` arguments, sampling
   requests, or `_meta` fields for text that looks like the user's request.
2. **A separate HTTP endpoint** on the gateway that the host calls explicitly
   with the user's text.

## Decision

The host tells Moat what the human asked for through a **separate, explicit
HTTP API** (`POST /v1/session/{id}/intent`). The same API carries the answers
to step-ups (`resume`) and the headless flag. Nothing on the MCP stream is ever
treated as an intent.

## Rationale

**Everything on the MCP stream is either from the model or from a tool.** By
the time text reaches a `tools/call` argument it has passed through the model,
and the model's context already contains every page it fetched. A `tools/call`
argument that says "the user asked me to pay ProMon Billing Ltd" is exactly
what an injection produces. Treating any of that as `User` would collapse the
trust order that the whole system rests on: the untrusted channel would be able
to mint trusted values. The intent API is a different socket, called by
different code (the host's own, not the model's), before or independent of
anything the model does. That separation is the security property, not an
implementation convenience.

**MCP has no place for it.** Revision 2026-07-28 removed `initialize` and with
it any connection-scoped "here is who I am and what I want" message. The
spec's `_meta` keys are reserved for protocol use. Sampling and elicitation are
server-initiated. There is no client-to-server message whose meaning is "the
human said this"; inventing one would mean a Moat-specific MCP extension that
every host would need to implement inside its MCP client.

**The host has the text and the host is trusted.** The host is the one
component that saw the human type. It is also the component that runs Moat as
a subprocess and can therefore already do anything Moat can. Giving it a plain
HTTP call costs nothing in trust and nothing in integration: it is one request
per turn from code the host author controls.

**Explicit beats inferred for evidence.** An evidence record that says
`payee -> User (intent:2)` is only meaningful if `intent:2` is text the human
produced, registered at a known time. An inferred intent would need its own
provenance argument. The side channel makes "this is what the user asked for"
a statement the host is accountable for.

## Consequences

- **Without a registered intent, every payee resolves to `Unknown` or
  `ToolResult`, and every payment steps up or is denied.** This is the correct
  default and the README says so. A Moat that has not been told what the human
  wanted has no basis for trusting any payee.
- Hosts need one integration point beyond "add an MCP server to the config":
  a `POST` per user turn. The session id is fixed in config or printed to
  stderr at startup so the host can find it.
- The API is bound to localhost with no authentication. On a single-user
  machine, localhost is the trust boundary the host already relies on. It is
  not sufficient for shared hosts or containers with published ports;
  authentication is future work and the README says that too.
- The host can lie. It can register "pay Evil Corp" as an intent and Evil Corp
  becomes `User`. Moat does not defend against a malicious host; it defends
  against a compromised model. The host's honesty is a precondition, recorded
  in the evidence by way of the intent hashes.
- Resume rides the same channel for the same reason: an approval must come
  from code the human controls, never from the model's turn.
