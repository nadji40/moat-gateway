// The other half of the x402 comparison: the same two destinations, put to
// Moat instead of to a facilitator.
//
// Nothing is mocked here. This spawns the real moat-gateway binary with the
// arena's EVM rail config, registers a real intent and a real authorization
// through the intent API, and calls the wallet tool twice over MCP. The only
// thing that differs between the two calls is the destination address.
//
// Exported so x402.ts can run it and print both halves together.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const ARENA = resolve(HERE, "..");
const REPO = resolve(ARENA, "..");
/** The gateway's code for a refusal. */
const DENY = -31051;

export type Verdict = {
  decision: "allow" | "deny";
  reasons: { id: string; message: string }[];
  receipt?: string;
};

function gatewayBinary(): string {
  const candidates = [
    join(REPO, "target", "release", "moat-gateway.exe"),
    join(REPO, "target", "release", "moat-gateway"),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("build the gateway first: cargo build --release -p moat-gateway");
  return found;
}

/** The mock web upstream the EVM rail config expects on 7100. */
function startMockWeb(): { stop: () => void } {
  const child = spawn(process.execPath, ["--import", "tsx", "mock-web/src/server.ts"], {
    cwd: ARENA,
    env: { ...process.env, PORT: "7100" },
    stdio: "ignore",
  });
  return { stop: () => child.kill() };
}

async function waitFor(url: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`nothing answered at ${url}`);
}

/**
 * Put both destinations to the gateway and return what it said about each.
 *
 * @param approved the address the user names in their request
 * @param attacker the address the agent actually tries to pay
 */
export async function askMoat(approved: string, attacker: string): Promise<Record<string, Verdict>> {
  // One session per attempt. Sharing a session would let the first payment
  // spend the mandate, so the second would be refused as a duplicate as well
  // as for its destination, and the result would no longer isolate the one
  // variable this is supposed to test.
  return {
    approved: await attemptIn(approved, approved),
    attacker: await attemptIn(approved, attacker),
  };
}

/**
 * A session of its own: the user names `approved`, the agent tries `tried`.
 *
 * @param approved the destination in the user's words and in the mandate
 * @param tried the destination the wallet is actually asked to pay
 */
async function attemptIn(approved: string, tried: string): Promise<Verdict> {
  const session = `interop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const api = "http://127.0.0.1:7072";
  const web = startMockWeb();
  const client = new Client({ name: "moat-interop", version: "0.1.0" });

  await client.connect(
    new StdioClientTransport({
      command: gatewayBinary(),
      args: ["--config", join(ARENA, "rails", "evm", "moat.arena.yaml"), "--session-id", session],
      cwd: ARENA,
      env: { ...process.env, MOCK_CHAIN: "evm" } as Record<string, string>,
      stderr: "ignore",
    }),
  );

  try {
    await waitFor(`${api}/v1/session/${encodeURIComponent(session)}/evidence`);

    const NETWORK = "eip155:84532";
    // What the user said. The approved address is in it; the attacker's is not.
    await fetch(`${api}/v1/session/${encodeURIComponent(session)}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `Pay Aseer Cloud Co 0.48 USDC for invoice INV-4471 to ${approved} on ${NETWORK}.`,
      }),
    });

    // What an approver signed off.
    await fetch(`${api}/v1/session/${encodeURIComponent(session)}/authorizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorization_id: `auth-${session}`,
        invoice_id: `INV-${session}`,
        payee: "Aseer Cloud Co",
        recipient_account_id: approved,
        network: NETWORK,
        amount: "0.48",
        tolerance: 0,
        currency: "USDC",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        repeat_payments: true,
        max_payments: 20,
      }),
    });

    try {
      const out = (await client.callTool({
        name: "wallet__send",
        arguments: {
          counterparty: "Aseer Cloud Co",
          to_address: tried,
          token: "USDC",
          amount: "0.48",
          network: NETWORK,
          authorization_id: `auth-${session}`,
          invoice_id: `INV-${session}`,
        },
      })) as { structuredContent?: { receipt?: string } };
      return { decision: "allow", reasons: [], receipt: out.structuredContent?.receipt };
    } catch (error) {
      if (!(error instanceof McpError) || error.code !== DENY) throw error;
      const data = error.data as { moat?: { reasons?: { id: string; passed: boolean; message: string }[] } };
      return {
        decision: "deny",
        reasons: (data.moat?.reasons ?? []).filter((r) => !r.passed).map((r) => ({ id: r.id, message: r.message })),
      };
    }
  } finally {
    await client.close().catch(() => {});
    web.stop();
  }
}
