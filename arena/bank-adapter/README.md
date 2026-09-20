# bank-adapter

The bank rail as a contract with a reference implementation, so that SEPA,
SARIE, ACH or a PIS provider is a file under `src/providers/` rather than a
fork.

**This has not touched a real bank.** Every real rail needs an institution,
a signed agreement and a compliance review before it will give you a
sandbox, and none of that is a thing a repository can do for you. What is
here is the part that can be built and tested in advance: the interface, a
provider that behaves the way real ones behave, and a script proving Moat
handles the behaviour. Plugging in Dwolla or Modulr is then a day's work
against a known shape, not a redesign.

## Why not just use the mock

`arena/mock-bank` exists to be paid, so the corpus has something to
measure. It settles when you ask and never takes anything back. Real rails
do neither, and the two behaviours it lacks are exactly the ones that make
a bank transfer dangerous:

- **Accepted is not settled.** A transfer is pending, then submitted, then
  settled, over hours on SEPA and days on ACH. From submission nobody can
  recall it. If the reply is lost in that window, nothing on earth can tell
  you whether the money went.
- **Settled is not final.** R-transactions on ACH, returns and recalls on
  SEPA. A transfer that settled on Tuesday can come back on Friday.

## What the smoke proves

```bash
cargo build -p moat-gateway --release
cd arena && MOAT_BANK_CONFIRM=YES pnpm --filter @moat/bank-adapter smoke
```

| Step | What happens | Result |
|---|---|---|
| Approved transfer | Accepted as `pending` | Moat commits it against the mandate at once, because accepted may already mean gone |
| Settlement | The bank settles on its own clock; an operator reconciles | the outcome becomes terminal |
| Forged invoice | Right supplier name, someone else's IBAN | refused before the bank hears of it |
| Lost reply | Accepted, then the reply is dropped | held and quarantined; the retry is refused |
| After reconciliation | The operator confirms what the bank did | refused again, as a duplicate — and the bank shows **one** transfer |
| Settled, then returned | AC04, beneficiary account closed | reconciled as `reversed`; the mandate is released and a replacement to a corrected account is allowed |

The last row is the one no other adapter in this repository reaches. A card
can be refunded and a chain transfer cannot come back at all; only a bank
transfer settles and then un-settles, and `reversed` exists as a state
rather than an error precisely so the mandate can be released when it does.

## The contract

`src/contract.ts`. Four methods, chosen to be the shape every real rail
already has rather than the shape any one of them has:

```ts
interface BankProvider {
  id: string;
  createTransfer(request: TransferRequest, idempotencyKey: string): Promise<TransferResult>;
  getTransfer(reference: string): Promise<TransferStatus>;
  listTransfers(): Promise<TransferStatus[]>;
  verifyPayee?(iban: string, beneficiaryName: string): Promise<PayeeCheck>;
}
```

States are `pending | submitted | settled | failed | returned`, which is the
vocabulary `OutcomeStatus::from_provider` already understands, so a provider
that speaks it needs no translation and one that does not has exactly one
place to be translated.

**An implementation must throw only when it genuinely does not know.** Moat
treats a thrown error as an ambiguous result, and on an irreversible rail
that means holding the payment rather than retrying it. A provider that
throws on a definite refusal turns a clean `failed` into a quarantine
somebody has to clear by hand.

**Idempotency is the caller's job and the adapter computes it from what
identifies the payment**: `sha256(iban ‖ authorization_id ‖ invoice_id)`,
NUL-separated so no concatenation of one field can spell another. No
timestamp, no counter — a retry after a lost reply has to produce the same
key or the supplier is paid twice.

## Plugging in a real rail

| Provider | Shape | What to watch |
|---|---|---|
| **Dwolla** (ACH, US) | Sandbox is free and self-serve; transfers stay `pending` until you simulate a bank event | R-transactions arrive as webhooks days later; map them to `returned` |
| **Modulr** (UK, PIS) | Agreement required; Faster Payments in seconds | CoP is a separate call and answers `match`/`close`/`no match` directly |
| **Plaid Transfer** (US) | Agreement required | Returns arrive on a separate events endpoint |
| **Wise** (multi-currency) | Business account | FX means the amount that arrives is not the amount sent; `settledAmount` has to be read back |
| **SARIE** (SA) | Through a sponsoring bank | Not a self-serve API; a design-partner conversation |

Three things every one of them needs that the reference implementation
fakes:

1. **Status webhooks.** ADR 0007 defers them. Until they exist, an operator
   reconciles through `POST /v1/session/{id}/outcomes/{id}/reconcile`,
   which is what the smoke does.
2. **Cut-off times.** A transfer instructed after the cut-off settles the
   next business day. Nothing here models a calendar.
3. **Real CoP.** The name matching here is Levenshtein with company
   suffixes stripped. A scheme's own answer is authoritative and should be
   passed through rather than recomputed.

## Configuration

Read from the environment; every value has a working default.

| Variable | Meaning |
|---|---|
| `MOAT_BANK_STATE_DIR` | Where the transfer ledger lives. Default `state/` inside this package, ignored by Git. |
| `MOAT_BANK_SUBMIT_MS` / `_SETTLE_MS` / `_RETURN_MS` | The clock: accepted → submitted → settled → returned. Defaults 200 / 1000 / 1500. |
| `MOAT_BANK_SUPPLIER_IBAN` / `_NAME` | The approved supplier. Default a synthetic mod-97-valid DE IBAN. |
| `MOAT_BANK_OTHER_IBAN` / `_NAME` | An account nobody approved, for the forged-invoice case. |
| `MOAT_BANK_RETURNING_IBAN` / `_NAME` | The account whose transfers settle and then come back. |
| `MOAT_BANK_FEE_MINOR` / `_FEE_CURRENCY` | What the provider charges. Default 35 minor units, EUR. |

## Tests

`pnpm --filter @moat/bank-adapter test` — pure, no gateway, no network, no
secrets. They cover the two things the adapter must not get wrong on its
own: which requests are the same payment, and what a name check said.
