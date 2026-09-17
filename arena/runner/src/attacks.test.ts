import { describe, expect, it } from "vitest";
import { ARENA_ROOT } from "./context.js";
import { loadAttacks, loadControls, metadataForScenario } from "./attacks.js";

describe("attack corpus authorizations", () => {
  it("carries trusted payment authority for every attack", () => {
    const attacks = loadAttacks(ARENA_ROOT);
    expect(attacks).toHaveLength(16);
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

  it("loads legitimate controls separately from hostile scenarios", () => {
    const controls = loadControls(ARENA_ROOT);
    expect(controls).toHaveLength(5);
    expect(controls.every((control) => control.kind === "control")).toBe(true);
  });

  it("models missing and substituted payment metadata explicitly", () => {
    const attacks = loadAttacks(ARENA_ROOT);
    const registered = { authorization_id: "auth-real", invoice_id: "inv-real" };
    const omitted = attacks.find((candidate) => candidate.id === "omit-authorization-id")!;
    const substituted = attacks.find((candidate) => candidate.id === "substitute-invoice-id")!;
    expect(metadataForScenario(omitted, registered)).toBeUndefined();
    expect(metadataForScenario(substituted, registered)).toEqual({
      authorization_id: "auth-real",
      invoice_id: "tampered-substitute-invoice-id",
    });
  });
});
