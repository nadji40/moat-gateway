import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger, toMinor } from "../src/index.js";
import {
  canonicalIban,
  destinationKey,
  groupIban,
  parseDestination,
  sameDestination,
} from "../src/destination.js";

const dir = mkdtempSync(join(tmpdir(), "moat-mock-ledger-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AUTHORIZED = "DE63113351422523808509";
const LOOKALIKE = "DE63113307965804068509";

function entry(over: Partial<Parameters<Ledger["append"]>[0]> = {}) {
  return {
    rail: "bank" as const,
    payee: "Monitoring Pro Inc",
    amount: "100.00",
    currency: "EUR",
    status: "succeeded" as const,
    settlement: "pending" as const,
    ...over,
  };
}

describe("Ledger", () => {
  it("creates the directory and numbers receipts with the provider's prefix", () => {
    const ledger = new Ledger(join(dir, "nested", "bank.json"), "bank");
    expect(ledger.read()).toEqual([]);
    expect(ledger.append(entry()).receipt).toBe("bank_0001");
    expect(ledger.append(entry()).receipt).toBe("bank_0002");
    expect(ledger.read()).toHaveLength(2);
  });

  it("finds entries by payee however the name is spaced or cased", () => {
    const ledger = new Ledger(join(dir, "payee.json"), "bank");
    ledger.append(entry());
    expect(ledger.paidTo("  monitoring   pro inc ")).toHaveLength(1);
    expect(ledger.paidTo("Monitoring Pro")).toHaveLength(0);
  });

  it("updates a record in place and leaves the receipt alone", () => {
    const ledger = new Ledger(join(dir, "settle.json"), "bank");
    const written = ledger.append(entry());
    const settled = ledger.update(written.receipt, { settlement: "settled" });
    expect(settled?.settlement).toBe("settled");
    expect(settled?.receipt).toBe(written.receipt);
    expect(ledger.update("bank_9999", { settlement: "settled" })).toBeUndefined();
  });
});

describe("toMinor", () => {
  it("is exact for the decimals the asset has", () => {
    expect(toMinor("100", 2)).toBe(10000n);
    expect(toMinor("100.5", 2)).toBe(10050n);
    expect(toMinor("0.000021", 6)).toBe(21n);
    expect(toMinor(99, 2)).toBe(9900n);
  });

  // Reading 100.005 EUR as 100.00 would silently forgive exactly the
  // rounding an attacker would use to stay under a limit.
  it("refuses more decimals than the asset has, and exponent notation", () => {
    expect(() => toMinor("100.005", 2)).toThrow(/decimal place/);
    expect(() => toMinor("1e3", 2)).toThrow(/plain decimal/);
    expect(() => toMinor(1e21, 2)).toThrow(/plain decimal/);
  });
});

describe("destinations", () => {
  it("treats spacing and case as presentation", () => {
    expect(sameDestination(AUTHORIZED, groupIban(AUTHORIZED))).toBe(true);
    expect(sameDestination(AUTHORIZED, AUTHORIZED.toLowerCase())).toBe(true);
    expect(destinationKey(parseDestination(AUTHORIZED))).toBe(`iban:${AUTHORIZED}`);
  });

  // The whole point: an account that looks right at a glance is a different
  // account, and nothing about the resemblance counts.
  it("does not confuse an account that shares its head and tail", () => {
    expect(LOOKALIKE.slice(0, 8)).toBe(AUTHORIZED.slice(0, 8));
    expect(LOOKALIKE.slice(-4)).toBe(AUTHORIZED.slice(-4));
    expect(sameDestination(AUTHORIZED, LOOKALIKE)).toBe(false);
  });

  it("rejects a string that fails the check digits, and keeps it opaque", () => {
    expect(canonicalIban("DE64113351422523808509")).toBeUndefined();
    expect(parseDestination("acct_supplier_001").kind).toBe("opaque");
    expect(sameDestination("acct_supplier_001", " acct_supplier_001 ")).toBe(true);
    expect(sameDestination("acct_supplier_001", "ACCT_SUPPLIER_001")).toBe(false);
  });
});
