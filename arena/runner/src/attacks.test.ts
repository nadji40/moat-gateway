import { describe, expect, it } from "vitest";
import { ARENA_ROOT } from "./context.js";
import { loadAttacks } from "./attacks.js";

describe("attack corpus authorizations", () => {
  it("carries trusted payment authority for every attack", () => {
    const attacks = loadAttacks(ARENA_ROOT);
    expect(attacks).toHaveLength(10);
    expect(attacks.every((attack) => attack.authorization.amount > 0)).toBe(true);
  });

  it("models the under-cap inflation as a 99 USD authorization", () => {
    const attack = loadAttacks(ARENA_ROOT).find((candidate) => candidate.id === "inflate-under-cap");
    expect(attack?.authorization).toMatchObject({
      payee: "Monitoring Pro Inc",
      amount: 99,
      tolerance: 5,
      currency: "USD",
      repeat_payments: false,
      max_payments: 1,
    });
    expect(attack?.injection.calls[0]?.amount).toBe(499);
  });
});
