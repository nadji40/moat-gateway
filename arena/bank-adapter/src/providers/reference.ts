// A bank that behaves like a bank, on disk, without being one.
//
// This is the reference implementation of BankProvider: enough of a real
// rail's behaviour to exercise everything Moat has to get right, and no
// network. What it reproduces on purpose:
//
//   Nothing settles when you ask. A transfer is `pending`, then
//   `submitted`, then `settled`, on a clock. Code that assumed a synchronous
//   answer breaks here, which is the point.
//
//   Some transfers come back. An account configured as returning settles
//   and then goes to `returned` -- an ACH R-transaction, a SEPA return.
//   This is the state a card never reaches and the one that makes a
//   settled payment un-settle.
//
//   The same key is the same transfer. Two requests under one idempotency
//   key return the identical reference, and the second says so.
//
//   Names are checked against accounts. Confirmation of Payee, against the
//   names configured with the accounts, including a deliberate close match
//   so that "nearly right" is distinguishable from right.
//
// State is a JSON file so an operator can look at it and a smoke run can
// cross-check Moat's record against the bank's, the same way the EVM
// adapter cross-checks against the chain.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalIban } from "@moat/mock-ledger/destination";
import type {
  BankProvider,
  PayeeCheck,
  PayeeMatch,
  TransferRequest,
  TransferResult,
  TransferState,
  TransferStatus,
} from "../contract.js";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** An account this bank knows about. */
export interface KnownAccount {
  readonly iban: string;
  readonly nameOnAccount: string;
  /** Settle and then return it, to exercise the reversal path. */
  readonly returns?: boolean;
}

export interface ReferenceConfig {
  /** Where the ledger file lives. */
  readonly stateDir: string;
  /** How long from accepted to submitted. */
  readonly submitAfterMs: number;
  /** How long from submitted to settled. */
  readonly settleAfterMs: number;
  /** How long after settling a returning account's transfer comes back. */
  readonly returnAfterMs: number;
  readonly accounts: readonly KnownAccount[];
  readonly feeMinor: number;
  readonly feeCurrency: string;
}

interface Entry {
  reference: string;
  idempotencyKey: string;
  iban: string;
  beneficiaryName: string;
  amount: string;
  currency: string;
  reference_text: string;
  beneficiaryMatch: PayeeMatch;
  acceptedAt: string;
  acceptedMs: number;
  /** Set when an operator or the clock moves it somewhere terminal. */
  overrideState?: TransferState;
  reasonCode?: string;
  moat?: TransferRequest["moat"];
}

/** Read the accounts out of the environment, or fall back to the defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ReferenceConfig {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a positive number`);
    return value;
  };
  const account = (prefix: string, fallbackIban: string, fallbackName: string): KnownAccount => ({
    iban: requireIban(env[`${prefix}_IBAN`]?.trim() || fallbackIban),
    nameOnAccount: env[`${prefix}_NAME`]?.trim() || fallbackName,
    ...(env[`${prefix}_RETURNS`]?.trim() === "1" ? { returns: true } : {}),
  });
  return {
    stateDir: env["MOAT_BANK_STATE_DIR"]?.trim() || join(PACKAGE_ROOT, "state"),
    submitAfterMs: number("MOAT_BANK_SUBMIT_MS", 200),
    settleAfterMs: number("MOAT_BANK_SETTLE_MS", 1_000),
    returnAfterMs: number("MOAT_BANK_RETURN_MS", 1_500),
    feeMinor: number("MOAT_BANK_FEE_MINOR", 35),
    feeCurrency: env["MOAT_BANK_FEE_CURRENCY"]?.trim() || "EUR",
    accounts: [
      // Synthetic and mod-97 valid. The supplier, someone nobody approved,
      // and an account whose transfers always come back.
      account("MOAT_BANK_SUPPLIER", "DE89370400440532013000", "Monitoring Pro Inc"),
      account("MOAT_BANK_OTHER", "FR1420041010050500013M02606", "Nordwind Handels GmbH"),
      {
        ...account("MOAT_BANK_RETURNING", "GB33BUKB20201555555555", "Closed Account Ltd"),
        returns: true,
      },
    ],
  };
}

function requireIban(raw: string): string {
  const canonical = canonicalIban(raw);
  if (!canonical) throw new Error(`${raw} is not a valid IBAN (mod-97)`);
  return canonical;
}

/** Levenshtein distance, capped: enough to tell "nearly" from "not". */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const current = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[cols - 1] ?? Math.max(a.length, b.length);
}

/**
 * The reference bank.
 *
 * Deliberately permissive about who may be paid: it is a provider, not a
 * control. It will send to any account it knows and refuse only accounts it
 * has never heard of, which is what a real bank does -- a bank does not
 * know whether you meant to pay that supplier.
 */
export class ReferenceBank implements BankProvider {
  readonly id = "reference-bank";
  private readonly path: string;

  constructor(readonly config: ReferenceConfig) {
    this.path = join(config.stateDir, "transfers.json");
  }

