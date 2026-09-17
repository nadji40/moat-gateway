import { describe, expect, it } from "vitest";
import { majorToMinor, recipientFor, recipientsFromEnv } from "../src/stripe.js";

const env = {
  STRIPE_AUTHORIZED_SECRET_KEY: "sk_test_authorized",
  STRIPE_UNAUTHORIZED_SECRET_KEY: "sk_test_unauthorized",
  STRIPE_AUTHORIZED_PAYEE: "Monitoring Pro Inc",
  STRIPE_UNAUTHORIZED_PAYEE: "ProMon Billing Ltd",
};

describe("Stripe sandbox routing", () => {
  it("routes exact configured payees after harmless whitespace and case normalization", () => {
    const recipients = recipientsFromEnv(env);
    expect(recipientFor("  monitoring   pro INC  ", recipients).role).toBe("authorized");
    expect(recipientFor("promon billing ltd", recipients).role).toBe("unauthorized");
  });

  it("rejects unknown payees instead of guessing an account", () => {
    expect(() => recipientFor("Unknown Merchant", recipientsFromEnv(env))).toThrow(
      "unknown sandbox payee",
    );
  });

  it("converts major units without silently rounding unsupported precision", () => {
    expect(majorToMinor(4.8, "USD")).toBe(480);
    expect(majorToMinor(500, "JPY")).toBe(500);
    expect(() => majorToMinor(4.801, "USD")).toThrow("more decimal places");
  });
});
