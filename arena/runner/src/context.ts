// Where each mode's MCP endpoints live, and the RunContext handed to a
// backend. Kept free of side effects so tests can import it without
// starting a run.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunContext } from "./backends/types.js";
import { gatewayBinary, IntentApi } from "./gateway.js";
import { connect, type Endpoints } from "./mcp.js";
import type { Mode } from "./results.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The arena directory, which is also the web root the mocks serve. */
export const ARENA_ROOT = resolve(here, "..", "..");

export function mockWebPort(): number {
  return Number(process.env["MOCK_WEB_PORT"] ?? "7100");
}

function intentApiBase(): string {
  return process.env["MOAT_INTENT_API"] ?? "http://127.0.0.1:7072";
}

export function endpointsFor(mode: Mode, session: string, ledger: string): Endpoints {
  const stripeCmd = [join(ARENA_ROOT, "mock-stripe", "src", "server.ts")];
  // The gateway spawns `node` from PATH; make sure it is the same Node that
  // runs this process, so tsx and the SDK resolve identically.
  const env = {
    ...(process.env as Record<string, string>),
    PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
    MOCK_STRIPE_LEDGER: ledger,
  };
  if (mode === "direct") {
    return {
      stdio: {
        command: process.execPath,
        args: ["--import", "tsx", ...stripeCmd],
        env,
        cwd: ARENA_ROOT,
      },
      http: `http://127.0.0.1:${mockWebPort()}/mcp`,
      names: { fetch: "fetch", pay: "pay" },
    };
  }
  return {
    stdio: {
      command: gatewayBinary(ARENA_ROOT),
      args: ["--config", join(ARENA_ROOT, "moat.arena.yaml"), "--session-id", session],
      env: { ...env, RUST_LOG: process.env["RUST_LOG"] ?? "moat_gateway=warn" },
      cwd: ARENA_ROOT,
    },
    names: { fetch: "web__fetch", pay: "stripe__pay" },
  };
}

export function contextFor(mode: Mode, session: string, ledger: string): RunContext {
  const endpoints = endpointsFor(mode, session, ledger);
  return {
    mode,
    session,
    endpoints,
    connect: () => connect(endpoints),
    async registerIntent(text: string) {
      if (mode !== "gateway") return;
      const api = new IntentApi(intentApiBase());
      await api.waitUntilUp();
      await api.intent(session, text);
    },
    async registerAuthorization(attack) {
      if (mode !== "gateway") return undefined;
      const api = new IntentApi(intentApiBase());
      await api.waitUntilUp();
      const authorization_id = `auth-${session}`;
      const invoice_id = `inv-${session}`;
      await api.authorization(session, {
        authorization_id,
        invoice_id,
        ...attack.authorization,
        currency: attack.authorization.currency.toUpperCase(),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      return { authorization_id, invoice_id };
    },
  };
}
