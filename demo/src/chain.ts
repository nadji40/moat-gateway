// The one path on this page that moves real value.
//
// Everything else the page does runs against a mock provider and costs
// nothing. This drives the actual Base Sepolia wallet through Moat, so a
// visitor can click a block explorer and see that the allowed payment
// happened and the refused one does not exist.
//
// It is public, so the limits are enforced here rather than assumed:
//
//   a dedicated wallet, funded with a few thousandths of an ether and
//   nothing else, separate from the wallets the smoke scripts use, so the
//   worst case is that this page stops working;
//
//   a hard cap on how many payments the page will ever make, counted in
//   this process, so a restart is the only way to raise it;
//
//   a floor on the balance, so the wallet is never drained to the point
//   where it cannot pay gas and every later visitor sees an error;
//
//   and two sends per caller, because the second one proves nothing the
//   first did not.
//
// The refusal path costs nothing at all: Moat denies before the wallet is
// ever asked, which is the point being demonstrated.

import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, formatEther, http } from "viem";
import { baseSepolia } from "viem/chains";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(HERE, "..");
const DENY = -31051;
const CONFIG = join(REPO, "arena", "moat.evm-demo.yaml");
const API = process.env["MOAT_DEMO_CHAIN_API"] ?? "http://127.0.0.1:7091";
const NETWORK = "eip155:84532";
/** Each demonstration pays this much. Enough to exist, small enough to repeat. */
const AMOUNT = "0.00002";
/** The page will make at most this many real payments before refusing. */
const MAX_SENDS = Number(process.env["MOAT_DEMO_MAX_SENDS"] ?? "40");
/** Stop while there is still gas, rather than when the wallet is empty. */
const FLOOR_WEI = 2_000_000_000_000_000n; // 0.002 ETH
const PER_CALLER = 2;

let sent = 0;
const byCaller = new Map<string, number>();

/**
 * The environment a gateway child needs.
 *
 * The gateway spawns `node` from PATH to run the mock provider, so it has
 * to be the same Node that is running this service -- under systemd the
 * binary may be installed under another name entirely, and a PATH without
 * a plain `node` on it makes the gateway exit the moment it tries. The
 * arena learned this first; the symptom here is an MCP connection that
 * closes immediately and says nothing about why.
 */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...(process.env as Record<string, string>),
    [key]: `${dirname(process.execPath)}${delimiter}${process.env[key] ?? ""}`,
    ...extra,
  };
}

const chain = createPublicClient({ chain: baseSepolia, transport: http() });

function walletAddress(): string | undefined {
  return process.env["MOAT_DEMO_WALLET_ADDRESS"];
}

/** What the page shows about the chain demo before anyone clicks. */
export function chainState(): {
  enabled: boolean;
  amount: string;
  remaining: number;
  network: string;
  wallet?: string;
  explorer?: string;
} {
  const wallet = walletAddress();
  return {
    enabled: existsSync(CONFIG) && wallet !== undefined,
    amount: AMOUNT,
    remaining: Math.max(0, MAX_SENDS - sent),
    network: NETWORK,
    ...(wallet
      ? {
          wallet,
          explorer: `https://sepolia.basescan.org/address/${wallet}`,
        }
      : {}),
  };
}

export interface ChainOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Pay, or be refused, on Base Sepolia, through Moat.
 *
 * `approved` sends to the address the authorization names and produces a
 * real transaction. `forged` sends to an address the user never approved,
 * which Moat refuses before the wallet is asked — so it costs nothing and
 * leaves no transaction, which is exactly what the page is claiming.
 */
