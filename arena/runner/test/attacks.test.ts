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
import { implementedRails, railSpec } from "../src/rails.js";
import { percentile } from "../src/results.js";
import { renderTable, summarize } from "../src/table.js";

const ARENA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("attack corpus", () => {
  const sources = loadAttacks(ARENA_ROOT);

  it("has twenty-two attacks with unique ids and every class represented", () => {
    expect(sources).toHaveLength(22);
    expect(new Set(sources.map((s) => s.id)).size).toBe(22);
    const classes = sources.map(
      (s) => (scenarioForRail(ARENA_ROOT, s, s.rails[0]!) as Attack).class,
    );
    for (const c of ATTACK_CLASSES) {
      expect(classes, c).toContain(c);
    }
  });

  // One corpus, four rails. The counts differ only where a scenario
  // cannot mean anything on a rail, and each gap is a decision recorded in
  // the scenario that declines the rail.
  it("runs one corpus across every rail, and says where it cannot", () => {
    // Card is short the lost-reply attack (a card retry is safe) and the
    // three that are about chains.
    expect(sourcesForRail(sources, "card")).toHaveLength(17);
    // Bank takes the lost-reply attack and none of the chain ones.
    expect(sourcesForRail(sources, "bank")).toHaveLength(19);
    // EVM takes everything, because it is the only family with allowances.
    expect(sourcesForRail(sources, "evm")).toHaveLength(21);
    // Solana takes everything except the allowance attack.
    expect(sourcesForRail(sources, "solana")).toHaveLength(20);
  });

  // Every scenario has to survive expansion onto every rail it declares.
  // A placeholder nobody defined is an error here rather than a blank cell
  // in a table somebody is about to publish.
  it("expands onto each declared rail with the attacker as a named target", () => {
    for (const source of sources) {
      for (const rail of implementedRails()) {
        if (!source.rails.includes(rail)) continue;
        const attack = scenarioForRail(ARENA_ROOT, source, rail) as Attack;
        const payeeArg = railSpec(rail).args.payee;
        const payees = attack.injection.calls.map((c) => String(c[payeeArg]).toLowerCase());
        expect(payees, `${source.id}/${rail}`).toContain(attack.expected.toLowerCase());
      }
    }
  });

  // A chain call is not a chain call without a chain, and expansion is
  // what supplies one. A blank here would send every scenario to whatever
  // network the wallet happened to be on and quietly stop measuring the
  // one attack that is about networks.
  it("gives every call on a chain rail a network, without being asked", () => {
    for (const source of sources) {
      for (const rail of ["evm", "solana"] as const) {
        if (!source.rails.includes(rail)) continue;
        const attack = scenarioForRail(ARENA_ROOT, source, rail) as Attack;
        const expected =
          source.id === "chain-network-substitution"
            ? railSpec(rail).fixtures.alt_network
            : railSpec(rail).fixtures.network;
        for (const call of attack.injection.calls) {
          expect(call["network"], `${source.id}/${rail}`).toBe(expected);
        }
        expect(attack.authorization.network, `${source.id}/${rail}`).toBe(
          railSpec(rail).fixtures.network,
        );
      }
    }
  });

  // The allowance attack is the one scenario that calls a different tool,
  // and the spender has to land in the argument that tool takes.
  it("routes an allowance to the spender argument rather than the recipient", () => {
    const source = sources.find((s) => s.id === "chain-approval-grant");
    expect(source?.rails).toEqual(["evm"]);
    const attack = scenarioForRail(ARENA_ROOT, source!, "evm") as Attack;
    const [call] = attack.injection.calls;
    expect(call?.["tool"]).toBe("approve");
    expect(call?.["spender"]).toBe(railSpec("evm").fixtures.authorized.destination_display);
    expect(call?.["to_address"]).toBeUndefined();
  });

  it("models a single-payment approval reused from a separate session", () => {
    const source = sources.find((candidate) => candidate.id === "max-payments-cross-session");
    expect(source?.rails).toEqual(["bank"]);
    const attack = scenarioForRail(ARENA_ROOT, source!, "bank") as Attack;
    expect(attack.requires_durable_storage).toBe(true);
    expect(attack.authorization).toMatchObject({ max_payments: 1, invoice_id: null });
    expect(attack.injection.calls[0]).toMatchObject({
      invoice_id: "INV-SESSION-A",
      amount: 25,
      currency: "EUR",
    });
    expect(attack.additional_sessions).toHaveLength(1);
    expect(attack.additional_sessions[0]?.calls[0]).toMatchObject({
      invoice_id: "INV-SESSION-B",
      amount: 25,
      currency: "EUR",
    });
    expect(attack.additional_sessions[0]?.calls[0]?.["beneficiary_iban"]).toBe(
      railSpec("bank").fixtures.authorized.destination_display,
    );
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

  it("has nine controls with exact expected payment outcomes", () => {
    expect(sources).toHaveLength(9);
    expect(new Set(sources.map((source) => source.id)).size).toBe(9);
    for (const source of sources) {
      for (const rail of implementedRails()) {
        if (!source.rails.includes(rail)) continue;
        const control = scenarioForRail(ARENA_ROOT, source, rail) as Control;
        const { payee: payeeArg, currency: currencyArg } = railSpec(rail).args;
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
          [currencyArg]: control.expected_currency,
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
