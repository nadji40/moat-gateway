// Pure tests: no cluster, no keys beyond generated ones, no secrets.
// Everything here is about what the adapter must get right on its own,
// before any network is involved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bs58Encode,
  checkAmount,
  decodeSecret,
  fromBaseUnits,
  moatMemo,
  SentLedger,
  SOL_DECIMALS,
  toBaseUnits,
} from "../src/solana.js";

const dir = mkdtempSync(join(tmpdir(), "moat-solana-devnet-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("amounts", () => {
  /// The unit-confusion attack, at the library boundary. A rounding
  /// library turns an instruction the chain cannot carry out into one it
  /// can, which is the whole thing Moat is trying to catch.
  it("refuses more decimal places than the asset has, rather than rounding", () => {
    expect(() => checkAmount("0.0000000001", SOL_DECIMALS)).toThrow(/decimal places/);
    expect(() => checkAmount("1.5", 0)).toThrow(/decimal places/);
    expect(() => checkAmount("0.123456789", SOL_DECIMALS)).not.toThrow();
  });

  it("refuses anything that is not a plain positive decimal", () => {
    for (const bad of ["1e9", "-1", "", " ", "0", "abc", "1,5"]) {
      expect(() => checkAmount(bad, SOL_DECIMALS), bad).toThrow();
    }
  });

  it("converts to lamports exactly, without floating point", () => {
    expect(toBaseUnits("1", SOL_DECIMALS)).toBe(1_000_000_000n);
    expect(toBaseUnits("0.000000001", SOL_DECIMALS)).toBe(1n);
    // 0.1 + 0.2 territory: the value a float would get wrong.
    expect(toBaseUnits("0.3", SOL_DECIMALS)).toBe(300_000_000n);
    expect(toBaseUnits("123.456789012", SOL_DECIMALS)).toBe(123_456_789_012n);
  });

  it("round-trips", () => {
    for (const amount of ["1", "0.000000001", "0.3", "123.456789012", "1000"]) {
      expect(fromBaseUnits(toBaseUnits(amount, SOL_DECIMALS), SOL_DECIMALS)).toBe(amount);
    }
  });
});

describe("the signed-transaction ledger", () => {
  /// One payment, one key. If this ever depended on a clock or a counter,
  /// a retry would compute a different key, miss the stored bytes and
  /// sign a second transaction.
  it("keys on what identifies the payment and nothing else", () => {
    const a = SentLedger.key("sender", "auth-1", "INV-1");
    expect(SentLedger.key("sender", "auth-1", "INV-1")).toBe(a);
    expect(SentLedger.key("sender", "auth-1", "INV-2")).not.toBe(a);
    expect(SentLedger.key("sender", "auth-2", "INV-1")).not.toBe(a);
    expect(SentLedger.key("other", "auth-1", "INV-1")).not.toBe(a);
  });

  it("cannot be collided by moving a character between fields", () => {
    expect(SentLedger.key("s", "ab", "c")).not.toBe(SentLedger.key("s", "a", "bc"));
  });

  it("stores and finds what it signed", () => {
    const ledger = new SentLedger(join(dir, "ledger"));
    const record = {
      signature: "sig1",
      to: "dest",
      amount: "0.001",
      asset: "SOL",
      network: "solana:devnet",
      authorization_id: "auth-1",
      invoice_id: "INV-1",
      raw: "AQID",
      broadcast: true,
      at: new Date().toISOString(),
    };
    const key = SentLedger.key("sender", "auth-1", "INV-1");
    ledger.put(key, record);
    expect(ledger.get(key)).toEqual(record);
    expect(ledger.forAuthorization("auth-1")).toHaveLength(1);
    expect(ledger.forAuthorization("auth-2")).toHaveLength(0);
  });
});

describe("secret keys", () => {
  it("reads both the JSON array and the base64 forms", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
    expect(decodeSecret(JSON.stringify([...bytes]))).toEqual(bytes);
    expect(decodeSecret(Buffer.from(bytes).toString("base64"))).toEqual(bytes);
  });

  it("refuses anything that is not 64 bytes", () => {
    expect(() => decodeSecret(Buffer.from([1, 2, 3]).toString("base64"))).toThrow(/64 bytes/);
  });
});

describe("the memo", () => {
  it("carries the identifiers that let a chain entry be matched to a verdict", () => {
    expect(moatMemo("auth-1", "INV-1")).toBe("moat:auth=auth-1;inv=INV-1");
    expect(moatMemo("auth-1", undefined)).toBe("moat:auth=auth-1");
    expect(moatMemo(undefined, undefined)).toBeUndefined();
  });
});

describe("base58", () => {
  /// A signature printed wrong is a signature nobody can look up, which
  /// makes the whole reconciliation story unverifiable.
  it("encodes the way Solana does, leading zeroes included", () => {
    expect(bs58Encode(Uint8Array.from([0]))).toBe("1");
    expect(bs58Encode(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(bs58Encode(Uint8Array.from([255]))).toBe("5Q");
    // The system program's address is 32 zero bytes.
    expect(bs58Encode(new Uint8Array(32))).toBe("1".repeat(32));
  });
});
