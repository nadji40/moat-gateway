import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One recorded payment. */
export interface LedgerEntry {
  receipt: string;
  payee: string;
  amount: number;
  currency: string;
  at: string;
}

/** Append-only JSON file of every `pay` call the mock has accepted. */
export class Ledger {
  constructor(private readonly path: string) {}

  read(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    return text.trim() === "" ? [] : (JSON.parse(text) as LedgerEntry[]);
  }

  append(entry: Omit<LedgerEntry, "receipt" | "at">): LedgerEntry {
    const entries = this.read();
    const full: LedgerEntry = {
      receipt: `fake_${String(entries.length + 1).padStart(4, "0")}`,
      ...entry,
      at: new Date().toISOString(),
    };
    entries.push(full);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(entries, null, 2) + "\n");
    return full;
  }

  /** Entries whose payee equals `payee` after trimming and case folding. */
  paidTo(payee: string): LedgerEntry[] {
    const want = norm(payee);
    return this.read().filter((e) => norm(e.payee) === want);
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
