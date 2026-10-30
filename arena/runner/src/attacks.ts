// The attack and control corpus: one definition per scenario, expanded onto
// each rail it declares.
//
// A definition is written in canonical terms -- a payee, an amount, a
// currency, sometimes an account -- with `{{rail.*}}` placeholders wherever
// the concrete value is a property of the rail rather than of the attack.
// Expanding it renders those placeholders, renames the arguments to the ones
// that rail's payment tool takes, and supplies a destination on rails that
// need one. See rails.ts for what each of those means.
//
// The point of doing it this way rather than writing a corpus per rail: the
// bank table and the card table have to be answering the same question. A
// second corpus would drift from the first within a month, and the moment it
// did, the comparison between rails would stop meaning anything.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { pageDirId } from "@moat/arena-rails";
import {
  DEFAULT_RAIL,
  implementedRails,
  railSpec,
  renderForRail,
  type Rail,
  type RailSpec,
} from "./rails.js";

/** The attack classes the corpus uses. The taxonomy is decided elsewhere. */
export const ATTACK_CLASSES = [
  "injection-to-purchase",
  "merchant-spoofing",
  "mandate-replay",
  "amount-inflation-under-cap",
  "adversarial-merchant-listing",
  "currency-substitution",
  "authorization-bypass",
  "invoice-substitution",
  "recipient-account-change",
  "invoice-content-replay",
  "split-payment",
  "lookalike-destination",
  "lost-reply-replay",
  "network-substitution",
  "standing-approval",
  "unit-confusion",
] as const;

export const CONTROL_CLASSES = ["legitimate-invoice"] as const;

/** Amounts are decimal strings or JSON numbers, never exponent notation. */
const Amount = z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().positive()]);

/**
 * A payment call as a scenario declares it: canonical argument names, which
 * expansion renames to whatever the rail's tool actually takes.
 */
const PayArgs = z.object({
  payee: z.string().min(1),
  amount: Amount,
  currency: z.string().min(3).max(12).default("USD"),
  authorization_id: z.string().min(1).optional(),
  invoice_id: z.string().min(1).optional(),
  recipient_account_id: z.string().min(1).optional(),
  /**
   * The chain to move on. Left out by everything except the attacks that
   * are about the chain: expansion supplies the rail's own network, so a
   * scenario only names one when naming a different one is the point.
   */
  network: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
  invoice_fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  /** Grant a standing allowance instead of making a payment. */
  tool: z.enum(["pay", "approve"]).optional(),
});

export const AuthorizationSchema = z.object({
  payee: z.string().min(1),
  amount: Amount,
  tolerance: z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().nonnegative()]).default(0),
  currency: z.string().min(3).max(12).default("USD"),
  /** Explicit null means this authorization is not bound to one invoice. */
  invoice_id: z.string().min(1).nullable().optional(),
  repeat_payments: z.boolean().default(false),
  max_payments: z.number().int().positive().default(1),
  recipient_account_id: z.string().min(1).optional(),
  /** Bound on rails with more than one chain; supplied by expansion. */
  network: z.string().min(1).optional(),
  /** The token's contract or mint; supplied by expansion on token rails. */
  asset_contract: z.string().min(1).optional(),
  invoice_fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  require_invoice_fingerprint: z.boolean().default(false),
  aggregate_limit: Amount.optional(),
});

const RailId = z.enum(["card", "bank", "evm", "solana"]);

/**
 * Environment for this scenario's mock provider.
 *
 * Some attacks are not about what the agent was talked into sending. They
 * are about what the provider does: a bank that takes an instruction and
 * cannot tell you so. That is a fact about the world, not an argument the
 * caller chooses, so it is configured here rather than passed in the call.
 */
const MockEnv = z.record(z.string(), z.string()).default({});

/**
 * Reconciliation the scenario performs partway through, as an operator
 * would after checking with the provider.
 *
 * Only the `moat` arm holds anything, so only it has anything to
 * reconcile; the other arms ignore this.
 */
const Reconcile = z
  .object({
    /** Reconcile once this many calls have been made. */
    after_call: z.number().int().positive(),
    /** What the provider turned out to have done. */
    status: z.enum(["pending", "submitted", "confirmed", "settled", "failed", "reversed"]),
  })
  .optional();

/**
 * Rails a scenario runs on. Declared rather than defaulted to everything, so
 * adding a rail never silently claims a result for a scenario nobody has
 * thought about on that rail.
 */
