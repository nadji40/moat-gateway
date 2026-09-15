# ADR 0002: MCP protocol handling — target the wire, not an era

- Status: accepted
- Date: 2026-09-15

## Context

`moat-mcp` was written against the MCP specification at
<https://modelcontextprotocol.io/specification/2026-07-28>, read on 2026-09-15.
That revision is a larger change than usual and it lands in the middle of this
project's dependency set, so the state of the world needs recording.

**What revision 2026-07-28 changed.** The `initialize` / `notifications/initialized`
handshake is gone. Every request now carries its protocol version and the
client's capabilities in `params._meta` under
`io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities`. Servers answer `server/discover`
instead of `initialize`. Every result carries `resultType` (`"complete"` or
`"input_required"`). Servers no longer send JSON-RPC requests to clients at all
— sampling and elicitation ride inside results. Streamable HTTP lost its GET
stream, its `Mcp-Session-Id` sessions and `Last-Event-ID` resumption, and gained
mandatory mirrored headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`)
that the server must validate against the body. The spec calls these
"modern" versions; `2025-11-25` and earlier are "legacy". Batching was already
gone (removed in 2025-06-18).

**What the ecosystem speaks.** On the day this was written:

| Component | Version | Era |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` (TypeScript) | 1.30.0, published 2026-07-27 | Legacy. `LATEST_PROTOCOL_VERSION` is `"DRAFT-2026-v1"`, negotiates down to `2025-11-25`; no `server/discover`, no per-request `_meta`. |
| `@anthropic-ai/claude-agent-sdk` | 0.3.273 | Uses the TypeScript SDK above for MCP. |
| `@openai/agents` | 0.18.0 | Uses the TypeScript SDK above for MCP. |

So the arena's mock servers and both agent backends will open with
`initialize` and expect a legacy server. A gateway that spoke only the current
spec would not interoperate with anything we can test against.

**What a proxy actually needs.** Moat does not implement MCP features. It
forwards. The methods it must understand well enough to act on are:

- `tools/list` responses — to namespace tool names when aggregating upstreams.
- `tools/call` requests — to route by namespace, and to intercept payments.
- `tools/call` responses — to register every string and number as observed.
- `initialize` (legacy) and `server/discover` (modern) — to present the
  aggregate of its upstreams as one server.

Everything else is bytes with an id.

## Decision

1. **`moat-mcp` models the wire, not a protocol version.** Its message type is
   the four JSON-RPC shapes MCP allows (request, notification, response, error)
   with ids constrained to string-or-integer and batches rejected. It keeps the
   raw line beside every parsed message so the gateway can forward
   byte-for-byte.

2. **Typed views are lossless.** `Tool`, `ListToolsResult`, `CallToolParams`,
   `CallToolResult`, `InitializeResult` and `DiscoverResult` each carry a
   flattened `extra` map. A `resultType`, a `_meta`, an `icons` array or a field
   invented next year survives a rewrite of the one field we touch.

3. **Both eras are understood; neither is enforced.** The crate exposes
   constants for `2025-11-25` and `2026-07-28` and typed shapes for both
   handshakes. It does not validate that a request carries `_meta`, does not
   reject `initialize`, and does not add `resultType`. Whether a client is
   legacy or modern is the upstream's problem; the gateway relays the
   negotiation faithfully.

4. **The gateway's own requests use string ids prefixed `moat:`.** Client ids
   are forwarded unchanged so responses and `notifications/cancelled` correlate
   without a translation table. The prefix keeps gateway-originated traffic
   (per-upstream `initialize`, `tools/list` aggregation) from colliding with
   client ids, which the spec only requires to be unique per sender.

5. **stdio framing is the spec's**: one UTF-8 JSON-RPC message per line, no
   embedded newlines, nothing on stdout that is not a message, stderr is free
   text. The reader caps a frame at 32 MiB so a peer that never sends a newline
   cannot exhaust memory. Shutdown is close-stdin, wait, kill.

6. **HTTP transport (step 11) targets Streamable HTTP as specified in
   2026-07-28** for the listen side, with the legacy `Mcp-Session-Id` / GET
   stream shape available for legacy clients since those are what today's SDKs
   send. The deprecated 2024-11-05 HTTP+SSE transport is not implemented.

## A conflict with the brief that needs a decision

The work order assigns Moat's JSON-RPC error codes as `-32050` (step_up) and
`-32051` (deny). Revision 2026-07-28 reserves `-32020` to `-32099` exclusively
for the MCP specification: "Implementations **MUST NOT** emit any code from this
sub-range that is not defined by this specification." It further says
application codes "SHOULD be allocated outside the JSON-RPC reserved range
(`-32768` to `-32000`)".

`-32050` and `-32051` are therefore forbidden by the current spec. They are
defined in one place (`moat_core::verdict::code`, step 7) so the choice is a
one-line change. This ADR does not decide it; the options are recorded here:

- **Keep `-32050`/`-32051`** as specified in the brief. Works with legacy SDKs,
  which do not police the range. Non-compliant with 2026-07-28 and at risk of
  colliding with a future spec-defined code.
- **Move outside the reserved range**, e.g. `-31050`/`-31051` (keeps the mnemonic,
  compliant) or a positive range.

Recommendation: move. The brief's numbers predate the spec's partition.

## Consequences

- A modern client with a legacy upstream, or vice versa, is not bridged. The
  spec's compatibility matrix says that pairing fails without a dual-era
  server; the gateway passes the failure through rather than pretending.
- When the TypeScript SDK ships modern support, the gateway needs no change to
  keep forwarding; only the aggregated `server/discover` response needs to
  exist, and it is planned in step 3 alongside aggregated `initialize`.
- The fake server used in tests (`moat-fake-mcp-server`) is legacy-era on
  purpose, because that is what the real fixtures will be.
