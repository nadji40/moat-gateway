// The values that differ between settlement rails, and the renderer that
// puts them into a scenario or a page.
//
// This is a package rather than a module inside the runner because two
// processes need the same answer. The runner renders the scenario that
// drives the agent; the mock web server renders the invoice the agent
// reads. If those two disagreed about what `{{rail.attacker.destination}}`
// is, an attack would quietly stop being an attack -- the agent would be
// paying an account that appears nowhere on the page it supposedly read it
// from -- and the run would still look green.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A rail the arena can run scenarios against. */
export type Rail = "card" | "bank" | "evm" | "solana";

/** Every rail id the arena knows the name of, implemented or not. */
export const RAIL_IDS: readonly Rail[] = ["card", "bank", "evm", "solana"];

/** Whether `value` is one of those ids. */
export function isRail(value: string): value is Rail {
  return (RAIL_IDS as readonly string[]).includes(value);
}

/** One party's account on a rail: compact for comparison, and as printed. */
export interface DestinationFixture {
  readonly destination: string;
  readonly destination_display: string;
}

/** The concrete values a scenario's placeholders are rendered with. */
export interface RailFixtures {
  /** How to describe this rail in prose on a page or in a task. */
  readonly label: string;
  /** The asset a scenario is denominated in on this rail. */
  readonly asset: string;
  /** A second asset, for the currency-substitution attacks. */
  readonly alt_asset: string;
  /** How `asset` is written beside a figure on a page. */
  readonly symbol: string;
  /** Minor-unit exponent of `asset`, used to compare amounts exactly. */
  readonly decimals: number;
  readonly authorized: DestinationFixture;
  readonly attacker: DestinationFixture;
  readonly lookalike: DestinationFixture;
  /** A legitimate counterparty nobody has approved yet. */
  readonly newcomer: DestinationFixture;
}

const here = dirname(fileURLToPath(import.meta.url));

const FIXTURES = JSON.parse(readFileSync(join(here, "..", "fixtures.json"), "utf8")) as Record<
  string,
  RailFixtures
>;

/** Fixtures for `rail`, or a readable error if there are none. */
export function fixturesFor(rail: Rail): RailFixtures {
  const found = FIXTURES[rail];
  if (!found) {
    throw new Error(
      `rails/fixtures.json has no entry for ${rail}; have ${Object.keys(FIXTURES).join(", ")}`,
    );
  }
  return found;
}

/** Rails that have fixtures, in a stable order. */
export function railsWithFixtures(): Rail[] {
  return Object.keys(FIXTURES).filter(isRail).sort();
}

/** Every placeholder a scenario or page may use, and what it renders to. */
export function substitutions(rail: Rail): Record<string, string> {
  const f = fixturesFor(rail);
  const out: Record<string, string> = {
    "rail.id": rail,
    "rail.label": f.label,
    "rail.asset": f.asset,
    "rail.alt_asset": f.alt_asset,
    "rail.symbol": f.symbol,
  };
  for (const party of ["authorized", "attacker", "lookalike", "newcomer"] as const) {
    out[`rail.${party}.destination`] = f[party].destination;
    out[`rail.${party}.destination_display`] = f[party].destination_display;
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*([a-z_.]+)\s*\}\}/g;

/**
 * Render `{{rail.*}}` placeholders for `rail`.
 *
 * An unknown placeholder throws rather than being left in place. A scenario
 * that ran with a literal `{{...}}` where the beneficiary should be would
 * pass every check and measure nothing.
 */
export function renderForRail(text: string, rail: Rail, where = "text"): string {
  const values = substitutions(rail);
  return text.replace(PLACEHOLDER, (match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(
        `${where}: unknown placeholder ${match} for rail ${rail}; ` +
          `have ${Object.keys(values).join(", ")}`,
      );
    }
    return value;
  });
}

/**
 * Split a rail-prefixed path into the rail and the rest.
 *
 * Pages are served at `/<rail>/<path>` so that one file can be rendered
 * differently for each rail. A path with no rail prefix is card, which is
 * what every arena URL meant before rails existed.
 */
export function splitRailPath(path: string): { rail: Rail; rest: string } {
  const trimmed = path.replace(/^\/+/, "");
  const slash = trimmed.indexOf("/");
  const head = slash === -1 ? trimmed : trimmed.slice(0, slash);
  if (isRail(head) && slash !== -1) {
    return { rail: head, rest: trimmed.slice(slash + 1) };
  }
  return { rail: "card", rest: trimmed };
}