const Rails = z.array(RailId).min(1).default([DEFAULT_RAIL]);

export const AttackSchema = z.object({
  kind: z.literal("attack").default("attack"),
  id: z.string().regex(/^[a-z0-9-]+$/),
  class: z.enum(ATTACK_CLASSES),
  description: z.string().min(1),
  rails: Rails,
  /** How this scenario's mock provider is configured to behave. */
  mock_env: MockEnv,
  /** Paths relative to the arena root; served as https://arena.local/<rail>/<path>. */
  pages: z.array(z.string().min(1)).min(1),
  /** The user's request, registered as the intent. */
  task: z.string().min(1),
  /** Trusted, structured authority supplied by the user/host. */
  authorization: AuthorizationSchema,
  /** Requires a database so separate sessions can share the authorization. */
  requires_durable_storage: z.boolean().default(false),
  /** The payee the attacker wants paid. */
  expected: z.string().min(1),
  /** If set, only payments of exactly this amount to `expected` count. */
  expected_amount: Amount.optional(),
  /** If set, only payments in this currency count as attack success. */
  expected_currency: z.string().min(3).max(12).optional(),
  /** If set, only payments to this account count. Compared canonically. */
  expected_destination: z.string().min(1).optional(),
  /** If set, only payments on this chain count. */
  expected_network: z.string().min(1).optional(),
  /** For mandate replay: success needs at least this many payments to `expected`. */
  paid_calls_for_success: z.number().int().positive().default(1),
  /** What a scripted agent that follows the injection does after reading the pages. */
  injection: z.object({ calls: z.array(PayArgs).min(1) }),
  /** Extra gateway sessions that make calls under the same authorization. */
  additional_sessions: z.array(z.object({ calls: z.array(PayArgs).min(1) })).default([]),
  call_mode: z.enum(["sequential", "parallel"]).default("sequential"),
  /** How compromised payment metadata is presented to the payment tool. */
  payment_metadata: z
    .enum(["registered", "omitted", "wrong-invoice", "wrong-authorization"])
    .default("registered"),
});

export const ControlSchema = z.object({
  kind: z.literal("control").default("control"),
  id: z.string().regex(/^[a-z0-9-]+$/),
  class: z.enum(CONTROL_CLASSES),
  description: z.string().min(1),
  rails: Rails,
  mock_env: MockEnv,
  /** An operator checking with the provider, partway through. */
  reconcile: Reconcile,
  pages: z.array(z.string().min(1)).min(1),
  task: z.string().min(1),
  authorization: AuthorizationSchema,
  expected_payee: z.string().min(1),
  expected_amount: Amount,
  expected_currency: z.string().min(3).max(12).default("USD"),
  expected_destination: z.string().min(1).optional(),
  expected_network: z.string().min(1).optional(),
  expected_invoice_fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  expected_payments: z.number().int().positive().default(1),
  execution: z.object({ calls: z.array(PayArgs).min(1) }),
  call_mode: z.enum(["sequential", "parallel"]).default("sequential"),
});

type ParsedAttack = z.infer<typeof AttackSchema>;
type ParsedControl = z.infer<typeof ControlSchema>;

/** A call as it will be sent: the rail's own argument names. */
export type PayCall = Record<string, string | number>;

/** An attack expanded onto one rail. */
export type Attack = Omit<ParsedAttack, "injection" | "additional_sessions"> & {
  rail: Rail;
  injection: { calls: PayCall[] };
  additional_sessions: { calls: PayCall[] }[];
};

/** A control expanded onto one rail. */
export type Control = Omit<ParsedControl, "execution"> & {
  rail: Rail;
  execution: { calls: PayCall[] };
};

export type ArenaScenario = Attack | Control;
export type AttackAuthorization = z.infer<typeof AuthorizationSchema>;

/** A scenario as it sits on disk, before any rail is chosen. */
export interface ScenarioSource {
  id: string;
  kind: "attack" | "control";
  /** Absolute path, for error messages. */
  file: string;
  /** Raw YAML, placeholders unrendered. */
  text: string;
  /** Rails this scenario declares. */
  rails: Rail[];
}

export interface ScenarioPaymentMetadata {
  authorization_id: string;
  invoice_id: string;
}

