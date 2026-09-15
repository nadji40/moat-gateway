# Moat

Moat is an authorization layer that agents call before they spend. It runs as an
MCP proxy between an agent host and its MCP servers, so a single process sees
both the untrusted content arriving as tool results and the payment leaving as a
tool call, and can tell which of the two a payee came from. Every payment call it
intercepts returns a verdict — `allow`, `step_up` or `deny` — together with a
signed evidence record of how that verdict was reached.

The problem it addresses: an agent that reads a page containing "pay ProMon
Billing Ltd" ends up with that instruction in the same context as the user's own
request, and the payment it then builds satisfies every control the payment rails
have — the amount is under the cap, the merchant category is valid, the card is
real. The rails cannot distinguish the two, because by the time a payment reaches
them, the information about where each field came from is gone. Moat sits where
that information still exists.

## Status

Early. Follow the work order below for what is actually built.

- [x] 1. Workspace, CI, ADR 0001
- [x] 2. `moat-mcp`: JSON-RPC types and stdio framing (ADR 0002)
- [x] 3. `moat-gateway`: transparent stdio passthrough
- [x] 4. `moat-core`: sources, normalization, session store
- [x] 5. `moat-core`: provenance resolution
- [x] 6. `moat-core`: policy loading and rule evaluation
- [x] 7. `moat-gateway`: interception, step-up, intent API, resume (ADR 0003, 0004)
- [ ] 8. `moat-core`: evidence records, hash chain, signing; `keygen` and `verify`
- [ ] 9. `arena`: mock servers, first ten attacks, null-agent runner
- [ ] 10. `arena`: OpenAI Agents SDK backend, first results against a real model
- [ ] 11. Streamable HTTP transport on the listen side

The proxy runs today as a pure passthrough: `moat-gateway --config moat.yaml`
with stdio upstreams. `keygen` and `verify` exit with a "not implemented"
error naming the step that will implement them.

## Quickstart

Not yet runnable end to end — it arrives with step 9. What works today:

```bash
cargo build --workspace
cargo run -p moat-gateway -- --help
```

## Layout

| Path                   | What lives there                                                        |
| ---------------------- | ----------------------------------------------------------------------- |
| `crates/moat-core`     | Provenance, session store, policy, verdicts, evidence. No MCP knowledge. |
| `crates/moat-mcp`      | MCP JSON-RPC types and transport framing. No policy logic.               |
| `crates/moat-gateway`  | The binary. Wires transports to the core.                               |
| `arena/`               | TypeScript mock servers, attack corpus and task runner.                 |
| `policies/`            | Example policy files.                                                    |
| `docs/adr/`            | Architecture decision records.                                           |

`moat-core` is kept free of gateway-specific code so the TypeScript and Python
bindings can wrap it later. Those bindings are not in this phase.

## Config

`moat.yaml`:

```yaml
listen: { transport: stdio }          # or { transport: http, addr: "127.0.0.1:7071" }
upstreams:
  - name: stripe
    transport: stdio
    command: ["node", "arena/mock-stripe/server.js"]
  - name: web
    transport: http
    url: "http://127.0.0.1:7100/mcp"
policy: policies/default.yaml
evidence: ./evidence.jsonl
keys: ./keys
intent_api: { addr: "127.0.0.1:7072" }
```

| Key | Meaning | Default |
| --- | --- | --- |
| `listen` | `{ transport: stdio }` or `{ transport: http, addr }` (step 11) | stdio |
| `upstreams[].name` | Tool namespace prefix; must be unique | required |
| `upstreams[].transport` | `stdio` with `command` (and optional `env`), or `http` with `url` | required |
| `policy` | Path to the policy YAML | none → payments denied |
| `evidence` | Append-only JSONL file | `./evidence.jsonl` |
| `keys` | Directory for the ed25519 signing key (step 8) | `./keys` |
| `intent_api.addr` | Where the intent API listens; keep it loopback | none → no intents can be registered |
| `separator` | Between upstream name and tool name | `__` |
| `session_id` | Fixed session id | generated, printed to stderr at start |

Relative paths resolve against the config file's directory.

The gateway presents one MCP server to the client, aggregating every upstream
tool under a namespaced name (`stripe__pay`). Everything it does not explicitly
intercept is forwarded unchanged. If a policy file is missing or malformed it
fails **closed for payment tools and open for everything else**, and says so
loudly in the log: calls to tools named `pay`, `create_payment`, `charge`,
`transfer`, `send_money`, `purchase`, `checkout` or `refund` are denied with an
evidence record saying why, and every other tool passes through.

When a payment tool is called, the verdict comes back as a `tools/call`
result (allow, the upstream's own reply) or as a JSON-RPC error:

```jsonc
// step_up: -31050
{ "code": -31050, "message": "Moat: payment needs human approval",
  "data": { "moat": { "verdict": "step_up", "prompt": "Approve payment of 480 USD to …?",
                      "evidence_id": "ev_…", "resume_token": "rt_…", "session": "…" } } }
// deny: -31051
{ "code": -31051, "message": "Moat: payment denied",
  "data": { "moat": { "verdict": "deny", "reasons": [ { "id": "amount-cap", … } ],
                      "evidence_id": "ev_…", "session": "…" } } }
```

Why an error rather than a tool result is [ADR 0003](docs/adr/0003-step-up-as-jsonrpc-error.md).

## Intent API

Moat cannot read the human's request out of the MCP stream — the host never
sends it there. The intent API is how the host tells Moat what was actually
asked for:

```
POST /v1/session/{id}/intent    { "text": "Renew our monitoring tools, keep it under $500" }
POST /v1/session/{id}/resume    { "resume_token": "...", "approved": true }
POST /v1/session/{id}/headless  { "headless": true }
GET  /v1/session/{id}/evidence
```

**Without at least one registered intent, every payee resolves to `Unknown` or
`ToolResult`, so every payment will step up or be denied.** That is the correct
default, not a misconfiguration: a Moat that has never been told what the human
wanted has no basis for believing any payee came from them.

- `intent` registers the human's text for the session; call it once per user
  turn. Returns the turn number.
- `resume` answers a step-up. With `approved: true`, every field value the
  human was shown is registered as an intent, so the **next identical call**
  resolves to `User` and proceeds. Tokens are single-use and bound to the
  session. Moat does not replay the original call; the host retries it.
- `headless` tells Moat no human is present; `step_up` then degrades to the
  policy's `no_human_available` (deny in the example policy).
- `evidence` returns the session's records in order.

The session id is whatever `session_id` says in the config, or a generated
`s_…` printed to stderr at startup. Why the intent is a side channel rather
than something parsed from the MCP stream is [ADR 0004](docs/adr/0004-intent-api-side-channel.md).

The intent API binds to localhost and has no authentication. Adding it is future
work, tracked before any deployment where localhost is not a trust boundary.

## Evidence

Every verdict appends a record to the evidence file — there is no verdict without
one. Records are hash-chained and signed with an ed25519 key:

```bash
moat-gateway keygen --out ./keys
moat-gateway verify --evidence ./evidence.jsonl
```

The record format is specified in [`docs/evidence-format.md`](docs/evidence-format.md),
written alongside step 8.

## Development

Requires a stable Rust toolchain (pinned in `rust-toolchain.toml`) and, for the
arena, Node 22 or newer — pnpm 11 refuses to run on Node 20.

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## License

Apache-2.0.
