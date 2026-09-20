// Pure tests: no gateway, no network, no secrets. Everything here is about
// the two things the adapter must not get wrong on its own -- which
// requests are the same payment, and what the bank says a name check said.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configFromEnv, matchNames, ReferenceBank } from "../src/providers/reference.js";
import { idempotencyKey } from "../src/idempotency.js";

const dir = mkdtempSync(join(tmpdir(), "moat-bank-adapter-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function bankIn(name: string, overrides: Record<string, string> = {}) {
  const stateDir = join(dir, name);
  const config = { ...configFromEnv({ ...overrides } as NodeJS.ProcessEnv), stateDir };
  return new ReferenceBank(config);
}

const SUPPLIER = "DE89370400440532013000";
const RETURNING = "GB33BUKB20201555555555";

describe("the idempotency key", () => {
  it("is the same for the same payment and different for every other", () => {
    const base = idempotencyKey(SUPPLIER, "auth-1", "INV-1");
    expect(idempotencyKey(SUPPLIER, "auth-1", "INV-1")).toBe(base);
    expect(idempotencyKey(SUPPLIER, "auth-1", "INV-2")).not.toBe(base);
    expect(idempotencyKey(SUPPLIER, "auth-2", "INV-1")).not.toBe(base);
    expect(idempotencyKey(RETURNING, "auth-1", "INV-1")).not.toBe(base);
  });

  it("does not depend on how the IBAN was capitalised", () => {
    expect(idempotencyKey(SUPPLIER.toLowerCase(), "a", "i")).toBe(
      idempotencyKey(SUPPLIER, "a", "i"),
    );
  });

  /// Without a separator, ("ab","c") and ("a","bc") are one key, and two
  /// different payments would collapse into one transfer.
  it("cannot be collided by moving a character between fields", () => {
    expect(idempotencyKey(SUPPLIER, "ab", "c")).not.toBe(idempotencyKey(SUPPLIER, "a", "bc"));
  });
});

describe("confirmation of payee", () => {
  it("calls an exact name a match, ignoring the company suffix", () => {
    expect(matchNames("Monitoring Pro Inc", "Monitoring Pro")).toBe("match");
    expect(matchNames("Monitoring Pro Inc", "monitoring  pro   inc")).toBe("match");
  });

  /// The whole point of the close band. A lookalike supplier is exactly a
  /// near miss, and rounding near up to match would hand the attacker the
  /// answer they were fishing for.
  it("calls a near miss a close match and not a match", () => {
    expect(matchNames("Monitoring Pro Inc", "Monitoring Pr0 Inc")).toBe("close_match");
  });

  it("calls a different company no match", () => {
    expect(matchNames("Monitoring Pro Inc", "Nordwind Handels GmbH")).toBe("no_match");
  });
});

describe("the reference bank", () => {
  it("refuses an account the institution cannot reach", async () => {
    const bank = bankIn("unknown");
    await expect(
      bank.createTransfer(
        {
          beneficiaryName: "Someone",
          iban: "NL91ABNA0417164300",
          amount: "10.00",
          currency: "EUR",
          reference: "INV-X",
        },
        "k1",
      ),
    ).rejects.toThrow(/no account/);
  });

  it("refuses an IBAN that fails mod-97", async () => {
    const bank = bankIn("badiban");
    await expect(
      bank.createTransfer(
        {
          beneficiaryName: "Someone",
          iban: "DE89370400440532013001",
          amount: "10.00",
          currency: "EUR",
          reference: "INV-X",
        },
        "k1",
      ),
    ).rejects.toThrow(/not a valid IBAN/);
  });

  /// A rail carrying two decimal places cannot carry three, and rounding
  /// silently is how a unit confusion becomes a payment.
  it("refuses an amount with more precision than the rail has", async () => {
    const bank = bankIn("precision");
    await expect(
      bank.createTransfer(
        {
          beneficiaryName: "Monitoring Pro Inc",
          iban: SUPPLIER,
          amount: "10.005",
          currency: "EUR",
          reference: "INV-X",
        },
        "k1",
      ),
    ).rejects.toThrow(/not an amount/);
  });

  it("treats two requests under one key as one transfer", async () => {
    const bank = bankIn("idempotent");
    const request = {
      beneficiaryName: "Monitoring Pro Inc",
      iban: SUPPLIER,
      amount: "10.00",
      currency: "EUR",
      reference: "INV-1",
    };
    const first = await bank.createTransfer(request, "same-key");
    const second = await bank.createTransfer(request, "same-key");
    expect(second.reference).toBe(first.reference);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(await bank.listTransfers()).toHaveLength(1);
  });

  it("accepts before it settles", async () => {
    const bank = bankIn("async", { MOAT_BANK_SUBMIT_MS: "50", MOAT_BANK_SETTLE_MS: "10000" });
    const result = await bank.createTransfer(
      {
        beneficiaryName: "Monitoring Pro Inc",
        iban: SUPPLIER,
        amount: "10.00",
        currency: "EUR",
        reference: "INV-1",
      },
      "k",
    );
    expect(result.state).toBe("pending");
    expect((await bank.getTransfer(result.reference)).state).not.toBe("settled");
  });

  /// The state a card never reaches. Everything downstream of it -- the
  /// mandate releasing, a replacement being allowed -- depends on the
  /// provider being able to say it at all.
  it("settles a returning account and then takes it back", async () => {
    const bank = bankIn("returns", {
      MOAT_BANK_SUBMIT_MS: "0",
      MOAT_BANK_SETTLE_MS: "0",
      MOAT_BANK_RETURN_MS: "0",
    });
    const result = await bank.createTransfer(
      {
        beneficiaryName: "Closed Account Ltd",
        iban: RETURNING,
        amount: "10.00",
        currency: "EUR",
        reference: "INV-1",
      },
      "k",
    );
    const status = await bank.getTransfer(result.reference);
    expect(status.state).toBe("returned");
    expect(status.reasonCode).toBe("AC04");
    expect(status.returnedAt).toBeTruthy();
  });

  it("reports a name that is not the name on the account", async () => {
    const bank = bankIn("cop");
    expect((await bank.verifyPayee(SUPPLIER, "Monitoring Pro Inc")).match).toBe("match");
    expect((await bank.verifyPayee(SUPPLIER, "Nordwind Handels GmbH")).match).toBe("no_match");
  });
});
