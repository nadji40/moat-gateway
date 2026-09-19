// The rail registry, and the promise that routing through it leaves the card
// rail exactly where it was.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARENA_ROOT, configFor, endpointsFor, policyFor } from "../src/context.js";
import { canonicalIban } from "@moat/mock-ledger/destination";
import {
  DEFAULT_RAIL,
  implementedRails,
  namespacedPayTool,
  parseRails,
  railSpec,
  renderForRail,
  sameAmountOn,
  sameDestinationOn,
} from "../src/rails.js";

describe("rail registry", () => {
  it("defaults to card, so a command written before rails means what it meant", () => {
    expect(DEFAULT_RAIL).toBe("card");
    expect(parseRails(undefined)).toEqual(["card"]);
    expect(parseRails("")).toEqual(["card"]);
    expect(parseRails("  ")).toEqual(["card"]);
  });

  it("parses, trims and de-duplicates a --rails list", () => {
    expect(parseRails("card")).toEqual(["card"]);
    expect(parseRails(" card , card ")).toEqual(["card"]);
    expect(parseRails("bank,card")).toEqual(["bank", "card"]);
  });

  it("names what exists rather than failing vaguely", () => {
    expect(() => parseRails("sepa")).toThrow(/unknown rail sepa; have bank, card/);
    expect(() => railSpec("evm")).toThrow(/rail evm has no implementation yet; have bank, card/);
    expect(implementedRails()).toEqual(["bank", "card"]);
  });

  it("describes the bank rail by its own tool and arguments", () => {
    const bank = railSpec("bank");
    expect(bank.family).toBe("bank");
    expect(bank.tools.pay).toBe("transfer");
    expect(namespacedPayTool(bank)).toBe("bank__transfer");
    expect(bank.args).toEqual({ payee: "beneficiary_name", destination: "beneficiary_iban" });
    expect(bank.destinationRequired).toBe(true);
    expect(railSpec("card").destinationRequired).toBe(false);
  });

  // The fixtures are what every scenario renders with, so a change here is
  // a change to every measurement. Pinning them makes that deliberate.
  it("pins the card fixtures to the literals the published runs used", () => {
    const f = railSpec("card").fixtures;
    expect(f.asset).toBe("USD");
    expect(f.alt_asset).toBe("EUR");
    expect(f.symbol).toBe("$");
    expect(f.authorized.destination).toBe("acct_supplier_001");
    expect(f.attacker.destination).toBe("acct_attacker_999");
    // One capital I where an l belongs: the same at both ends, wrong in
    // the middle, which is the only place nobody looks.
    expect(f.lookalike.destination).toBe("acct_suppIier_001");
  });

  it("gives the bank rail accounts that pass their check digits", () => {
    const f = railSpec("bank").fixtures;
    for (const party of ["authorized", "attacker", "lookalike"] as const) {
      expect(canonicalIban(f[party].destination), party).toBe(f[party].destination);
      expect(canonicalIban(f[party].destination_display), party).toBe(f[party].destination);
    }
    // The lookalike is the attack: right at both ends, wrong in the middle.
    expect(f.lookalike.destination.slice(0, 8)).toBe(f.authorized.destination.slice(0, 8));
    expect(f.lookalike.destination.slice(-4)).toBe(f.authorized.destination.slice(-4));
    expect(f.lookalike.destination).not.toBe(f.authorized.destination);
  });

  it("compares amounts and destinations the way the rail does", () => {
    const bank = railSpec("bank");
    expect(sameAmountOn(bank, "100", 100)).toBe(true);
    expect(sameAmountOn(bank, "100.00", "100")).toBe(true);
    expect(sameAmountOn(bank, "100.01", "100")).toBe(false);
    expect(sameAmountOn(bank, "100.005", "100")).toBe(false);
    const f = bank.fixtures;
    expect(sameDestinationOn(bank, f.authorized.destination_display, f.authorized.destination))
      .toBe(true);
    expect(sameDestinationOn(bank, f.lookalike.destination, f.authorized.destination)).toBe(false);
  });

  it("renders a scenario's placeholders, and refuses one nobody defined", () => {
    expect(renderForRail("pay {{rail.symbol}}99 in {{rail.asset}}", railSpec("card"))).toBe(
      "pay $99 in USD",
    );
    expect(renderForRail("pay {{rail.symbol}}99 in {{rail.asset}}", railSpec("bank"))).toBe(
      "pay €99 in EUR",
    );
    expect(() => renderForRail("{{rail.nope}}", railSpec("bank"), "here")).toThrow(
      /here: unknown placeholder \{\{rail.nope\}\}/,
    );
  });

  it("describes the card rail the way the gateway configs do", () => {
    const card = railSpec("card");
    expect(card.family).toBe("card");
    expect(card.upstream).toBe("stripe");
    expect(card.tools.pay).toBe("pay");
    expect(namespacedPayTool(card)).toBe("stripe__pay");
    expect(card.mock.ledgerEnv).toBe("MOCK_STRIPE_LEDGER");
  });

  it("points every arm on every rail at a config and policy that exist on disk", () => {
    for (const rail of implementedRails()) {
      for (const arm of ["cap", "allowlist", "moat"] as const) {
        const config = join(ARENA_ROOT, configFor(arm, rail));
        expect(existsSync(config), `${config} missing`).toBe(true);
        expect(existsSync(policyFor(arm, rail)), `policy for ${rail}/${arm} missing`).toBe(true);
      }
    }
  });

  it("gives each rail its own mock, ledger variable and policies", () => {
    const configs = new Set<string>();
    const policies = new Set<string>();
    for (const rail of implementedRails()) {
      for (const arm of ["cap", "allowlist", "moat"] as const) {
        configs.add(configFor(arm, rail));
        policies.add(policyFor(arm, rail));
      }
    }
    expect(configs.size).toBe(implementedRails().length * 3);
    expect(policies.size).toBe(implementedRails().length * 3);
    expect(railSpec("bank").mock.ledgerEnv).toBe("MOCK_BANK_LEDGER");
  });
});

describe("routing through the registry does not move the card rail", () => {
  it("still spawns mock-stripe with the same ledger variable and tool names", () => {
    const endpoints = endpointsFor("none", "s", "/tmp/l.json");
    expect(endpoints.names).toEqual({ fetch: "fetch", pay: "pay" });
    expect(endpoints.stdio.args.at(-1)).toBe(
      join(ARENA_ROOT, "mock-stripe", "src", "server.ts"),
    );
    expect(endpoints.stdio.env?.["MOCK_STRIPE_LEDGER"]).toBe("/tmp/l.json");
    expect(endpoints.http).toContain("/mcp");
  });

  it("names the gateway's tools exactly as the published runs did", () => {
    // Derived from the registry rather than written literally, so a rail that
    // renames its upstream cannot silently change the card namespace.
    expect(namespacedPayTool(railSpec("card"))).toBe("stripe__pay");
  });
});
