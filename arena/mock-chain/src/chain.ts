// What differs between the two chain families the arena runs.
//
// One mock serves both, selected by MOCK_CHAIN, because everything that
// matters to the measurement is the same on each: an address is the
// payment, a transfer is final once it confirms, and the name beside the
// address is not checked by anything. What differs is the shape of an
// address, the shape of a signature, the native asset, and what a network
// is called.

import { createHash } from "node:crypto";
import {
  base58Encode,
  canonicalEvm,
  canonicalSolana,
  checksumEvm,
} from "@moat/mock-ledger/destination";

/** The two chain families. */
export type ChainFamily = "evm" | "solana";

/** An asset that can be moved on a chain, and how finely it divides. */
export interface ChainAsset {
  readonly symbol: string;
  readonly decimals: number;
  /** Whether it is the chain's own coin rather than a contract token. */
  readonly native: boolean;
}

export interface ChainSpec {
  readonly family: ChainFamily;
  /** CAIP-2 style identifier of the network this sandbox pretends to be. */
  readonly defaultNetwork: string;
  /** Networks the mock will accept an instruction for. */
  readonly networks: readonly string[];
  readonly assets: readonly ChainAsset[];
  /** Whether this family has a token-allowance mechanism to abuse. */
  readonly hasApprovals: boolean;
  /** True when `raw` is a well-formed address for this family. */
  valid(raw: string): boolean;
  /** The comparison form of an address, or undefined if it is not one. */
  canonical(raw: string): string | undefined;
  /** The address as a person would be shown it. */
  display(canonical: string): string;
  /** A transaction identifier of the right shape, derived from `seed`. */
  txId(seed: string): string;
}

const EVM: ChainSpec = {
  family: "evm",
  // Base Sepolia, the testnet the real adapter targets.
  defaultNetwork: "eip155:84532",
  networks: ["eip155:84532", "eip155:1", "eip155:8453", "eip155:11155111"],
  assets: [
    { symbol: "USDC", decimals: 6, native: false },
    { symbol: "ETH", decimals: 18, native: true },
  ],
  hasApprovals: true,
  valid: (raw) => canonicalEvm(raw) !== undefined,
  canonical: canonicalEvm,
  display: (canonical) => checksumEvm(canonical) ?? canonical,
  txId: (seed) => `0x${createHash("sha256").update(`evm:${seed}`).digest("hex")}`,
};

const SOLANA: ChainSpec = {
  family: "solana",
  defaultNetwork: "solana:devnet",
  networks: ["solana:devnet", "solana:mainnet", "solana:testnet"],
  assets: [
    { symbol: "USDC", decimals: 6, native: false },
    { symbol: "SOL", decimals: 9, native: true },
  ],
  hasApprovals: false,
  valid: (raw) => canonicalSolana(raw) !== undefined,
  canonical: canonicalSolana,
  // Base58 is case-sensitive, so the canonical form is already the only
  // spelling there is. Nothing to prettify.
  display: (canonical) => canonical,
  txId: (seed) => {
    // A signature is 64 bytes. Two rounds of SHA-256 give exactly that, and
    // the result base58-encodes to the length a real one has.
    const a = createHash("sha256").update(`sol:a:${seed}`).digest();
    const b = createHash("sha256").update(`sol:b:${seed}`).digest();
    return base58Encode(Uint8Array.from(Buffer.concat([a, b])));
  },
};

const CHAINS: Record<ChainFamily, ChainSpec> = { evm: EVM, solana: SOLANA };

/** The chain this process is pretending to be. */
export function chainFromEnv(value: string | undefined): ChainSpec {
  const name = (value ?? "evm").trim().toLowerCase();
  const spec = CHAINS[name as ChainFamily];
  if (!spec) {
    throw new Error(`MOCK_CHAIN=${name} is not a chain; use ${Object.keys(CHAINS).join(" or ")}`);
  }
  return spec;
}

/** The asset `symbol` names on this chain, if it is one. */
export function assetOf(spec: ChainSpec, symbol: string): ChainAsset | undefined {
  const want = symbol.trim().toUpperCase();
  return spec.assets.find((a) => a.symbol === want);
}

/**
 * An amount this chain can actually represent.
 *
 * A chain holds integers of the smallest unit and nothing else, so an
 * amount with more decimal places than the asset has is not a small amount:
 * it is an instruction the chain cannot carry out. Rounding it here would
 * hide exactly the unit confusion the arena exists to expose, so it is
 * refused, by the provider, before any control layer is involved.
 */
export function checkAmount(asset: ChainAsset, amount: string): string | undefined {
  const text = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return `${amount} is not a plain decimal amount`;
  const fraction = text.includes(".") ? (text.split(".")[1] ?? "") : "";
  if (fraction.length > asset.decimals) {
    return `${text} has ${fraction.length} decimal places but ${asset.symbol} has ${asset.decimals}`;
  }
  if (/^0+(\.0*)?$/.test(text)) return "amount must be greater than zero";
  return undefined;
}
