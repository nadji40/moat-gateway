# Evidence format

Every verdict Moat produces appends exactly one record to the evidence file.
There is no verdict without a record: if the record cannot be written, the
payment is refused. This document specifies the record; the implementation is
`crates/moat-core/src/evidence.rs` and the bytes are pinned by
`crates/moat-core/tests/golden/evidence.jsonl`. Keep all three in step.

## File

- One JSON object per line (JSONL), UTF-8, `\n` terminated.
- Append-only. One file per gateway instance, path from `evidence` in the
  config. On startup the gateway reads the last line and continues the chain
  from its hash, so restarts do not break verification.
- Each line is the record's **canonical JSON**: object keys sorted
  (bytewise), no insignificant whitespace, serde_json string escaping. A line
  that is not byte-identical to its own canonical form fails verification,
  because a reformatted line is an edited line.

## Record

```jsonc
{
  "id": "ev_3f9c…",                 // "ev_" + 24 hex chars, unique per record
  "format_version": 2,              // omitted in version 1 records; absent means 1
  "rail": "card",                   // "card" | "bank" | "crypto"; absent in version 1
  "session": "s_…",                 // session id
  "ts": "2026-09-15T20:31:07.412Z", // RFC 3339, UTC, millisecond precision
  "call": {
    "server": "stripe",             // upstream name
    "tool": "pay",                  // bare tool name, namespace stripped
    "call_id": "42",                // JSON-RPC id of the tools/call, as a string
    "args": { "payee": "…", "amount": 480, "currency": "USD" }   // as received
  },
  "provenance": {                   // one entry per logical field present in args
    "payee": {
      "arg": "payee",               // which argument fed the field
      "value": "ProMon Billing Ltd",
      "normalized": { "original": "…", "text": "promon billing ltd", "number": null },
      "source": { "kind": "tool_result", "server": "web", "tool": "fetch", "call_id": "7" },
      "match": "substring",         // "exact" | "substring"; absent when Unknown
      "matched_in": "7",            // intent:N | allowlist entry | call_id; absent when Unknown
      "matches": [                  // every match, winner first
        { "source": {…}, "match": "substring", "matched_in": "7", "path": "/content/0/text" }
      ]
    },
    "amount": { … }, "currency": { … }
  },
  "rules": [                        // every rule evaluated, in policy order, then velocity
    { "id": "payee-provenance", "field": "payee", "passed": false,
      "source": "ToolResult", "on_fail": "step_up",
      "message": "payee did not come from the user or the allowlist (…)" },
    …,
    { "id": "velocity", "passed": true, "on_fail": "deny", "message": "ok: 0 this session, 0 this minute" }
  ],
  "verdict": "step_up",             // "allow" | "step_up" | "deny"
  "context_hash": "…",              // sha256 hex, see below
  "prev": "…" | null,               // sha256 hex of the previous line, null on the first
  "sig": "…"                        // ed25519 signature, 128 hex chars, see below
}
```

`source.kind` is one of `user` (`turn`), `allowlist` (`name`), `tool_result`
(`server`, `tool`, `call_id`), `system`, `unknown`. In `rules[].source` the
kind appears in its policy spelling (`User`, `Allowlist`, `ToolResult`,
`System`, `Unknown`).

When a payment tool is called with no usable policy, the record has an empty
`provenance`, a single rule `policy-unavailable`, and verdict `deny`.

## Hashes

- **`context_hash`** = SHA-256 of the canonical JSON of the session's event
  log (`[{seq, unix_ms, event, …}, …]`) **before** this evaluation was logged.
  Two records with the same `context_hash` were evaluated against the same
  history. Event bodies never contain tool result content, only its SHA-256.
- **`prev`** = SHA-256 of the previous line's bytes, signature included. The
  first record's `prev` is `null`. Deleting, inserting or reordering a line
  breaks the chain at the next record.

## Signature

- Key: ed25519. The gateway loads `moat_ed25519` (32-byte seed, hex) from the
  `keys` directory or generates one on first run. `moat_ed25519.pub` is the
  32-byte public key, hex. `moat-gateway keygen --out DIR` creates a pair.
- Signed bytes: the canonical JSON of the record **with the `sig` member
  removed**. Every other member, `prev` and `context_hash` included, is
  under the signature.
- `sig`: the 64-byte signature as 128 lowercase hex characters.

## Verification

```bash
moat-gateway verify --evidence ./evidence.jsonl --keys ./keys
moat-gateway verify --evidence ./evidence.jsonl --pubkey <64 hex>
```

For each line, in order: parse; check the line equals its canonical form;
check `prev` against the previous line's hash (`null` only on line one);
verify the signature. Every problem is reported with its line number and
record id; the exit status is non-zero if there is any. The chain is
re-anchored at each line so one bad record is reported once, not blamed on
every record after it.

What verification proves: the file was written in this order by the holder of
the secret key and has not been altered since. What it does not prove: that
the secret key was not stolen, or that the gateway's inputs (intents, tool
results) were truthful. Intent text is not in the record; its SHA-256 is in
the event log that `context_hash` covers.

## Versions

**Version 2** (current) adds `format_version` and `rail`. A verdict now says
which settlement rail the money would have left on, so one file can hold
card, bank-transfer and on-chain decisions and a reader can tell them apart
without inferring it from the upstream name.

**Version 1** records carry neither field. They are still valid and still
verify: both fields are omitted whenever they hold their version 1 meaning,
so a version 1 line read and rewritten by a current build is byte-identical
and its signature still checks out. A reader treats an absent
`format_version` as `1` and an absent `rail` as `card`, which is what every
upstream was before rails existed.

The rule that keeps this workable: a new field may only be added if it is
omitted when it carries no information, and the golden fixture must not
exercise it. Otherwise the golden bytes move on every release and the one
signal that the format changed is lost in the noise.

## Stability

A change to any key, to canonicalization, to what is hashed or to what is
signed changes the bytes and fails the golden test. When that is intended,
update this document, then regenerate the golden file with
`MOAT_UPDATE_GOLDEN=1 cargo test -p moat-core --test golden`, and commit the
regenerated fixture on its own so the diff is reviewable.
