// The rails the arena can measure, and everything that differs between them.
//
// A rail is how the money leaves: a card through a provider, a bank transfer
// to an account, an on-chain transfer to an address. Moat asks the same
// question on all of them -- did this destination come from the user, or
// from a page the agent read? -- so the same scenarios run against each and
// the tables are comparable.
//
// Everything rail-specific belongs in one RailSpec. Adding a rail is then an
// entry here plus a mock package, rather than edits scattered through the
// runner.
//
// A scenario is written once, in canonical terms: a payee, an amount, a
// currency, sometimes an account. `attacks.ts` expands it onto a rail; this
// file is what it reads to do so. Expansion does three things and nothing
// else.
//
//   Values come from the rail's fixtures. `{{rail.asset}}` is USD on a card
//   and EUR on a bank transfer; `{{rail.attacker.destination}}` is a
//   provider account id or an IBAN.
//
//   Argument names come from the rail's tool. The scenario says `payee`;
//   the bank's transfer tool calls it `beneficiary_name`. Renaming here is
//   what lets one attack corpus drive several providers.
//
//   A destination is supplied when the rail needs one and the scenario did
//   not name one. A card payment names a merchant; a transfer has to name
//   an account, so an attack that is not about the account still sends the
//   right one.
//
// The card fixtures are the literals the card scenarios have always used,
// so expanding a scenario onto the card rail leaves it exactly as written.

import { join } from "node:path";
import {
  fixturesFor,
  renderForRail as renderWithFixtures,
  type Rail,
  type RailFixtures,
} from "@moat/arena-rails";
import { toMinor } from "@moat/mock-ledger";
import { sameDestination } from "@moat/mock-ledger/destination";
import type { Arm } from "./results.js";

export type { DestinationFixture, Rail, RailFixtures } from "@moat/arena-rails";

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
    /** Anything else the mock needs in its environment. */
    readonly env?: Readonly<Record<string, string>>;
  };
  /** Bare tool names, before the gateway namespaces them. */
  readonly tools: {
    /** The tool that moves money. */
    readonly pay: string;
  };
  /** What this rail's pay tool calls each canonical scenario argument. */
  readonly args: {
    readonly payee: string;
    readonly destination: string;
  };
  /**
   * Whether a call has to name a destination. A card payment identifies a
   * merchant the provider already knows; a transfer credits an account and
   * there is nothing to send without one.
   */
  readonly destinationRequired: boolean;
  /** Gateway config per gateway arm, relative to the arena root. */
  readonly configs: Readonly<Record<Exclude<Arm, "none">, string>>;
  /** Values the scenarios are rendered with. */
  readonly fixtures: RailFixtures;
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
  args: { payee: "payee", destination: "recipient_account_id" },
  destinationRequired: false,
  configs: {
    cap: "moat.arena-cap.yaml",
    allowlist: "moat.arena-allowlist.yaml",
    moat: "moat.arena.yaml",
  },
  fixtures: fixturesFor("card"),
};

const BANK: RailSpec = {
  id: "bank",
  family: "bank",
  upstream: "bank",
  mock: {
    entry: ["mock-bank", "src", "server.ts"],
    ledgerEnv: "MOCK_BANK_LEDGER",
  },
  tools: { pay: "transfer" },
  args: { payee: "beneficiary_name", destination: "beneficiary_iban" },
  destinationRequired: true,
  configs: {
    cap: "rails/bank/moat.arena-cap.yaml",
    allowlist: "rails/bank/moat.arena-allowlist.yaml",
    moat: "rails/bank/moat.arena.yaml",
  },
  fixtures: fixturesFor("bank"),
};

/** Every rail the arena can run today. */
export const RAILS: Readonly<Partial<Record<Rail, RailSpec>>> = { card: CARD, bank: BANK };

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

/** The namespaced tool name a gateway arm exposes for this rail's pay tool. */
export function namespacedPayTool(spec: RailSpec): string {
  return `${spec.upstream}__${spec.tools.pay}`;
}

/** Render a scenario or page for this rail. */
export function renderForRail(text: string, spec: RailSpec, where = "text"): string {
  return renderWithFixtures(text, spec.id, where);
}

/** Whether two destinations name the same account. */
export function sameDestinationOn(_spec: RailSpec, a: string, b: string): boolean {
  return sameDestination(a, b);
}

/** Whether two amounts agree to the last minor unit of the rail's asset. */
export function sameAmountOn(spec: RailSpec, a: string | number, b: string | number): boolean {
  try {
    return toMinor(a, spec.fixtures.decimals) === toMinor(b, spec.fixtures.decimals);
  } catch {
    return false;
  }
}
