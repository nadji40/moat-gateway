# ADR 0005: Evidence hash chain and signing

- Status: accepted
- Date: 2026-09-15

## Context

Every verdict produces an evidence record. The records exist so that someone
who was not there — an auditor, a merchant disputing a refusal, the operator
after an incident — can establish what Moat saw and decided. For that to be
worth anything, the file has to resist two things: alteration of a record
after the fact, and removal or reordering of records. It also has to be
checkable by someone who does not trust the machine it was written on.

## Decision

Records are written as one canonical JSON line each, chained by hash and
signed with ed25519. Concretely (`docs/evidence-format.md` is normative):

- **Canonical bytes.** Keys sorted, no whitespace. The line *is* the record;
  verification rejects a line that does not equal its own canonical form.
- **Chain.** `prev` is the SHA-256 of the previous line's bytes, signature
  included. First record: `null`.
- **Signature.** ed25519 over the canonical JSON with `sig` removed. So
  `prev` and `context_hash` are signed; the signature covers the record's
  place in the chain, not just its content.
- **Context.** `context_hash` is the SHA-256 of the session's event log at
  evaluation time. The log holds hashes of tool result bodies and intent
  texts, never the bodies themselves.
- **Keys.** One ed25519 pair per gateway, generated on first run into the
  configured directory or supplied by the operator. Secret file mode 0600.
- **Verification** is offline: `moat-gateway verify` needs the file and the
  public key, nothing else. It reports every problem with a line number and
  continues, re-anchoring the chain at each line so one bad record is blamed
  once.

## Rationale

**Why chain and sign, not one or the other.** A signature alone proves each
record is genuine but not that the set is complete: delete line 3 and lines 1,
2, 4 still verify. A chain alone proves order and completeness relative to the
head but not authorship: anyone can rewrite the whole file and rechain it. The
signature over a record that includes `prev` ties authorship to position;
rewriting one line invalidates its signature, and rewriting the tail requires
the secret key.

**Why hash the line, not the record.** Hashing the bytes as written, rather
than a re-serialization, means verification has no "interpretation" step that
could disagree with the writer. It also makes the canonical-form check
meaningful: if the line were reformatted, its hash would change and the next
record's `prev` would break, even though the JSON content is identical. A
reformatted evidence file is an edited evidence file.

**Why canonical JSON at all.** Signatures are over bytes. Without a fixed
serialization, the same record could have many byte forms and a verifier
would have to guess which one was signed. Sorted keys and no whitespace is the
simplest rule that any language can reproduce. It is what the TypeScript and
Python bindings will need to implement to verify without the Rust crate.

**Why `context_hash` is a hash of the log and not the log.** The log would
make records large and would put intent text (the human's words) and tool
result content (possibly sensitive pages) into a file that is meant to be
shared with auditors. The hash lets a party who *does* have the session
(the operator) prove the record was made against a specific history, while a
party who does not still gets a fixed commitment.

**Why ed25519.** Small keys, small signatures, deterministic (the same record
signed twice produces the same bytes, which the golden test relies on), no
parameter choices to get wrong, and a well-audited implementation in
`ed25519-dalek`. Nothing here needs agility.

**Why a golden file.** The format is a contract with future verifiers,
including ones not written in Rust. A test that pins the exact bytes of two
records turns "we changed the format" from something discovered in production
into a failing test that names the file to update.

## Consequences

- Restarting the gateway continues the chain: on startup it hashes the last
  line of the existing file. Two gateways writing one file would interleave
  and break the chain; the file is per instance, and the README says so.
- The secret key is the trust root. Stealing it allows forging a consistent
  file. Rotation, HSMs and timestamping are out of scope for this phase.
- The record has no version field. A format change is a golden-test failure
  and a documented migration, not a runtime branch. A version field can be
  added when there is a second format.
- Evidence is written before the verdict is sent and a write failure refuses
  the payment. This is the one place Moat prefers availability loss to a
  missing record.