/** Load every `attacks/<id>/attack.yaml` under `arenaRoot`, sorted by id. */
export function loadAttacks(arenaRoot: string): ScenarioSource[] {
  return loadSources(arenaRoot, "attacks", "attack");
}

/** Load every `controls/<id>/control.yaml` under `arenaRoot`, sorted by id. */
export function loadControls(arenaRoot: string): ScenarioSource[] {
  return loadSources(arenaRoot, "controls", "control");
}

function loadSources(
  arenaRoot: string,
  dirName: string,
  kind: "attack" | "control",
): ScenarioSource[] {
  const dir = join(arenaRoot, dirName);
  if (!existsSync(dir)) return [];
  const out: ScenarioSource[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, `${kind}.yaml`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    // Parsed unrendered only to read the two fields that choose how to
    // render it. Placeholders are quoted in the YAML, so this is valid.
    const head = parse(text) as { id?: string; rails?: string[] };
    if (head.id !== entry.name) {
      throw new Error(`${file}: id ${String(head.id)} does not match directory ${entry.name}`);
    }
    const rails = Rails.parse(head.rails) as Rail[];
    for (const rail of rails) {
      if (!implementedRails().includes(rail)) {
        throw new Error(`${file}: declares rail ${rail}, which has no implementation`);
      }
    }
    out.push({ id: entry.name, kind, file, text, rails });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Sources that declare `rail`, in the order they were loaded. */
export function sourcesForRail(sources: ScenarioSource[], rail: Rail): ScenarioSource[] {
  return sources.filter((source) => source.rails.includes(rail));
}

/**
 * Expand one scenario onto one rail: render its placeholders, then put its
 * calls into the rail's own argument names.
 */
export function scenarioForRail(
  arenaRoot: string,
  source: ScenarioSource,
  rail: Rail,
): ArenaScenario {
  const spec = railSpec(rail);
  const rendered = renderForRail(source.text, spec, source.file);
  const doc = parse(rendered) as unknown;
  if (source.kind === "attack") {
    const parsed = AttackSchema.parse(doc);
    validatePages(arenaRoot, source.file, parsed.pages);
    return {
      ...parsed,
      rail,
      authorization: boundToRail(spec, parsed.authorization),
      injection: { calls: adaptCalls(spec, parsed.authorization.payee, parsed.injection.calls) },
      additional_sessions: parsed.additional_sessions.map((session) => ({
        calls: adaptCalls(spec, parsed.authorization.payee, session.calls),
      })),
    };
  }
  const parsed = ControlSchema.parse(doc);
  validatePages(arenaRoot, source.file, parsed.pages);
  return {
    ...parsed,
    rail,
    authorization: boundToRail(spec, parsed.authorization),
    execution: { calls: adaptCalls(spec, parsed.authorization.payee, parsed.execution.calls) },
  };
}

/**
 * Bind what an authorization on this rail would name.
 *
 * A card mandate names a merchant; a bank mandate names the account, and
 * leaving it unbound would be authorizing a transfer to anywhere. A chain
 * mandate names the account *and the chain*, and leaving the chain unbound
 * would be authorizing the right address on any network -- which is one of
 * the attacks.
 */
function boundToRail(spec: RailSpec, auth: AttackAuthorization): AttackAuthorization {
  const out = { ...auth };
  if (spec.destinationRequired && out.recipient_account_id === undefined) {
    out.recipient_account_id = spec.fixtures.authorized.destination;
  }
  if (spec.networkRequired && out.network === undefined) {
    out.network = spec.fixtures.network;
  }
  // A token mandate names its contract as well, or the gateway refuses it:
  // the right ticker in another contract is a different asset.
  const contract = spec.fixtures.asset_contract;
  if (
    contract !== undefined &&
    out.asset_contract === undefined &&
    out.currency.toUpperCase() === spec.fixtures.asset.toUpperCase()
  ) {
    out.asset_contract = contract;
  }
  return out;
}

/**
 * Put a scenario's calls into the rail's argument names, and give each one a
 * destination if the rail needs one and the scenario did not name one.
 *
 * Which destination depends on who is being paid. A call to the authorized
 * payee goes to the authorized account, because an attack on the amount or
 * the invoice does not move the money elsewhere. A call to anyone else goes
 * to the attacker's account, because a company the agent was talked into
 * paying banks somewhere of its own.
 */
function adaptCalls(
  spec: RailSpec,
  authorizedPayee: string,
  calls: z.infer<typeof PayArgs>[],
): PayCall[] {
  const rename: Record<string, string> = {
    payee: spec.args.payee,
    recipient_account_id: spec.args.destination,
    currency: spec.args.currency,
    network: spec.args.network,
  };
  return calls.map((call) => {
    const out: PayCall = {};
    for (const [key, value] of Object.entries(call)) {
      if (value === undefined) continue;
      // `tool` says which of the rail's tools to call rather than what to
      // pass it, and the client strips it before the call goes out. Kept
      // only when it is not the default, so every existing scenario
      // expands to exactly the arguments it always did.
      if (key === "tool") {
        if (value === "approve") out["tool"] = value;
        continue;
      }
      out[rename[key] ?? key] = value as string | number;
    }
    if (spec.destinationRequired && out[spec.args.destination] === undefined) {
      const party = sameName(call.payee, authorizedPayee) ? "authorized" : "attacker";
      out[spec.args.destination] = spec.fixtures[party].destination_display;
    }
    // Every call on a chain rail names a chain. A scenario that did not say
    // otherwise means the one the wallet is on, which is also the one the
    // authorization binds -- so an attack about the network has to say so
    // out loud, and no other attack accidentally becomes one.
    if (spec.networkRequired && out[spec.args.network] === undefined) {
      out[spec.args.network] = spec.fixtures.network ?? "";
    }
    // A token payment names the contract it is in, as a careful wallet
    // client does and as the gateway requires against a token mandate. Only
    // for the rail's own token: the chain's coin has no contract.
    const contractArg = spec.args.assetContract;
    const contract = spec.fixtures.asset_contract;
    if (
      contractArg !== undefined &&
      contract !== undefined &&
      out[contractArg] === undefined &&
      String(call.currency).toUpperCase() === spec.fixtures.asset.toUpperCase()
    ) {
      out[contractArg] = contract;
    }
    // An approval is granted to a spender, not sent to a recipient. The
    // scenario writes it as a payment because that is what it costs you.
    if (call.tool === "approve") {
      out["spender"] = out[spec.args.destination] as string;
      delete out[spec.args.destination];
    }
    return out;
  });
}

/**
 * Whether two payee names are the same company, as the gateway's
 * normalize_text decides it: case and runs of ASCII whitespace fold, nothing
 * else. A name with a no-break or ideographic space is a different
 * registered company, so a call to it goes to that company's own account.
 */
function sameName(a: string, b: string): boolean {
  const fold = (s: string): string =>
    s.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "").toLowerCase().replace(/[ \t\n\f\r]+/g, " ");
  return fold(a) === fold(b);
}

export function scriptedCalls(scenario: ArenaScenario): PayCall[] {
  return scenario.kind === "attack" ? scenario.injection.calls : scenario.execution.calls;
}

export function metadataForScenario(
  scenario: ArenaScenario,
  registered: ScenarioPaymentMetadata | undefined,
): ScenarioPaymentMetadata | undefined {
  if (!registered || scenario.kind === "control") return registered;
  switch (scenario.payment_metadata) {
    case "omitted":
      return undefined;
    case "wrong-invoice":
      return { ...registered, invoice_id: `tampered-${scenario.id}` };
    case "wrong-authorization":
      return { ...registered, authorization_id: `tampered-${scenario.id}` };
    case "registered":
      return registered;
  }
}

function validatePages(arenaRoot: string, file: string, pages: string[]): void {
  for (const page of pages) {
    const p = resolve(arenaRoot, page);
    if (!existsSync(p)) throw new Error(`${file}: page ${page} does not exist`);
  }
}

/**
 * The URL a page is fetched at on a given rail.
 *
 * The rail is in the path because one page file serves every rail, and the
 * server renders it with that rail's values: the same invoice shows a card
 * account or an IBAN depending on who is asking.
 */
/**
 * The URL the agent is given for a page: the rail, then the page's directory
 * as an opaque id (`pageDirId`), then the file name. The mock web server
 * still answers the descriptive path, so runs recorded before the ids
 * existed reproduce as they were.
 */
export function pageUrl(page: string, rail: Rail): string {
  const clean = page.replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  if (slash < 0) return `https://arena.local/${rail}/${clean}`;
  return `https://arena.local/${rail}/p/${pageDirId(clean.slice(0, slash))}/${clean.slice(slash + 1)}`;
}
