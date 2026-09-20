// Compiling and deploying the wallet the chain enforces, and reading it.
//
// Kept apart from evm.ts because this is a different claim. That file
// demonstrates Moat in front of an ordinary wallet, which an agent holding
// the key can walk around. This one puts the funds somewhere the key alone
// cannot reach: MoatGuardedWallet executes a payment only against an
// EIP-712 signature from Moat's co-signing key over that exact payment.
// ADR 0010 has the reasoning.
//
// The contract is compiled from source here rather than shipped as
// bytecode, so that what is deployed is what is in the repository and
// anyone can check it by running this.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Address, Hex } from "viem";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(PACKAGE_ROOT, "contracts", "MoatGuardedWallet.sol");

/** The ABI, written out rather than derived, so callers get types. */
export const GUARD_ABI = [
  {
    type: "constructor",
    stateMutability: "payable",
    inputs: [{ name: "moat_", type: "address" }],
  },
  { type: "receive", stateMutability: "payable" },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "moat",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "spent",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "digest",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
      { name: "evidenceId", type: "bytes32" },
      { name: "expiry", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
      { name: "evidenceId", type: "bytes32" },
      { name: "expiry", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Executed",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
      { name: "evidenceId", type: "bytes32", indexed: true },
    ],
  },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "AlreadySpent", inputs: [] },
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
] as const;

/** The zero address, which the contract reads as "native value". */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export interface Compiled {
  readonly bytecode: Hex;
  readonly compiler: string;
}

/**
 * Compile the contract with the pinned solc.
 *
 * Optimiser off and no metadata games: the point is reproducibility for a
 * reader, not the last hundred gas.
 */
export function compileGuard(): Compiled {
  // solc is CommonJS and loads its own wasm; require it rather than fight
  // the ESM wrapper.
  const require = createRequire(import.meta.url);
  const solc = require("solc") as {
    version(): string;
    compile(input: string): string;
  };
  const source = readFileSync(SOURCE, "utf8");
  const input = {
    language: "Solidity",
    sources: { "MoatGuardedWallet.sol": { content: source } },
    settings: {
      optimizer: { enabled: false },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts?: Record<string, Record<string, { evm: { bytecode: { object: string } } }>>;
  };
  const fatal = (output.errors ?? []).filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    throw new Error(`the contract did not compile:\n${fatal.map((e) => e.formattedMessage).join("\n")}`);
  }
  const object = output.contracts?.["MoatGuardedWallet.sol"]?.["MoatGuardedWallet"]?.evm.bytecode
    .object;
  if (!object) throw new Error("solc produced no bytecode for MoatGuardedWallet");
  return { bytecode: `0x${object}`, compiler: solc.version() };
}

/** Which revert the contract chose, by selector, for a readable failure. */
export function guardError(error: unknown): string | undefined {
  const text = error instanceof Error ? `${error.message}\n${String(error)}` : String(error);
  for (const name of ["NotOwner", "Expired", "AlreadySpent", "BadSignature", "TransferFailed"]) {
    if (text.includes(name)) return name;
  }
  return undefined;
}
