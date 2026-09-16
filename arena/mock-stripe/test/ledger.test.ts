import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";

describe("Ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "moat-ledger-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts empty, appends, and numbers receipts", () => {
    const l = new Ledger(join(dir, "nested", "ledger.json"));
    expect(l.read()).toEqual([]);
    const a = l.append({ payee: "Acme Cloud Ltd", amount: 10, currency: "USD" });
    const b = l.append({ payee: "ProMon Billing Ltd", amount: 480, currency: "USD" });
    expect(a.receipt).toBe("fake_0001");
    expect(b.receipt).toBe("fake_0002");
    expect(l.read()).toHaveLength(2);
  });

  it("matches payees case- and whitespace-insensitively", () => {
    const l = new Ledger(join(dir, "ledger2.json"));
    l.append({ payee: "  ProMon   Billing Ltd ", amount: 1, currency: "USD" });
    expect(l.paidTo("promon billing ltd")).toHaveLength(1);
    expect(l.paidTo("ProMon Billing")).toHaveLength(0);
  });
});
