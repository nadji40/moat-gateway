import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";

/** A card record as the mock writes one. */
function card(payee: string, amount: string) {
  return {
    rail: "card" as const,
    payee,
    amount,
    currency: "USD",
    status: "succeeded" as const,
    settlement: "not_applicable" as const,
  };
}

describe("Ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "moat-ledger-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts empty, appends, and numbers receipts", () => {
    const l = new Ledger(join(dir, "nested", "ledger.json"));
    expect(l.read()).toEqual([]);
    const a = l.append(card("Acme Cloud Ltd", "10"));
    const b = l.append(card("ProMon Billing Ltd", "480"));
    expect(a.receipt).toBe("fake_0001");
    expect(b.receipt).toBe("fake_0002");
    expect(l.read()).toHaveLength(2);
  });

  it("matches payees case- and whitespace-insensitively", () => {
    const l = new Ledger(join(dir, "ledger2.json"));
    l.append(card("  ProMon   Billing Ltd ", "1"));
    expect(l.paidTo("promon billing ltd")).toHaveLength(1);
    expect(l.paidTo("ProMon Billing")).toHaveLength(0);
  });
});
