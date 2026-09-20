import { describe, expect, it } from "vitest";
import {
  fixturesFor,
  isRail,
  railsWithFixtures,
  renderForRail,
  splitRailPath,
  substitutions,
} from "../src/index.js";

describe("fixtures", () => {
  // Every rail answers the same questions, so a scenario written once can
  // be rendered for any of them. The network pair is the exception and is
  // an exception on purpose: a card payment has no chain, and a card
  // scenario reaching for one should fail loudly rather than render blank.
  it("defines every shared placeholder for every rail, and never blank", () => {
    const shared = Object.keys(substitutions("card")).sort();
    for (const rail of railsWithFixtures()) {
      const keys = Object.keys(substitutions(rail));
      expect(keys.filter((k) => !k.startsWith("rail.network") && k !== "rail.alt_network").sort(),
        rail).toEqual(shared);
      for (const [key, value] of Object.entries(substitutions(rail))) {
        expect(value, `${rail}.${key}`).not.toBe("");
      }
    }
  });

  it("offers a network only where there is more than one", () => {
    for (const rail of ["evm", "solana"] as const) {
      expect(substitutions(rail)["rail.network"], rail).toBeDefined();
      expect(substitutions(rail)["rail.alt_network"], rail).toBeDefined();
      expect(substitutions(rail)["rail.network"], rail).not.toBe(
        substitutions(rail)["rail.alt_network"],
      );
    }
    for (const rail of ["card", "bank"] as const) {
      expect(substitutions(rail)["rail.network"], rail).toBeUndefined();
    }
  });

  // Every rail's accounts must be distinct from every other rail's, or a
  // scenario that failed to render would still look plausible.
  it("gives no two parties on a rail the same account", () => {
    for (const rail of railsWithFixtures()) {
      const f = fixturesFor(rail);
      const accounts = [f.authorized, f.attacker, f.lookalike, f.newcomer].map(
        (d) => d.destination,
      );
      expect(new Set(accounts).size, rail).toBe(4);
      expect(f.asset, rail).not.toBe(f.alt_asset);
    }
  });

  it("names the rails it has, and refuses one it does not", () => {
    expect(railsWithFixtures()).toEqual(["bank", "card", "evm", "solana"]);
    expect(isRail("bank")).toBe(true);
    expect(isRail("solana")).toBe(true);
    expect(isRail("sepa")).toBe(false);
  });
});

describe("rendering", () => {
  it("substitutes what it knows and refuses what it does not", () => {
    expect(renderForRail("{{rail.asset}} {{ rail.id }}", "bank")).toBe("EUR bank");
    expect(renderForRail("{{rail.asset}} on {{rail.network}}", "evm")).toBe(
      "USDC on eip155:84532",
    );
    // The card rail has no chain, so asking for one is a mistake in the
    // corpus rather than something to paper over.
    expect(() => renderForRail("{{rail.network}}", "card", "inv.html")).toThrow(
      /unknown placeholder \{\{rail.network\}\} for rail card/,
    );
    expect(() => renderForRail("{{rail.gone}}", "card", "page.html")).toThrow(
      /page.html: unknown placeholder/,
    );
  });

  it("leaves text with no placeholders alone", () => {
    expect(renderForRail("<p>Invoice INV-1001</p>", "bank")).toBe("<p>Invoice INV-1001</p>");
  });
});

describe("rail-prefixed paths", () => {
  it("splits a prefix off, and treats an unprefixed path as card", () => {
    expect(splitRailPath("/bank/attacks/x/invoice.html")).toEqual({
      rail: "bank",
      rest: "attacks/x/invoice.html",
    });
    expect(splitRailPath("/attacks/x/invoice.html")).toEqual({
      rail: "card",
      rest: "attacks/x/invoice.html",
    });
    // A bare rail id names no file, so there is nothing to strip.
    expect(splitRailPath("/bank")).toEqual({ rail: "card", rest: "bank" });
  });
});
