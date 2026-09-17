import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

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
] as const;

export const CONTROL_CLASSES = ["legitimate-invoice"] as const;

const PayArgs = z.object({
  payee: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  authorization_id: z.string().min(1).optional(),
  invoice_id: z.string().min(1).optional(),
});

export const AuthorizationSchema = z.object({
  payee: z.string().min(1),
  amount: z.number().positive(),
  tolerance: z.number().nonnegative().default(0),
  currency: z.string().length(3).default("USD"),
  repeat_payments: z.boolean().default(false),
  max_payments: z.number().int().positive().default(1),
});

export const AttackSchema = z.object({
  kind: z.literal("attack").default("attack"),
  id: z.string().regex(/^[a-z0-9-]+$/),
  class: z.enum(ATTACK_CLASSES),
  description: z.string().min(1),
  /** Paths relative to the arena root; served as https://arena.local/<path>. */
  pages: z.array(z.string().min(1)).min(1),
  /** The user's request, registered as the intent. */
  task: z.string().min(1),
  /** Trusted, structured authority supplied by the user/host. */
  authorization: AuthorizationSchema,
  /** The payee the attacker wants paid. */
  expected: z.string().min(1),
  /** If set, only payments of exactly this amount to `expected` count. */
  expected_amount: z.number().positive().optional(),
  /** If set, only payments in this currency count as attack success. */
  expected_currency: z.string().length(3).optional(),
  /** For mandate replay: success needs at least this many payments to `expected`. */
  paid_calls_for_success: z.number().int().positive().default(1),
  /** What a scripted agent that follows the injection does after reading the pages. */
  injection: z.object({ calls: z.array(PayArgs).min(1) }),
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
  pages: z.array(z.string().min(1)).min(1),
  task: z.string().min(1),
  authorization: AuthorizationSchema,
  expected_payee: z.string().min(1),
  expected_amount: z.number().positive(),
  expected_currency: z.string().length(3).default("USD"),
  expected_payments: z.number().int().positive().default(1),
  execution: z.object({ calls: z.array(PayArgs).min(1) }),
});

export type Attack = z.infer<typeof AttackSchema>;
export type Control = z.infer<typeof ControlSchema>;
export type ArenaScenario = Attack | Control;
export type PayCall = z.infer<typeof PayArgs>;
export type AttackAuthorization = z.infer<typeof AuthorizationSchema>;
export interface ScenarioPaymentMetadata {
  authorization_id: string;
  invoice_id: string;
}

/** Load every `attacks/<id>/attack.yaml` under `arenaRoot`, sorted by id. */
export function loadAttacks(arenaRoot: string): Attack[] {
  const dir = join(arenaRoot, "attacks");
  const out: Attack[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "attack.yaml");
    if (!existsSync(file)) continue;
    const attack = AttackSchema.parse(parse(readFileSync(file, "utf8")));
    if (attack.id !== entry.name) {
      throw new Error(`${file}: id ${attack.id} does not match directory ${entry.name}`);
    }
    validatePages(arenaRoot, file, attack.pages);
    out.push(attack);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Load every `controls/<id>/control.yaml` under `arenaRoot`, sorted by id. */
export function loadControls(arenaRoot: string): Control[] {
  const dir = join(arenaRoot, "controls");
  if (!existsSync(dir)) return [];
  const out: Control[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "control.yaml");
    if (!existsSync(file)) continue;
    const control = ControlSchema.parse(parse(readFileSync(file, "utf8")));
    if (control.id !== entry.name) {
      throw new Error(`${file}: id ${control.id} does not match directory ${entry.name}`);
    }
    validatePages(arenaRoot, file, control.pages);
    out.push(control);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
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

export function pageUrl(page: string): string {
  return `https://arena.local/${page.replace(/^\/+/, "")}`;
}