export async function chainDemo(who: string, mode: string): Promise<ChainOutcome> {
  const wallet = walletAddress();
  if (!existsSync(CONFIG) || !wallet) {
    return { status: 503, body: { error: "the chain demonstration is not configured here" } };
  }
  const forged = mode === "forged";

  if (!forged) {
    if (sent >= MAX_SENDS) {
      return {
        status: 429,
        body: { error: "this page has made all the real payments it is allowed to make" },
      };
    }
    if ((byCaller.get(who) ?? 0) >= PER_CALLER) {
      return { status: 429, body: { error: "you have already seen this one work twice" } };
    }
    const balance = await chain.getBalance({ address: wallet as `0x${string}` });
    if (balance < FLOOR_WEI) {
      return {
        status: 503,
        body: {
          error: "the demonstration wallet is low and has stopped before running out of gas",
          balance: formatEther(balance),
        },
      };
    }
  }

  const session = `demo-chain-${Date.now().toString(36)}`;
  const client = new Client({ name: "moat-demo-chain", version: "0.1.0" });
  const gateway = [
    join(REPO, "target", "release", "moat-gateway.exe"),
    join(REPO, "target", "release", "moat-gateway"),
  ].find(existsSync);
  if (!gateway) return { status: 503, body: { error: "the gateway is not built here" } };

  await client.connect(
    new StdioClientTransport({
      command: gateway,
      args: ["--config", CONFIG, "--session-id", session],
      cwd: join(REPO, "arena"),
      env: childEnv({}),
      stderr: "ignore",
    }),
  );

  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        if ((await fetch(`${API}/v1/session/${encodeURIComponent(session)}/evidence`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const payee = process.env["MOAT_EVM_AUTHORIZED_PAYEE"] ?? "Monitoring Pro Inc";
    const approved = process.env["MOAT_EVM_AUTHORIZED_ADDRESS"]!;
    const attacker = process.env["MOAT_EVM_UNAUTHORIZED_ADDRESS"]!;
    const authorizationId = `auth-${session}`;
    const invoiceId = `INV-${session}`;

    await fetch(`${API}/v1/session/${encodeURIComponent(session)}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `Pay ${payee} ${AMOUNT} ETH for invoice ${invoiceId} to ${approved} on ${NETWORK}.`,
      }),
    });
    await fetch(`${API}/v1/session/${encodeURIComponent(session)}/authorizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorization_id: authorizationId,
        invoice_id: invoiceId,
        payee,
        recipient_account_id: approved,
        network: NETWORK,
        amount: AMOUNT,
        tolerance: 0,
        currency: "ETH",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        repeat_payments: false,
        max_payments: 1,
      }),
    });

    try {
      const result = (await client.callTool({
        name: "wallet__send",
        arguments: {
          counterparty: payee,
          to_address: forged ? attacker : approved,
          token: "ETH",
          amount: AMOUNT,
          network: NETWORK,
          authorization_id: authorizationId,
          invoice_id: invoiceId,
        },
      })) as { structuredContent?: { receipt?: string; status?: string; explorer_url?: string } };
      if (forged) {
        // Should be unreachable: the page's claim is that this is refused.
        return { status: 500, body: { error: "the forged payment was not refused" } };
      }
      sent += 1;
      byCaller.set(who, (byCaller.get(who) ?? 0) + 1);
      const s = result.structuredContent ?? {};
      return {
        status: 200,
        body: {
          mode: "approved",
          decision: "allow",
          amount: AMOUNT,
          to: approved,
          tx: s.receipt,
          status_on_chain: s.status,
          explorer: s.explorer_url,
          remaining: Math.max(0, MAX_SENDS - sent),
        },
      };
    } catch (error) {
      if (!(error instanceof McpError) || error.code !== DENY) throw error;
      const data = error.data as {
        moat?: { reasons?: { id: string; passed: boolean; message: string }[] };
      };
      const reasons = (data.moat?.reasons ?? []).filter((r) => !r.passed);
      return {
        status: 200,
        body: {
          mode: forged ? "forged" : "approved",
          decision: "deny",
          to: forged ? attacker : approved,
          reasons,
          // The thing worth saying plainly: no transaction exists.
          tx: null,
          remaining: Math.max(0, MAX_SENDS - sent),
        },
      };
    }
  } finally {
    await client.close().catch(() => {});
  }
}
