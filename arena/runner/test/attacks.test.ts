import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTACK_CLASSES,
  loadAttacks,
  loadControls,
  pageUrl,
  scenarioForRail,
  sourcesForRail,
  type Attack,
  type Control,
} from "../src/attacks.js";
import { implementedRails } from "../src/rails.js";
import { percentile } from "../src/results.js";
import { renderTable, summarize } from "../src/table.js";

const ARENA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("attack corpus", () => {
  const sources = loadAttacks(ARENA_ROOT);

  it("has eighteen attacks with unique ids and every class represented", () => {
    expect(sources).toHaveLength(18);
    expect(new Set(sources.map((s) => s.id)).size).toBe(18);
    const classes = sources.map(
      (s) => (scenarioForRail(ARENA_ROOT, s, s.rails[0]!) as Attack).class,
    );
    for (const c of ATTACK_CLASSES) {
      expect(classes, c).toContain(c);
    }
  });

  it("runs the card corpus on the bank rail too, bar what is card-specific", () => {
    expect(sourcesForRail(sources, "card")).toHaveLength(17);
    expect(sourcesForRail(sources, "bank")).toHaveLength(18);
  });

  // Every scenario has to survive expansion onto every rail it declares.
  // A placeholder nobody defined is an error here rather than a blank cell
  // in a table somebody is about to publish.
  it("expands onto each declared rail with the attacker as a named target", () => {
    for (const source of sources) {
      for (const rail of implementedRails()) {
        if (!source.rails.includes(rail)) continue;
        const attack = scenarioForRail(ARENA_ROOT, source, rail) as Attack;
        const spec = rail === "card" ? "payee" : "beneficiary_name";
        const payees = attack.injection.calls.map((c) => String(c[spec]).toLowerCase());
        expect(payees, `${source.id}/${rail}`).toContain(attack.expected.toLowerCase());
      }
    }
  });

  it("builds arena URLs with the rail in the path", () => {
    expect(pageUrl("attacks/x/page.html", "card")).toBe(
      "https://arena.local/card/attacks/x/page.html",
    );
    expect(pageUrl("attacks/x/page.html", "bank")).toBe(
      "https://arena.local/bank/attacks/x/page.html",
    );
  });
});

describe("legitimate control corpus", () => {
  const sources = loadControls(ARENA_ROOT);

  it("has eight controls with exact expected payment outcomes", () => {
    expect(sources).toHaveLength(8);
    expect(new Set(sources.map((source) => source.id)).size).toBe(8);
    for (const source of sources) {
      for (const rail of implementedRails()) {
        if (!source.rails.includes(rail)) continue;
        const control = scenarioForRail(ARENA_ROOT, source, rail) as Control;
        const payeeArg = rail === "card" ? "payee" : "beneficiary_name";
        // At least, not exactly: a control that recovers from a lost reply
        // makes a call that does not become a payment, which is the whole
        // thing it is testing.
        expect(
          control.execution.calls.length,
          source.id,
        ).toBeGreaterThanOrEqual(control.expected_payments);
        expect(control.execution.calls[0], `${source.id}/${rail}`).toMatchObject({
          [payeeArg]: control.expected_payee,
          amount: control.expected_amount,
          currency: control.expected_currency,
        });
      }
    }
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
      wall_ms: 0,
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

  it("reports legitimate completion separately from attack success", () => {
    const base = {
      run_id: "r",
      backend: "null",
      attack: "authorized-exact",
      class: "legitimate-invoice",
      scenario_kind: "control" as const,
      iteration: 1,
      attacker_paid: false,
      attacker_payments: 0,
      verdicts: ["paid"],
      fetch_ms: [1],
      pay_ms: [1],
      wall_ms: 2,
      trace: { fetches: [], pays: [] },
      at: "",
    };
    const rows = [
      { ...base, mode: "direct" as const, legitimate_completed: true },
      { ...base, mode: "gateway" as const, legitimate_completed: true },
    ];
    const table = renderTable(rows);
    expect(table).toContain("completed (gateway)");
    expect(table).toContain("legitimate completed: direct 1/1, gateway 1/1");
    expect(table).not.toContain("attacker paid:");
  });
});
