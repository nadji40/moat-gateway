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
  it("defines every placeholder for every rail that has any", () => {
    const keys = Object.keys(substitutions("card")).sort();
    for (const rail of railsWithFixtures()) {
      expect(Object.keys(substitutions(rail)).sort(), rail).toEqual(keys);
      for (const [key, value] of Object.entries(substitutions(rail))) {
        expect(value, `${rail}.${key}`).not.toBe("");
      }
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
    expect(railsWithFixtures()).toEqual(["bank", "card"]);
    expect(isRail("bank")).toBe(true);
    expect(isRail("sepa")).toBe(false);
    expect(() => fixturesFor("evm")).toThrow(/no entry for evm/);
  });
});

describe("rendering", () => {
  it("substitutes what it knows and refuses what it does not", () => {
    expect(renderForRail("{{rail.asset}} {{ rail.id }}", "bank")).toBe("EUR bank");
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
