// The rail registry, and the promise that routing through it leaves the card
// rail exactly where it was.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARENA_ROOT, configFor, endpointsFor, policyFor } from "../src/context.js";
import {
  DEFAULT_RAIL,
  implementedRails,
  namespacedPayTool,
  parseRails,
  railSpec,
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
  });

  it("names what exists rather than failing vaguely", () => {
    expect(() => parseRails("sepa")).toThrow(/unknown rail sepa; have card/);
    expect(() => railSpec("bank")).toThrow(/rail bank has no implementation yet; have card/);
    expect(implementedRails()).toEqual(["card"]);
  });

  it("describes the card rail the way the gateway configs do", () => {
    const card = railSpec("card");
    expect(card.family).toBe("card");
    expect(card.upstream).toBe("stripe");
    expect(card.tools.pay).toBe("pay");
    expect(namespacedPayTool(card)).toBe("stripe__pay");
    expect(card.mock.ledgerEnv).toBe("MOCK_STRIPE_LEDGER");
  });

  it("points every arm at a gateway config and policy that exist on disk", () => {
    for (const arm of ["cap", "allowlist", "moat"] as const) {
      const config = join(ARENA_ROOT, configFor(arm, "card"));
      expect(existsSync(config), `${config} missing`).toBe(true);
      expect(existsSync(policyFor(arm, "card")), `policy for ${arm} missing`).toBe(true);
    }
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