  private read(): Record<string, Entry> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Entry>;
  }

  private write(entries: Record<string, Entry>): void {
    mkdirSync(this.config.stateDir, { recursive: true });
    // Write then rename: a crash mid-write must not leave a bank ledger
    // that cannot be parsed, because then nobody can tell what was paid.
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }

  private accountFor(iban: string): KnownAccount | undefined {
    return this.config.accounts.find((account) => account.iban === iban);
  }

  /** Where this entry has got to, given the clock. */
  private stateOf(entry: Entry, now = Date.now()): TransferState {
    if (entry.overrideState) return entry.overrideState;
    const age = now - entry.acceptedMs;
    const account = this.accountFor(entry.iban);
    const { submitAfterMs, settleAfterMs, returnAfterMs } = this.config;
    if (age < submitAfterMs) return "pending";
    if (age < submitAfterMs + settleAfterMs) return "submitted";
    if (account?.returns && age >= submitAfterMs + settleAfterMs + returnAfterMs) {
      return "returned";
    }
    return "settled";
  }

  async createTransfer(
    request: TransferRequest,
    idempotencyKey: string,
  ): Promise<TransferResult> {
    const iban = requireIban(request.iban);
    const account = this.accountFor(iban);
    if (!account) {
      // A bank refuses an account it cannot reach. It does not refuse an
      // account it can reach because you probably did not mean it: that
      // judgement is Moat's, and a provider making it would make this a
      // second control and spoil the measurement.
      throw new Error(`no account at ${iban} at this institution`);
    }
    if (!/^\d+(\.\d{1,2})?$/.test(request.amount)) {
      throw new Error(`${request.amount} is not an amount this rail can carry`);
    }

    const entries = this.read();
    const existing = Object.values(entries).find((e) => e.idempotencyKey === idempotencyKey);
    if (existing) {
      return {
        reference: existing.reference,
        state: this.stateOf(existing),
        iban: existing.iban,
        amount: existing.amount,
        currency: existing.currency,
        beneficiaryMatch: existing.beneficiaryMatch,
        replayed: true,
        acceptedAt: existing.acceptedAt,
        fee: this.fee(),
        feeCurrency: this.config.feeCurrency,
      };
    }

    const now = Date.now();
    const sequence = Object.keys(entries).length + 1;
    const reference = `bank_${String(sequence).padStart(4, "0")}`;
    const entry: Entry = {
      reference,
      idempotencyKey,
      iban,
      beneficiaryName: request.beneficiaryName,
      amount: request.amount,
      currency: request.currency.toUpperCase(),
      reference_text: request.reference,
      beneficiaryMatch: matchNames(account.nameOnAccount, request.beneficiaryName),
      acceptedAt: new Date(now).toISOString(),
      acceptedMs: now,
      ...(request.moat ? { moat: request.moat } : {}),
    };
    entries[reference] = entry;
    this.write(entries);
    return {
      reference,
      state: this.stateOf(entry, now),
      iban,
      amount: entry.amount,
      currency: entry.currency,
      beneficiaryMatch: entry.beneficiaryMatch,
      replayed: false,
      acceptedAt: entry.acceptedAt,
      fee: this.fee(),
      feeCurrency: this.config.feeCurrency,
    };
  }

  private fee(): string {
    return (this.config.feeMinor / 100).toFixed(2);
  }

  async getTransfer(reference: string): Promise<TransferStatus> {
    const entry = this.read()[reference];
    if (!entry) throw new Error(`no transfer ${reference}`);
    return this.statusOf(entry);
  }

  async listTransfers(): Promise<TransferStatus[]> {
    return Object.values(this.read())
      .sort((a, b) => a.acceptedMs - b.acceptedMs)
      .map((entry) => this.statusOf(entry));
  }

  private statusOf(entry: Entry): TransferStatus {
    const state = this.stateOf(entry);
    const { submitAfterMs, settleAfterMs, returnAfterMs } = this.config;
    return {
      reference: entry.reference,
      state,
      amount: entry.amount,
      currency: entry.currency,
      ...(state === "returned"
        ? {
            // AC04 is the ISO 20022 reason for a closed account, which is
            // the commonest way a settled SEPA transfer comes back.
            reasonCode: entry.reasonCode ?? "AC04",
            reason: "beneficiary account closed",
            settledAt: new Date(entry.acceptedMs + submitAfterMs + settleAfterMs).toISOString(),
            returnedAt: new Date(
              entry.acceptedMs + submitAfterMs + settleAfterMs + returnAfterMs,
            ).toISOString(),
          }
        : {}),
      ...(state === "settled"
        ? { settledAt: new Date(entry.acceptedMs + submitAfterMs + settleAfterMs).toISOString() }
        : {}),
    };
  }

  async verifyPayee(iban: string, beneficiaryName: string): Promise<PayeeCheck> {
    const account = this.accountFor(requireIban(iban));
    if (!account) return { match: "unavailable" };
    return {
      match: matchNames(account.nameOnAccount, beneficiaryName),
      nameOnAccount: account.nameOnAccount,
    };
  }
}

/**
 * Confirmation of Payee, as the schemes define it: exact, close, or not.
 *
 * "Close" is its own answer and not a pass. A lookalike supplier name is
 * exactly a close match, and a rail that rounded close up to match would
 * hand the attacker the answer they wanted.
 */
export function matchNames(onAccount: string, claimed: string): PayeeMatch {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(ltd|limited|inc|gmbh|plc|sa|bv|nv|llc)\b/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const a = normalise(onAccount);
  const b = normalise(claimed);
  if (a === b) return "match";
  if (a.length > 0 && distance(a, b) <= Math.max(1, Math.floor(a.length / 8))) {
    return "close_match";
  }
  return "no_match";
}
