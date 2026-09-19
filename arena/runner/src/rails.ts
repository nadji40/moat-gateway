// The rails the arena can measure, and everything that differs between them.
//
// A rail is how the money leaves: a card through a provider, a bank transfer
// to an account, an on-chain transfer to an address. Moat asks the same
// question on all of them — did this destination come from the user, or from
// a page the agent read? — so the same scenarios should run against each and
// the tables should be comparable.
//
// Everything rail-specific belongs in one RailSpec. Adding a rail is then an
// entry here plus a mock package, rather than edits scattered through the
// runner. The registry ships with `card` alone; `bank`, `evm` and `solana`
// are named in the type because the shape is designed for them, and adding
// one is a new entry, not a reshape.

import { join } from "node:path";
import type { Arm } from "./results.js";

/** A rail the arena can run scenarios against. */
export type Rail = "card" | "bank" | "evm" | "solana";

/** Rails that share settlement semantics. `evm` and `solana` are both crypto. */
export type RailFamily = "card" | "bank" | "crypto";

/** Everything the runner needs to know that differs between rails. */
export interface RailSpec {
  /** Identifier used on the command line, in result rows and in manifests. */
  readonly id: Rail;
  /** Which settlement family this rail belongs to. */
  readonly family: RailFamily;
  /**
   * Upstream name in the gateway configs, which is also the tool namespace
   * prefix: upstream `stripe` plus tool `pay` is `stripe__pay`.
   */
  readonly upstream: string;
  /** The mock server the `none` arm talks to with nothing in between. */
  readonly mock: {
    /** Entry script, relative to the arena root. */
    readonly entry: readonly string[];
    /** Environment variable that tells the mock where to write its ledger. */
    readonly ledgerEnv: string;
  };
  /** Bare tool names, before the gateway namespaces them. */
  readonly tools: {
    /** The tool that moves money. */
    readonly pay: string;
  };
  /** Gateway config per gateway arm, relative to the arena root. */
  readonly configs: Readonly<Record<Exclude<Arm, "none">, string>>;
}

const CARD: RailSpec = {
  id: "card",
  family: "card",
  upstream: "stripe",
  mock: {
    entry: ["mock-stripe", "src", "server.ts"],
    ledgerEnv: "MOCK_STRIPE_LEDGER",
  },
  tools: { pay: "pay" },
  configs: {
    cap: "moat.arena-cap.yaml",
    allowlist: "moat.arena-allowlist.yaml",
    moat: "moat.arena.yaml",
  },
};

/** Every rail the arena can run today. */
export const RAILS: Readonly<Partial<Record<Rail, RailSpec>>> = { card: CARD };

/** The rail a run uses when none is named. */
export const DEFAULT_RAIL: Rail = "card";

/** Rails that have an implementation, in a stable order. */
export function implementedRails(): Rail[] {
  return (Object.keys(RAILS) as Rail[]).slice().sort();
}

/** The spec for `id`, or a readable error naming what does exist. */
export function railSpec(id: Rail): RailSpec {
  const spec = RAILS[id];
  if (!spec) {
    throw new Error(`rail ${id} has no implementation yet; have ${implementedRails().join(", ")}`);
  }
  return spec;
}

/**
 * Parse a `--rails` argument. Empty or absent means the default rail, so a
 * command written before rails existed keeps meaning what it meant.
 */
export function parseRails(arg?: string): Rail[] {
  const raw = (arg ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  if (raw.length === 0) return [DEFAULT_RAIL];
  const out: Rail[] = [];
  for (const token of raw) {
    const spec = RAILS[token as Rail];
    if (!spec) {
      throw new Error(`unknown rail ${token}; have ${implementedRails().join(", ")}`);
    }
    if (!out.includes(spec.id)) out.push(spec.id);
  }
  return out;
}

/** Absolute path to a rail's mock server entry script. */
export function mockEntry(arenaRoot: string, spec: RailSpec): string {
  return join(arenaRoot, ...spec.mock.entry);
}

/** The namespaced tool name a gateway arm exposes for this rail's payment tool. */
export function namespacedPayTool(spec: RailSpec): string {
  return `${spec.upstream}__${spec.tools.pay}`;
}
