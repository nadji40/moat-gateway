# ADR 0009: A payment Moat cannot account for is held, not retried

## Status

Accepted.

## Context

Until this decision Moat asked a provider's reply one question: did it say
`succeeded`? A yes recorded a settled payment against the mandate. Anything
else — a pending status, a transport error, a status string nobody had
taught it — was a failure. The reservation was released, the counters went
back to where they had been, and the identical payment could be sent again.

On a card that is right, and it is right for a specific reason rather than
by luck. A card authorization either took or it did not; if it took and
should not have, it can be reversed; and the pilot's own lost-response
recovery depends on a retry being safe. ADR 0003 already put the adapter in
charge of idempotency for exactly this case.

On a bank transfer it is wrong, and wrong in the expensive direction. A
transfer is not finished when the request returns. It is accepted, then
submitted, then settled, over hours or days, and from the moment it is
submitted nobody can recall it. If the reply is lost anywhere in that
window, Moat does not know which stage it reached. Releasing the
reservation then is Moat telling the agent the payment did not happen. The
agent does the obvious thing, and the supplier is paid twice with no way
back. ADR 0008 named this as the follow-on that the bank rail could not be
called finished without.

The mistake underneath it is that one boolean was carrying two different
questions. *What did the provider say* is an observation. *Does this count
against the mandate* is a decision, and it depends on whether the money can
come back.

## Decision

- **A provider's answer is mapped into a closed vocabulary** —
  `pending`, `submitted`, `confirmed`, `succeeded`, `failed`, `reversed`,
  `unknown` — and anything unrecognised becomes `unknown`, never `failed`.
  A provider that invents a status string has told Moat nothing, and
  nothing must not read as "the money did not move".

- **How Moat treats an outcome is derived from that status and the rail, in
  one function.** A *definite* answer means the same thing everywhere:
  settled counts, failed and reversed do not. An *indefinite* answer
  divides the rails. On a reversible rail it does not count, which is
  exactly the behaviour every card deployment has had. On an irreversible
  rail it counts, because the money may already be gone.

- **An unknown outcome on an irreversible rail is also quarantined.**
  Counting it protects the limit, but Moat still cannot say whether that
  authorization has been used, and guessing either way is how a supplier
  gets paid twice. While a quarantined outcome exists, the new
  `authorization-quarantine` check denies every further payment under the
  same authorization.

- **The hold is cleared by reconciliation, not by time.** An approver, or
  an adapter's workflow script, checks with the provider and reports what
  they found through
  `POST /v1/session/{id}/outcomes/{evidence_id}/reconcile`. Whatever the
  answer, the quarantine clears: the reason for it was that nobody knew.
  `GET /v1/session/{id}/outcomes` is the work queue.

- **An outcome is addressed by the evidence id of the verdict that allowed
  it.** Moat invents no second identifier, and the operator reconciles
  against the signed record rather than against a handle that exists only
  in memory.

- **Reconciliation may resolve an open state into any state, and may not
  contradict a final one.** The single exception is `succeeded` to
  `reversed`, because that is a thing that happens to money.

- **The folds count committed value, not settled value.** The aggregate,
  the usage count and both duplicate checks read `committed`. A held
  transfer therefore consumes the mandate exactly as a settled one does,
  until somebody says otherwise.

## Consequences

The card path does not move, and this is checked rather than asserted: a
lost response on a card still releases nothing, still counts nothing, and
is still retryable, with an integration test that runs the identical
provider failure on both rails and asserts the two different results.

Outcomes written before this decision keep their meaning. `succeeded` is
still there and still means what it meant; the deserializer derives the new
fields from it, so a session open across the upgrade does not change its
mind about how much of a mandate is left. That derivation is a test.

The bank rail's arena numbers still measure authorization rather than
settlement. Nothing in the arena yet loses a response on purpose. The
mechanism is exercised by the gateway integration tests instead, which is
where a lost reply can actually be arranged.

**A held payment is a liability until somebody clears it.** That is the
cost of this decision and it should be stated plainly: Moat will now refuse
legitimate payments after a provider outage, and keep refusing them until
an operator reconciles. The alternative is paying twice, and on a rail
where nothing comes back that is not a trade worth making. It does mean the
work queue has to be watched, and that reconciliation has to be as easy as
a single call, which is why it is one.

What this ADR deliberately does not do: it does not poll. Moat never goes
and asks a provider what happened; something outside tells it. An in-gateway
reconciler that polls an upstream's status tool is a later decision, and it
needs a per-upstream schedule, a backoff and a story about partial
outages. Until then the honest position is that the hold is released by a
human or by an adapter's own workflow, and both of those are visible.

Nor does it change what a duplicate is. The replay key is still the invoice
id on every rail. A transfer rail's own reference field is the natural key
there, and switching to it is its own decision with its own migration.
