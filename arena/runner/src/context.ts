// Where each arm's MCP endpoints live, and the RunContext handed to a
// backend. Kept free of side effects so tests can import it without
// starting a run.
//
// Two dimensions cross here. A *rail* is how the money leaves (see rails.ts);
// an *arm* is what stands between the agent and the money. Everything that
// differs per rail comes from its RailSpec, so this file stays about arms.
// The rail is a trailing argument defaulting to card, which is what every
// call here meant before rails existed.
//
// An arm is one control layer under evaluation:
//   none       the mocks directly; nothing between the agent and the money
//   cap        the gateway with policies/arm-cap.yaml: a per-transaction cap, nothing else
//   allowlist  the gateway with policies/arm-allowlist.yaml: a payee allowlist, nothing else
//   moat       the gateway with policies/default.yaml plus user intent and structured authorization
//
// The baseline arms never register intent or an authorization. The core only
// enforces mandates once one exists in the session (moat-core policy.rs,
// `structured_authorization_required`), so registering it would hand those
// arms Moat's checks and spoil the comparison.

import { readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { RunContext } from "./backends/types.js";
import { gatewayBinary, IntentApi } from "./gateway.js";
import { connect, type Endpoints } from "./mcp.js";
import { ARENA_ROOT } from "./paths.js";
import {
  DEFAULT_RAIL,
  mockEntry,
  namespacedPayTool,
  railSpec,
  type Rail,
} from "./rails.js";
import { armForMode, modeForArm, type Arm, type Mode } from "./results.js";

export { ARENA_ROOT };

/** Accepts the old mode names too: direct is the none arm, gateway is the moat arm. */
export function armOf(value: Arm | Mode): Arm {
  return value === "direct" || value === "gateway" ? armForMode(value) : value;
}

/** The gateway config a rail uses for an arm, relative to the arena root. */
export function configFor(arm: Exclude<Arm, "none">, rail: Rail = DEFAULT_RAIL): string {
  return railSpec(rail).configs[arm];
}

/** The policy file an arm's gateway config points at, resolved the way the gateway resolves it. */
export function policyFor(arm: Exclude<Arm, "none">, rail: Rail = DEFAULT_RAIL): string {
  const config = join(ARENA_ROOT, configFor(arm, rail));
  const doc = parse(readFileSync(config, "utf8")) as { policy?: string };
  if (!doc.policy) throw new Error(`${config} has no policy`);
  return resolve(dirname(config), doc.policy);
}

export function mockWebPort(): number {
  return Number(process.env["MOCK_WEB_PORT"] ?? "7100");
}

function intentApiBase(): string {
  return process.env["MOAT_INTENT_API"] ?? "http://127.0.0.1:7072";
}

export function endpointsFor(
  value: Arm | Mode,
  session: string,
  ledger: string,
  rail: Rail = DEFAULT_RAIL,
  mockEnv: Record<string, string> = {},
): Endpoints {
  const arm = armOf(value);
  const spec = railSpec(rail);
  // The gateway spawns `node` from PATH; make sure it is the same Node that
  // runs this process, so tsx and the SDK resolve identically. Windows spells
  // the variable `Path`, so reuse whatever key is already there.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env = {
    ...(process.env as Record<string, string>),
    [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ""}`,
    ...spec.mock.env,
    // How this scenario needs the provider to behave. Last, so a scenario
    // can override a rail default, and applied to the gateway's own
    // environment too, because in the gateway arms the gateway is what
    // spawns the mock.
    ...mockEnv,
    [spec.mock.ledgerEnv]: ledger,
  };
  if (arm === "none") {
    return {
      stdio: {
        command: process.execPath,
        args: ["--import", "tsx", mockEntry(ARENA_ROOT, spec)],
        env,
        cwd: ARENA_ROOT,
      },
      http: `http://127.0.0.1:${mockWebPort()}/mcp`,
      names: { fetch: "fetch", pay: spec.tools.pay },
    };
  }
  return {
    stdio: {
      command: gatewayBinary(ARENA_ROOT),
      args: ["--config", join(ARENA_ROOT, configFor(arm, rail)), "--session-id", session],
      env: { ...env, RUST_LOG: process.env["RUST_LOG"] ?? "moat_gateway=warn" },
      cwd: ARENA_ROOT,
    },
    names: { fetch: "web__fetch", pay: namespacedPayTool(spec) },
  };
}

export function contextFor(
  value: Arm | Mode,
  session: string,
  ledger: string,
  rail: Rail = DEFAULT_RAIL,
  mockEnv: Record<string, string> = {},
): RunContext {
  const arm = armOf(value);
  const mode = modeForArm(arm);
  const endpoints = endpointsFor(arm, session, ledger, rail, mockEnv);
  return {
    mode,
    arm,
    rail,
    session,
    endpoints,
    connect: () => connect(endpoints),
    async registerIntent(text: string) {
      if (arm !== "moat") return;
      const api = new IntentApi(intentApiBase());
      await api.waitUntilUp();
      await api.intent(session, text);
    },
    async reconcileOpenOutcomes(status: string) {
      // Only the moat arm registers an authorization, so only it records
      // outcomes and only it can be holding one.
      if (arm !== "moat") return 0;
      const api = new IntentApi(intentApiBase());
      await api.waitUntilUp();
      const open = await api.openOutcomes(session);
      for (const outcome of open) {
        await api.reconcile(session, outcome.evidence_id, status);
      }
      return open.length;
    },
    async registerAuthorization(scenario) {
      if (arm !== "moat") return undefined;
      const api = new IntentApi(intentApiBase());
      await api.waitUntilUp();
      const authorization_id = `auth-${session}`;
      const invoice_id = `inv-${session}`;
      await api.authorization(session, {
        authorization_id,
        invoice_id,
        ...scenario.authorization,
        currency: scenario.authorization.currency.toUpperCase(),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      return { authorization_id, invoice_id };
    },
  };
}
