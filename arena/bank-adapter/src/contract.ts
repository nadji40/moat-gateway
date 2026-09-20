// What Moat needs from a bank, and nothing else.
//
// The arena's mock-bank measures: it is permissive by design and exists so
// the corpus has something to pay. This is the other half — the interface a
// real rail implements, so that SEPA, SARIE, ACH or a PIS provider is a
// file under providers/ rather than a fork of the adapter.
//
// The interface is deliberately small, and small in a particular way: it is
// the shape every real rail already has, rather than the shape any one of
// them has. Four things are true of all of them and are therefore here.
//
//   A transfer is accepted before it is done. Nothing returns "paid". It
//   returns a reference and a status that moves later, over hours for SEPA
//   and days for ACH, which is why `getTransfer` exists at all and why the
//   outcome state machine (ADR 0009) is not optional on this rail.
//
//   A transfer can come back. R-transactions on ACH, returns and recalls on
//   SEPA. `returned` is a status, not an error, and it is the one that
//   makes a settled payment un-settle -- which Moat handles by subtracting
//   it from the mandate rather than by pretending it never happened.
//
//   Idempotency is the caller's job. Every rail here takes a key and
//   promises that two requests carrying the same one are one transfer. The
//   adapter computes it from what identifies the payment, never from a
//   timestamp or a counter.
//
//   The beneficiary name is checked separately from the account, or not at
//   all. Confirmation of Payee in the UK, VOP in the EU from October 2025.
//   It answers a question the account number cannot: whether the name on
//   the invoice is the name on the account. Optional here because not every
//   rail offers it.
//
// What is deliberately absent: batching, scheduling, standing orders,
// direct debits, FX. Each is real and none of them changes what Moat has to
// decide, so admitting them into the interface would buy nothing.

/** Where a transfer has got to. The vocabulary Moat's outcome machine maps. */
export type TransferState =
  /** Accepted by the provider, not yet sent to the scheme. */
  | "pending"
  /** Handed to the scheme. On most rails, unrecallable from here. */
  | "submitted"
  /** Money is with the beneficiary. */
  | "settled"
  /** The provider refused it. No money moved. */
  | "failed"
  /** It settled and came back: an R-transaction, a recall, a return. */
  | "returned";

/** What Confirmation of Payee says about a name against an account. */
export type PayeeMatch = "match" | "close_match" | "no_match" | "unavailable";

/** A payment instruction, in the terms every rail shares. */
export interface TransferRequest {
  /** The name on the invoice. Checked against the account where possible. */
  readonly beneficiaryName: string;
  /** The destination account, canonical. IBAN today; ABA and sort code later. */
  readonly iban: string;
  /** Decimal string, never a float. "480.50", not 480.5. */
  readonly amount: string;
  /** ISO 4217, uppercase. */
  readonly currency: string;
  /** What the beneficiary will see. Carries the invoice on real rails. */
  readonly reference: string;
  /**
   * Moat's own identifiers, to be carried in whatever field the rail has
   * for them and echoed back. This is what lets a statement line be
   * matched to a verdict months later.
   */
  readonly moat?: {
    readonly authorizationId?: string;
    readonly invoiceId?: string;
    readonly evidenceId?: string;
  };
}

/** What the provider says when it accepts one. */
export interface TransferResult {
  /** The provider's own identifier. Stable, and what `getTransfer` takes. */
  readonly reference: string;
  readonly state: TransferState;
  /** The canonical destination, as the provider understood it. */
  readonly iban: string;
  readonly amount: string;
  readonly currency: string;
  /** Charged by the provider, if it says. Decimal string. */
  readonly fee?: string;
  readonly feeCurrency?: string;
  /** What CoP said, if the provider was asked. */
  readonly beneficiaryMatch?: PayeeMatch;
  /** True when this is a replay of an earlier request under the same key. */
  readonly replayed: boolean;
  /** When the provider accepted it. */
  readonly acceptedAt: string;
}

/** Where a transfer is now, and why if it ended badly. */
export interface TransferStatus {
  readonly reference: string;
  readonly state: TransferState;
  readonly amount: string;
  readonly currency: string;
  /** The rail's own reason code: an ACH return code, a SEPA reason. */
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly settledAt?: string;
  readonly returnedAt?: string;
}

/** What a name check says, when a rail offers one. */
export interface PayeeCheck {
  readonly match: PayeeMatch;
  /** The name the bank holds, where the rail is willing to say. */
  readonly nameOnAccount?: string;
}

/**
 * One bank rail.
 *
 * Implementations live under `providers/`. Everything an implementation
 * throws is a transport failure as far as Moat is concerned, which on an
 * irreversible rail means the payment is held rather than retried -- so an
 * implementation must throw only when it genuinely does not know, and
 * return `failed` when it does.
 */
export interface BankProvider {
  /** Short stable name, recorded in evidence as the provider. */
  readonly id: string;

  /**
   * Instruct a transfer.
   *
   * `idempotencyKey` is a promise in both directions: the caller promises
   * the same key means the same payment, and the provider promises two
   * requests with one key are one transfer. A provider that cannot offer
   * that cannot be used on an irreversible rail.
   */
  createTransfer(request: TransferRequest, idempotencyKey: string): Promise<TransferResult>;

  /** Where a transfer has got to now. */
  getTransfer(reference: string): Promise<TransferStatus>;

  /** Every transfer this provider knows of, newest last. For operators. */
  listTransfers(): Promise<TransferStatus[]>;

  /** Confirmation of Payee, where the rail has it. */
  verifyPayee?(iban: string, beneficiaryName: string): Promise<PayeeCheck>;
}

/**
 * How a provider's state maps onto the `status` Moat reads.
 *
 * A pass-through, because the vocabulary above was chosen to be the one
 * `OutcomeStatus::from_provider` already understands. It is a function
 * rather than a cast so that a provider with its own words has one obvious
 * place to be translated, instead of leaking a private vocabulary into
 * evidence.
 */
export function moatStatus(state: TransferState): string {
  return state;
}
