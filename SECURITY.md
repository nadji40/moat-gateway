# Security policy

Moat is an authorization layer that sits between an agent and the tools that
move money. A flaw in it is a flaw in a payment control, so we treat reports
seriously and answer them quickly.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security →
Report a vulnerability**. It opens a private advisory that only the maintainers
can see. Do not open a public issue for anything you believe is exploitable.

Include what you can of: the affected component (`moat-core`, `moat-mcp`,
`moat-gateway`, the arena), a minimal reproduction (an `attack.yaml` in the arena
format is ideal), the policy you ran against, and the observed verdict versus the
one you expected.

What to expect from us:

| within        | we will                                                         |
| ------------- | --------------------------------------------------------------- |
| 3 days        | acknowledge the report and tell you who is handling it          |
| 14 days       | confirm or dispute the finding, with reasoning                  |
| 90 days       | ship a fix or publish the limitation, whichever is honest       |

We credit reporters in the release notes unless you ask us not to. There is no
bounty programme yet.

## Safe harbour

Good-faith research against **your own** deployment of Moat, or against the
arena's mock servers, is welcome and will not be met with legal action. Do not
test against deployments you do not operate, and do not touch real payment
providers with anything other than their sandbox or test modes.

## Scope

In scope:

- verdict logic: a payment that policy says should be denied or stepped up
  being allowed (`moat-core`)
- provenance: a field that came from an untrusted source being attributed to a
  trusted one, including normalisation and matching tricks
- structured authorization: a mandate's amount, recipient, currency, invoice
  identity, expiry, repeat or aggregate limit being bypassed
- evidence: a record that verifies but does not reflect what happened, or a
  chain that can be edited without detection
- the gateway's transports, intent API and tenant authentication
- the arena, where a mock or the runner could make a result look better than
  it is

Out of scope:

- the model itself doing something the policy allows; Moat does not claim to
  make an agent wise, only to check what it proposes against what was authorised
- third-party MCP servers and payment providers
- denial of service against a single-instance deployment; the current release
  is not a high-availability system and does not claim to be
- any deployment's own policy being too permissive

## What Moat does and does not claim

Read this before reporting "Moat let a payment through".

Moat checks a proposed payment against registered user intent, an allowlist,
observed tool results and a structured authorization, and produces a verdict
with a signed, hash-chained evidence record. It proves what it recorded. It does
not prove that a human truly intended a payment, it does not replace the
controls of a payment rail, and a passing verdict is not a guarantee that a
payment was correct. The arena's results are measurements under stated
conditions, with the run counts and intervals published alongside them; they
are not a certification.

## Held-out attacks

Part of the attack corpus is held out from the repository while a measurement
is in progress, so that published numbers are not fitted to the attacks they
are measured on. Held-out cases are published with the results they were used
for. If you find a bypass that you suspect is in the held-out set, report it the
same way; it counts.

## Supported versions

Pre-1.0. Only the latest tagged release and the default branch receive fixes.
