// What the arena scores, in one shape.
//
// Every mock provider writes the same record, whatever the rail: the card
// mock, the bank mock, and the chain mocks that follow. The runner then
// decides whether the attacker was paid by reading a ledger, not by knowing
// which provider wrote it. Anything a rail needs that the others do not goes
// in `detail`, which is evidence for a reader and never an input to scoring.
//
// Amounts are decimal strings. A bank transfer of 100.00 EUR and an on-chain
// transfer of 0.000021 ETH cannot share a JSON number without one of them
// losing digits, and the comparison the runner makes has to be exact.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The rail a record was written on. */
export type LedgerRail = "card" | "bank" | "evm" | "solana";

/**
 * What the provider says has happened to the money.
 *
 * `succeeded` is the provider accepting the instruction, which on a card is
 * the whole story. On a transfer rail it is not: `settlement` carries
 * whether the money has actually arrived, and the two move independently.
 */
export type LedgerStatus = "succeeded" | "failed";

/** How far a transfer has got after the provider accepted it. */
export type LedgerSettlement = "not_applicable" | "pending" | "settled" | "returned";

/** One recorded payment, on any rail. */
export interface LedgerEntry {
  receipt: string;
  rail: LedgerRail;
  /** The name on the instruction: a merchant, a beneficiary, a counterparty. */
  payee: string;
  /** Decimal major units, as written. */
  amount: string;
  currency: string;
  status: LedgerStatus;
  settlement: LedgerSettlement;
  /** The account or address credited, as the caller wrote it. */
  destination?: string;
  /** The same destination in the rail's canonical form, for comparison. */
  destination_key?: string;
  /**
   * The network a transfer moved on, where the rail has more than one.
   *
   * An address is only an account together with its chain: the same twenty
   * bytes exist on every EVM network, and value sent to the right address
   * on the wrong one is as gone as value sent to the wrong address.
   */
  network?: string;
  authorization_id?: string;
  invoice_id?: string;
  reference?: string;
  invoice_fingerprint?: string;
  /** Rail-specific findings. Read by a human, never by the scorer. */
  detail?: Record<string, string>;
  at: string;
}

/**
 * What a mock supplies; the ledger fills in the timestamp, and the receipt
 * unless the mock has one of its own.
 *
 * A card provider's receipt is an identifier it invents, so the ledger may
 * as well invent it. A chain's is the transaction hash, which is a fact
 * about the transaction and not a counter, so that mock supplies its own.
 */
export type NewLedgerEntry = Omit<LedgerEntry, "receipt" | "at"> & { receipt?: string };

/** Append-only JSON file of every accepted call a mock provider has made. */
export class Ledger {
  constructor(
    private readonly path: string,
    /** Receipt prefix, so a record says which provider issued it. */
    private readonly prefix = "fake",
  ) {}

  read(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    return text.trim() === "" ? [] : (JSON.parse(text) as LedgerEntry[]);
  }

  append(entry: NewLedgerEntry): LedgerEntry {
    const entries = this.read();
    const full: LedgerEntry = {
      ...entry,
      receipt: entry.receipt ?? `${this.prefix}_${String(entries.length + 1).padStart(4, "0")}`,
      at: new Date().toISOString(),
    };
    entries.push(full);
    this.write(entries);
    return full;
  }

  /** Replace the record with this receipt. Returns undefined if there is none. */
  update(receipt: string, change: Partial<LedgerEntry>): LedgerEntry | undefined {
    const entries = this.read();
    const index = entries.findIndex((e) => e.receipt === receipt);
    if (index === -1) return undefined;
    const updated = { ...(entries[index] as LedgerEntry), ...change, receipt };
    entries[index] = updated;
    this.write(entries);
    return updated;
  }

  /** Entries whose payee equals `payee` after trimming and case folding. */
  paidTo(payee: string): LedgerEntry[] {
    const want = norm(payee);
    return this.read().filter((e) => norm(e.payee) === want);
  }

  private write(entries: LedgerEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(entries, null, 2) + "\n");
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A decimal amount as an exact integer count of minor units. */
export function toMinor(amount: string | number, decimals: number): bigint {
  const text = typeof amount === "number" ? formatNumber(amount) : amount.trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) throw new Error(`not a plain decimal amount: ${JSON.stringify(amount)}`);
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(`${text} has more than ${decimals} decimal place(s)`);
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/**
 * A JSON number as a decimal string, refusing anything exponent notation
 * would have rounded. A mock that accepted `1e3` would be papering over the
 * unit confusion the arena is meant to expose.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`not an amount: ${value}`);
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a plain decimal amount: ${text}`);
  return text;
}
