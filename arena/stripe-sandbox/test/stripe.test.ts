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

  it("lets one account answer to several supplier names", () => {
    const recipients = recipientsFromEnv({
      ...env,
      STRIPE_AUTHORIZED_PAYEE: "Monitoring Pro Inc|Al Noor Supplies",
    });
    expect(recipientFor("Al Noor Supplies", recipients).role).toBe("authorized");
    expect(recipientFor("monitoring pro inc", recipients).role).toBe("authorized");
    expect(recipients[0]!.payee).toBe("Monitoring Pro Inc");
    expect(() => recipientFor("Al Noor Supplies.", recipients)).toThrow("Al Noor Supplies");
    expect(() =>
      recipientsFromEnv({ ...env, STRIPE_UNAUTHORIZED_PAYEE: "ProMon Billing Ltd|Al Noor Supplies", STRIPE_AUTHORIZED_PAYEE: "Al Noor Supplies" }),
    ).toThrow("more than one account");
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
