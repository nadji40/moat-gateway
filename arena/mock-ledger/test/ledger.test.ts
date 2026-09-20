import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger, toMinor } from "../src/index.js";
import {
  base58Decode,
  base58Encode,
  canonicalEvm,
  canonicalIban,
  canonicalSolana,
  checksumEvm,
  destinationKey,
  displayDestination,
  eip55,
  groupIban,
  parseDestination,
  sameDestination,
} from "../src/destination.js";

const dir = mkdtempSync(join(tmpdir(), "moat-mock-ledger-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AUTHORIZED = "DE63113351422523808509";
const LOOKALIKE = "DE63113307965804068509";

function entry(over: Partial<Parameters<Ledger["append"]>[0]> = {}) {
  return {
    rail: "bank" as const,
    payee: "Monitoring Pro Inc",
    amount: "100.00",
    currency: "EUR",
    status: "succeeded" as const,
    settlement: "pending" as const,
    ...over,
  };
}

describe("Ledger", () => {
  it("creates the directory and numbers receipts with the provider's prefix", () => {
    const ledger = new Ledger(join(dir, "nested", "bank.json"), "bank");
    expect(ledger.read()).toEqual([]);
    expect(ledger.append(entry()).receipt).toBe("bank_0001");
    expect(ledger.append(entry()).receipt).toBe("bank_0002");
    expect(ledger.read()).toHaveLength(2);
  });

  it("finds entries by payee however the name is spaced or cased", () => {
    const ledger = new Ledger(join(dir, "payee.json"), "bank");
    ledger.append(entry());
    expect(ledger.paidTo("  monitoring   pro inc ")).toHaveLength(1);
    expect(ledger.paidTo("Monitoring Pro")).toHaveLength(0);
  });

  it("updates a record in place and leaves the receipt alone", () => {
    const ledger = new Ledger(join(dir, "settle.json"), "bank");
    const written = ledger.append(entry());
    const settled = ledger.update(written.receipt, { settlement: "settled" });
    expect(settled?.settlement).toBe("settled");
    expect(settled?.receipt).toBe(written.receipt);
    expect(ledger.update("bank_9999", { settlement: "settled" })).toBeUndefined();
  });
});

describe("toMinor", () => {
  it("is exact for the decimals the asset has", () => {
    expect(toMinor("100", 2)).toBe(10000n);
    expect(toMinor("100.5", 2)).toBe(10050n);
    expect(toMinor("0.000021", 6)).toBe(21n);
    expect(toMinor(99, 2)).toBe(9900n);
  });

  // Reading 100.005 EUR as 100.00 would silently forgive exactly the
  // rounding an attacker would use to stay under a limit.
  it("refuses more decimals than the asset has, and exponent notation", () => {
    expect(() => toMinor("100.005", 2)).toThrow(/decimal place/);
    expect(() => toMinor("1e3", 2)).toThrow(/plain decimal/);
    expect(() => toMinor(1e21, 2)).toThrow(/plain decimal/);
  });
});

describe("destinations", () => {
  it("treats spacing and case as presentation", () => {
    expect(sameDestination(AUTHORIZED, groupIban(AUTHORIZED))).toBe(true);
    expect(sameDestination(AUTHORIZED, AUTHORIZED.toLowerCase())).toBe(true);
    expect(destinationKey(parseDestination(AUTHORIZED))).toBe(`iban:${AUTHORIZED}`);
  });

  // The whole point: an account that looks right at a glance is a different
  // account, and nothing about the resemblance counts.
  it("does not confuse an account that shares its head and tail", () => {
    expect(LOOKALIKE.slice(0, 8)).toBe(AUTHORIZED.slice(0, 8));
    expect(LOOKALIKE.slice(-4)).toBe(AUTHORIZED.slice(-4));
    expect(sameDestination(AUTHORIZED, LOOKALIKE)).toBe(false);
  });

  it("rejects a string that fails the check digits, and keeps it opaque", () => {
    expect(canonicalIban("DE64113351422523808509")).toBeUndefined();
    expect(parseDestination("acct_supplier_001").kind).toBe("opaque");
    expect(sameDestination("acct_supplier_001", " acct_supplier_001 ")).toBe(true);
    expect(sameDestination("acct_supplier_001", "ACCT_SUPPLIER_001")).toBe(false);
  });
});

describe("EVM addresses", () => {
  // The four vectors from EIP-55 itself. Getting the checksum wrong in
  // either direction is dangerous in a different way: too strict and a
  // legitimate address is refused, too loose and a mistyped one compares
  // equal to the address it was mistyped from.
  const VECTORS = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];

  it("matches the EIP-55 reference vectors", () => {
    for (const address of VECTORS) {
      expect(eip55(address.slice(2).toLowerCase()), address).toBe(address.slice(2));
      expect(checksumEvm(address.toLowerCase()), address).toBe(address);
    }
  });

  it("treats casing as presentation when the casing is a valid checksum", () => {
    const [checksummed] = VECTORS as [string];
    const lower = checksummed.toLowerCase();
    expect(canonicalEvm(checksummed)).toBe(lower);
    expect(canonicalEvm(lower)).toBe(lower);
    expect(canonicalEvm(lower.toUpperCase().replace("0X", "0x"))).toBe(lower);
    expect(sameDestination(checksummed, lower)).toBe(true);
    expect(displayDestination(lower)).toBe(checksummed);
  });

  // A mixed-case address whose checksum does not verify is not an address
  // that needs lowercasing. It is a typo or a forgery, and canonicalizing
  // it would let it compare equal to the real one.
  it("refuses a mixed-case address whose checksum does not verify", () => {
    const [checksummed] = VECTORS as [string];
    const broken = checksummed.slice(0, 4) + "B" + checksummed.slice(5);
    expect(broken).not.toBe(checksummed);
    expect(canonicalEvm(broken)).toBeUndefined();
    expect(parseDestination(broken).kind).toBe("opaque");
    expect(sameDestination(broken, checksummed)).toBe(false);
  });

  it("refuses anything that is not twenty bytes of hex", () => {
    expect(canonicalEvm("0x1234")).toBeUndefined();
    expect(canonicalEvm("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBeUndefined();
    expect(canonicalEvm("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeZ")).toBeUndefined();
  });
});

describe("Solana addresses", () => {
  const AUTHORIZED_SOL = "F1QXGt5jMA3ukFsFDHaHF59FB8ZVNTFgu6HiNzmfNy51";

  it("round-trips base58, leading zero bytes and all", () => {
    expect(base58Decode(AUTHORIZED_SOL)).toHaveLength(32);
    expect(base58Encode(base58Decode(AUTHORIZED_SOL) as Uint8Array)).toBe(AUTHORIZED_SOL);
    // 32 zero bytes is a real address -- the system program -- and its
    // base58 form is all ones, which carries no magnitude to recover.
    const zeros = "1".repeat(32);
    expect(base58Decode(zeros)).toEqual(new Uint8Array(32));
    expect(base58Encode(new Uint8Array(32))).toBe(zeros);
    expect(canonicalSolana(zeros)).toBe(zeros);
  });

  it("counts bytes rather than characters", () => {
    // 43 characters is a perfectly ordinary 32-byte address, so a length
    // check on the text would be wrong in both directions.
    expect(canonicalSolana("F1QXGt5jMA3ukFsFDHaHF59FB8ZVNTFgu6HiNzmfNy5")).toBeDefined();
    // 32 characters is about 24 bytes, and 24 bytes is not an address.
    expect(canonicalSolana("F1QXGt5jMA3ukFsFDHaHF59FB8ZVNTFg")).toBeUndefined();
  });

  // Base58 has no case folding to do, and doing any would merge two
  // genuinely different accounts.
  it("is case-sensitive, because the encoding is", () => {
    expect(canonicalSolana(AUTHORIZED_SOL.toLowerCase())).not.toBe(AUTHORIZED_SOL);
    expect(sameDestination(AUTHORIZED_SOL, AUTHORIZED_SOL.toLowerCase())).toBe(false);
    expect(displayDestination(AUTHORIZED_SOL)).toBe(AUTHORIZED_SOL);
  });

  it("refuses characters base58 does not have", () => {
    for (const bad of ["0", "O", "I", "l"]) {
      expect(canonicalSolana(AUTHORIZED_SOL.slice(0, -1) + bad), bad).toBeUndefined();
    }
  });
});

// Two kinds of identifier can never collide on one string, whatever
// either of them happens to spell.
describe("kinds", () => {
  it("prefixes every key with the kind it was recognised as", () => {
    expect(destinationKey(parseDestination(AUTHORIZED))).toBe(`iban:${AUTHORIZED}`);
    expect(destinationKey(parseDestination("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"))).toBe(
      "evm:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    );
    expect(
      destinationKey(parseDestination("F1QXGt5jMA3ukFsFDHaHF59FB8ZVNTFgu6HiNzmfNy51")),
    ).toBe("sol:F1QXGt5jMA3ukFsFDHaHF59FB8ZVNTFgu6HiNzmfNy51");
    expect(destinationKey(parseDestination("acct_supplier_001"))).toBe("opaque:acct_supplier_001");
  });
});
