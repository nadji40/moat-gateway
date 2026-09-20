// Everything that can be checked without a network or a key. The chain
// itself is exercised by the smoke script, gated and paid for in testnet
// ether; nothing here touches it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  assetsOf,
  CHAIN,
  checkAmount,
  configFromEnv,
  NETWORK,
  SentLedger,
  toBaseUnits,
} from "../src/evm.js";

const dir = mkdtempSync(join(tmpdir(), "moat-evm-testnet-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A throwaway key that has never held anything anywhere.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SENDER = privateKeyToAccount(KEY).address;

const env = {
  MOAT_EVM_PRIVATE_KEY: KEY,
  MOAT_EVM_AUTHORIZED_ADDRESS: "0x864cc95dcD3a5d88401CB951b670874a17092302",
  MOAT_EVM_UNAUTHORIZED_ADDRESS: "0x6F0e2d1Cf744BB115e14BDdED63d2561A55b8ce0",
  MOAT_EVM_STATE_DIR: dir,
};

describe("configuration", () => {
  it("names the one chain it knows, and refuses to be told otherwise", () => {
    expect(CHAIN.id).toBe(84532);
    expect(NETWORK).toBe("eip155:84532");
    const config = configFromEnv(env);
    expect(config.rpcUrl).toBe(CHAIN.rpcUrls.default.http[0]);
    expect(config.authorized.payee).toBe("Monitoring Pro Inc");
    expect(config.confirmations).toBe(1);
    expect(config.maxSendEther).toBe("0.001");
  });

  it("checksums the addresses it is given and refuses ones that are not addresses", () => {
    const config = configFromEnv({
      ...env,
      MOAT_EVM_AUTHORIZED_ADDRESS: "0x864cc95dcd3a5d88401cb951b670874a17092302",
    });
    expect(config.authorized.address).toBe("0x864cc95dcD3a5d88401CB951b670874a17092302");
    expect(() => configFromEnv({ ...env, MOAT_EVM_AUTHORIZED_ADDRESS: "0x1234" })).toThrow(
      /not an EVM address/,
    );
  });

  it("refuses a key of the wrong shape, and two parties at one address", () => {
    expect(() => configFromEnv({ ...env, MOAT_EVM_PRIVATE_KEY: "abc" })).toThrow(/64 hex/);
    expect(() =>
      configFromEnv({ ...env, MOAT_EVM_UNAUTHORIZED_ADDRESS: env.MOAT_EVM_AUTHORIZED_ADDRESS }),
    ).toThrow(/must differ/);
  });

  it("holds only ether until a token is configured", () => {
    expect(assetsOf(configFromEnv(env)).map((a) => a.symbol)).toEqual(["ETH"]);
    const withToken = configFromEnv({
      ...env,
      MOAT_EVM_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      MOAT_EVM_TOKEN_SYMBOL: "usdc",
    });
    expect(assetsOf(withToken)).toEqual([
      { symbol: "ETH", decimals: 18 },
      {
        symbol: "USDC",
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
      },
    ]);
  });
});

describe("amounts", () => {
  it("converts exactly at eighteen decimals", () => {
    expect(toBaseUnits("0.0001", 18)).toBe(100_000_000_000_000n);
    expect(toBaseUnits("1", 18)).toBe(1_000_000_000_000_000_000n);
    expect(toBaseUnits("0.000000000000000021", 18)).toBe(21n);
    expect(toBaseUnits("250.5", 6)).toBe(250_500_000n);
  });

  // The rule that makes the base-unit attack fail at the wallet as well as
  // at Moat: nothing is rounded, ever.
  it("refuses more precision than the asset has, and anything that is not a plain decimal", () => {
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(/7 decimal places but the asset has 6/);
    expect(() => toBaseUnits("1e3", 18)).toThrow(/not a plain decimal/);
    expect(() => toBaseUnits("-1", 18)).toThrow(/not a plain decimal/);
    expect(() => toBaseUnits("0", 18)).toThrow(/greater than zero/);
    expect(checkAmount(250, 6)).toBe("250");
  });
});

describe("the idempotency map", () => {
  const ledger = new SentLedger(dir);
  const record = {
    hash: "0x" + "ab".repeat(32),
    raw: "0x02f8" as const,
    to: "0x864cc95dcD3a5d88401CB951b670874a17092302" as const,
    amount: "0.0001",
    asset: "ETH",
    network: NETWORK,
    authorization_id: "auth-1",
    invoice_id: "INV-1",
    broadcast: false,
    at: new Date().toISOString(),
  } as const;

  it("keys on sender, authorization and invoice, and nothing else", () => {
    const a = SentLedger.key(SENDER, "auth-1", "INV-1");
    expect(SentLedger.key(SENDER, "auth-1", "INV-1")).toBe(a);
    expect(SentLedger.key(SENDER, "auth-1", "INV-2")).not.toBe(a);
    expect(SentLedger.key(SENDER, "auth-2", "INV-1")).not.toBe(a);
    // Case of the address is presentation; the key is the same account.
    expect(SentLedger.key(SENDER.toLowerCase() as typeof SENDER, "auth-1", "INV-1")).toBe(a);
  });

  it("remembers what was signed, and finds it again by authorization", () => {
    const key = SentLedger.key(SENDER, "auth-1", "INV-1");
    expect(ledger.get(key)).toBeUndefined();
    ledger.put(key, { ...record, hash: record.hash as `0x${string}` });
    expect(ledger.get(key)?.hash).toBe(record.hash);
    expect(ledger.get(key)?.broadcast).toBe(false);
    ledger.put(key, { ...record, hash: record.hash as `0x${string}`, broadcast: true });
    expect(ledger.get(key)?.broadcast).toBe(true);
    expect(ledger.forAuthorization("auth-1")).toHaveLength(1);
    expect(ledger.forAuthorization("auth-9")).toHaveLength(0);
  });
});
