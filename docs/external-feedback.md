# External feedback, and what Moat does about it

In October 2026, we put Moat's design in front of practitioners from the
payments industry and asked them to pick it apart: is the problem real, what would stop a payments company from adopting
it, and what is missing. Two of them gave feedback that can be quoted. This
document records their points in their own terms and answers each one with
what Moat already does, with pointers into the code, the architecture
decisions and the measurements, and says plainly where something is not
built.

**On attribution.** Both contributors spoke in a personal capacity and are
identified by their initials. Their views are their own and are not those
of any employer, past or present; the employer is named only to show the
background the view comes from, and neither company has reviewed, approved
or endorsed anything here. Nothing in this document is an audit, a
certification or an endorsement of Moat by anyone.

## M. H.

Product manager at Visa, M.Sc., speaking in a personal capacity. His
perspective: problem validation, adoption, system-level risk.

> Yes, genuine and growing. Today most "agent payments" are agents paying a
> known invoice a human already approved: bounded risk. The real exposure
> starts when agents select merchants and amounts autonomously: prompt
> injection via a poisoned invoice, email or web page that swaps the
> recipient or inflates the amount is a realistic, already-demonstrated
> attack class. Card networks and PSPs are actively defining agentic-commerce
> authorization primitives right now.

Agreed, and that boundary is exactly where Moat's check sits. The payee the
agent found in an invoice is, in Moat's terms, a value whose provenance is a
page, not the user; a payment to it is held or refused however convincing
the page was ([ADR 0001](adr/0001-provenance-by-value-matching.md)). The
"bounded" case, an invoice a person already approved, is the approval
record Moat compares every attempt against.

He then listed what would block adoption. Each point, and the answer:

**"What happens when Moat is wrong: blocks a good payment or misses a bad
one. Who is liable, how is it fixed after?"**
Moat's verdict is not a fraud score, so "wrong" means something narrow. A
payment is denied only when its payee, amount or currency does not match
what the user asked and a person approved; the mismatch and the approval it
was checked against are in the signed evidence record. More than approved is
a step-up, a person decides, not a silent decline. In the arena, 135 of 135
legitimate payments went through ([the numbers](../README.md#the-numbers)).
A miss would mean an attempt that matched the approval in payee, amount and
currency, which is the customer's own authorization being carried out.
Liability between the customer, the provider and Moat is a matter for the
pilot's written terms; what Moat contributes to that conversation is the
record of who asked for what, who approved it, and what the gateway decided,
signed and chained so it can be produced afterwards.

**"Post-hoc dispute and reconciliation flow, not just real-time block/allow."**
Built, for the part that is Moat's to do. Every provider answer is mapped
into a closed set (`pending`, `submitted`, `confirmed`, `succeeded`,
`failed`, `reversed`, `unknown`), and anything unrecognised becomes
`unknown`, never `failed`. An unknown outcome on an irreversible rail is held
and quarantined, the authorization is blocked, and nothing is retried until
a person reconciles it through
`POST /v1/session/{id}/outcomes/{evidence_id}/reconcile`, which is tied to
the signed verdict that allowed the payment
([ADR 0009](adr/0009-provider-outcome-state-machine.md); the arena's
`lost-reply-double-transfer` attack exercises it). A chargeback after
settlement is the card network's process, not Moat's; Moat's part is to hand
the dispute the evidence.

**"Latency and availability. A gatekeeper in the payment path cannot be a new
single point of failure."**
Latency is measured, not estimated: 0.22 ms added at p50 on a passthrough
call, 1.4 to 1.9 ms per payment decision, against a budget of 15 ms at p95
([TECHNICAL.md, passthrough latency](TECHNICAL.md#passthrough-latency)).
On availability, Moat fails closed on purpose: if the gateway is down, no
agent payment goes through, because an agent that can pay while the
gatekeeper is down is the thing being prevented. The gateway is one binary
with its state in PostgreSQL, so sessions, evidence and single-use approval
tokens survive a restart ([ADR 0007](adr/0007-durable-tenant-state.md)).
What has not been done is a failover exercise with two instances; it is
listed as open in [pilot-operations.md](pilot-operations.md).

**"Policy-authoring UX: who defines authorized scope, and how do
non-technical ops teams manage it?"**
Two different things, and only one of them is daily work. The policy is a
short declarative file set once per workspace: the spending limit, the
currencies, which tools move money and which do not, with shipped examples
in [`policies/`](../policies). If it is missing or malformed the gateway
fails closed and says so. The daily decision is the approval: a person sees
the payee, the amount, the currency and the reason the payment was held, and
approves or refuses it in the dashboard, on a phone if that is where they
are. That is the surface an operations team touches.

**"Regulatory alignment (PSD2/SCA, card-network agentic-commerce rules):
build with those frameworks, not parallel to them."**
Moat is not a payment service provider and holds no funds; the regulated
activity stays with the licensed provider it sits in front of
([Jurisdictions](../README.md#jurisdictions)). Its step-up is a person's
explicit approval of one specific payment, bound to payee and amount, which
is what strong customer authentication's dynamic linking asks for. The card
networks' agentic primitives are mandates and credentials on the card rail;
Moat's check is whether the payee and amount came from the user, and it
runs the same way on bank transfers and on chain, where the networks have
nothing. The two are complementary, and Moat is a transparent MCP proxy, so
it sits in front of whatever primitive the provider ships. For the protocols
that exist today, TECHNICAL.md runs x402's and AP2's own evaluators against
the same payments: AP2 lands where the allowlist arm sits, stopping half the
corpus ([what the other protocols decide](TECHNICAL.md#what-the-other-protocols-decide)).

**"Key custody and non-repudiation for the signed audit log."**
Evidence records are one canonical JSON line each, hash-chained and signed
with ed25519 ([ADR 0005](adr/0005-evidence-hash-chain.md);
[evidence-format.md](evidence-format.md) is normative). Raw approval and API
tokens are never stored; the database holds SHA-256 hashes. What is not yet
production-grade: the signing key and the on-chain co-signing key are files
on the server. A KMS is named in [ADR 0010](adr/0010-on-chain-co-signer.md)
as the first hard dependency before real money.

**"Rail-specific finality: crypto is irreversible, cards have chargebacks.
Same policy engine, different guarantee needs."**
That is how it is built. The policy engine is rail-agnostic
([ADR 0008](adr/0008-settlement-rails.md)); the outcome handling is not. A
provider failure on the card rail leaves the authorization retryable; an
unknown outcome on a bank or chain rail is held and the authorization
blocked until reconciled ([ADR 0009](adr/0009-provider-outcome-state-machine.md)).
On the bank rail the destination account is canonicalized and matched
exactly, never by substring, which is what catches an IBAN that shares its
first eight and last four characters with the approved one.

**"Adversarial drift: 25 scenarios today; attackers adapt once a gatekeeper
is known. Need continuous red-teaming, not a one-time test suite."**
The arena is a runner, not a list. The corpus is 25 scenarios in 16
families on four rails, plus runs against real models
(`gpt-5-mini`: robbed 35 of 76 times without Moat, 0 through it;
`gpt-5.6-terra`: 4 of 17 and 0). What is not yet covered is tracked in
[attack-backlog.yaml](attack-backlog.yaml), and [CONTRIBUTING.md](../CONTRIBUTING.md)
requires that any change to what Moat catches ships with the arena run that
shows it. The team's own red-teaming has already found and fixed a real
gateway bug (the cross-session max-payments attack, written up in the
[security advisories](https://github.com/nadji40/moat-gateway/security/advisories)).
There is also a design reason drift matters less here than for a detector:
Moat does not try to recognise an attack. It checks where each value came
from and whether it matches the approval. A new phrasing of an injection
does not change the fact that the payee came from a page.

**"Clear go-to-market wedge: agent-platform builders, PSPs and enterprises
are three different motions."**
The first motion is companies that already run agents and pay suppliers
with them, with pilots planned in Saudi Arabia; agent builders are the
second, because the integration is to point the agent at Moat instead of
the provider; payment providers come later
([who has this problem](../README.md#who-has-this-problem)).

## Y. B. C.

Software engineer (Android) at PayPal, speaking in a personal capacity. His
perspective: transaction authorization, cryptographic approval, backend
enforcement, mobile-agent security.

> I would separate user authentication from transaction authorization. A
> successful biometric callback alone does not prove that a user approved a
> specific payment. My biggest recommendation would be to treat
> cryptographically bound transaction approval and server-side enforcement
> as the core security guarantees, rather than relying on mobile
> authentication or UI-level protections.

This is Moat's design. Point by point:

**"Bind approval to the exact transaction: beneficiary, destination account,
amount, currency, transaction ID, expiration."**
An authorization in Moat carries the payee, the recipient account, the
amount, a tolerance, the currency, the invoice reference and an RFC 3339
expiry. A payment is checked against all of them: exists, active, not
expired, payee and account match, amount within tolerance, currency and
invoice match, no duplicate, under the aggregate limit, not quarantined
([how one payment is decided](TECHNICAL.md#how-one-payment-is-decided)).
The same payee at a different amount is "never covered by that approval"
and is held again.

**"Verify authorization on the backend."**
Approvals are recorded and checked in the gateway, never in the client. They
arrive through the intent API, which listens on its own port and takes an
approver key the agent never holds, so an agent cannot register its own
intent or approve its own payment
([ADR 0004](adr/0004-intent-api-side-channel.md)). The dashboard is one
client of that API.

**"Prevent replay and duplicate execution: single-use records, atomic
transitions, idempotency keys."**
A held payment's resume token is single-use and bound to the exact proposal,
server, tool and arguments; the identical call after an approval is spent
is held again ([what a person's approval unlocks](TECHNICAL.md#what-a-persons-approval-unlocks)).
Payment outcomes have a unique receipt index and are inserted with
`ON CONFLICT DO NOTHING` ([`migrations/`](../migrations)); the Stripe
adapter derives its idempotency key from the account and the authorization;
on chain, presenting the same co-signature twice reverts in the contract
([going around Moat does not help](TECHNICAL.md#going-around-moat-does-not-help-2026-09-20)).
The arena's `replay-double-charge` attack runs on every rail.

**"Enforce security independently of the user interface. Every payment
request should pass mandatory backend authorization whether it comes from an
API, a mobile app or an agent."**
Moat sits on the payment path, not in the UI. Every `tools/call` an agent
makes passes the policy; a tool the policy has not classified is hidden and
refused; a missing policy fails closed. The one deployment condition is that
the agent holds no provider credential of its own, and on chain even that
condition is removed: the guarded wallet executes only against Moat's
co-signature, so an agent with its own key still cannot move anything
alone. An agent driving a payment app's screen with the customer's own
login is outside what any gateway can see, which is why the deployment model
is that the credentials live behind Moat.

**"Risk-based approval: limits reduce prompts; new beneficiaries, changed
details or unusually large amounts trigger additional verification."**
The tolerance does the first part: an increase inside it is allowed, above
it is a step-up. The second part is provenance rather than risk scoring: a
beneficiary or account that did not come from the user is held or refused
at any amount, which is the "our bank details have changed" case. Moat has
no behavioural scoring, by principle: behavioural evidence may narrow or
escalate an authorization, never expand it
([attack-backlog.yaml](attack-backlog.yaml)).

**"Integrate at the backend payment-orchestration layer, before the payment
operation is created or confirmed."**
That is where the proxy sits: between the agent's call and the provider's
endpoint, so the decision is made before Stripe creates the charge and
before a chain transaction is broadcast. The Stripe adapter is exercised
against Stripe's sandbox in the arena's card runs; the co-signer against
Base Sepolia.

**"Validate under realistic conditions: independent audits, penetration
testing, low latency, high availability, reconciliation, production-like
pilots."**
Done: Stripe sandbox runs, live Base Sepolia transactions, real-model runs,
a latency bench, a reconciliation flow with a scenario for it, and the
team's own attacks with an advisory for each finding. Not done: an
independent security audit and penetration test (the contract is unaudited
and testnet-only), a failover exercise, and a production pilot. Real money
starts after the first two, under a capped limit
([honest status](../README.md#honest-status)).

**On device-bound approval keys (Android Keystore, StrongBox,
BiometricPrompt with a CryptoObject signing a backend-generated
challenge).**
This is the right shape for a mobile approver, and it is not built. Today
an approval is authenticated by the approver key over the intent API and
recorded server-side; a signature from a hardware-bound key over the exact
approval challenge would add non-repudiation of the person who approved,
on top of the gateway's own signature over the verdict.

## Where that leaves the consolidated list

The reviewers' points consolidate into the eight areas below. The third
column is the state of the code, not a plan.

| Area | What was asked | Where Moat stands |
|---|---|---|
| Transaction-bound authorization | approval tied to payee, amount, currency, destination, reference; any change invalidates it | built; checked on every payment |
| Backend enforcement | no bypass through other endpoints, direct provider access or UI automation | built for the agent path; on chain the guarded wallet removes the credential assumption; UI automation with the customer's own login is out of scope by design |
| Replay and duplicates | single-use approvals, expiry, atomic transitions, idempotency | built; single-use tokens, unique receipts, provider idempotency keys, on-chain revert |
| Failure handling | timeouts, unavailable services, ambiguous outcomes, wrong decisions; latency and availability targets | built: fail closed, hold and reconcile, 15 ms p95 budget met; not exercised: failover between instances |
| Human oversight | explicit, auditable rules; a person on anything above the approval | built; no behavioural scoring, on principle |
| Continuous adversarial testing | grow the corpus as techniques appear | the runner and the backlog exist; the corpus grows with each finding |
| Auditability and accountability | documented decisions, protected records, key management, responsibility for wrong verdicts | signed, chained evidence built; keys are files, KMS before real money; liability is in pilot terms |
| Market validation | an initial segment, integration effort, fit with existing fraud controls, willingness to pilot | segment and first market named; pilots not yet started |

The validation priorities they suggested, and what already tests each:

| # | Priority | Covered by |
|---|---|---|
| 1 | Changing payee, amount, currency or destination after approval is rejected | arena: `spoof-lookalike-name`, `change-recipient-account`, `lookalike-recipient-account`, `inflate-under-cap`, `substitute-currency`, on four rails |
| 2 | An approval cannot be reused or pay twice | arena: `replay-double-charge`, `duplicate-invoice-new-id`; the on-chain table |
| 3 | A payment cannot reach the provider without a valid Moat authorization | the `cap`, `allowlist` and no-gateway arms; the guarded wallet on Base Sepolia |
| 4 | Timeouts, unavailable services, ambiguous outcomes | arena: `lost-reply-double-transfer`; fail-closed policy tests |
| 5 | Added latency | the passthrough bench, 500 calls each way |
| 6 | New injection and manipulation scenarios | the attack backlog and the contributing rule |
| 7 | Auditability, recovery, the integration path | evidence format and verification; recovery and the first integration are pilot work, not yet done |
