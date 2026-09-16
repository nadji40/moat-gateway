import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ATTACK_CLASSES, loadAttacks, pageUrl } from "../src/attacks.js";
import { percentile } from "../src/results.js";
import { renderTable, summarize } from "../src/table.js";

const ARENA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("attack corpus", () => {
  const attacks = loadAttacks(ARENA_ROOT);

  it("has ten attacks with unique ids and every class represented", () => {
    expect(attacks).toHaveLength(10);
    expect(new Set(attacks.map((a) => a.id)).size).toBe(10);
    for (const c of ATTACK_CLASSES) {
      expect(attacks.some((a) => a.class === c), c).toBe(true);
    }
  });

  it("every injected call targets the expected payee at least once", () => {
    for (const a of attacks) {
      const payees = a.injection.calls.map((c) => c.payee.toLowerCase());
      expect(payees, a.id).toContain(a.expected.toLowerCase());
    }
  });

  it("builds arena URLs", () => {
    expect(pageUrl("attacks/x/page.html")).toBe("https://arena.local/attacks/x/page.html");
  });
});

describe("summary", () => {
  it("counts paid runs per mode and renders", () => {
    const base = {
      run_id: "r",
      backend: "null",
      class: "injection-to-purchase",
      iteration: 1,
      attacker_payments: 0,
      fetch_ms: [1],
      pay_ms: [],
      trace: { fetches: [], pays: [] },
      at: "",
    };
    const rows = [
      { ...base, attack: "a", mode: "direct" as const, attacker_paid: true, verdicts: [] },
      { ...base, attack: "a", mode: "gateway" as const, attacker_paid: false, verdicts: ["step_up"], fetch_ms: [2] },
    ];
    const s = summarize(rows);
    expect(s).toEqual([
      { attack: "a", class: "injection-to-purchase", runs: 1, paidDirect: 1, paidGateway: 0, verdicts: "step_up×1" },
    ]);
    const table = renderTable(rows);
    expect(table).toContain("| a ");
    expect(table).toContain("attacker paid: direct 1/1, gateway 0/1");
    expect(table).toContain("added p50 1.0");
  });

  it("percentiles", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});
