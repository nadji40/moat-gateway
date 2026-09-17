import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { listPayments, recipientsFromEnv } from "./stripe.js";

const DENY_CODE = -31051;
const here = dirname(fileURLToPath(import.meta.url));
const arena = resolve(here, "../..");
const repo = resolve(arena, "..");
const gatewayCandidates = [
  resolve(repo, "target/release/moat-gateway"),
  resolve(repo, "target/debug/moat-gateway"),
];

function environment(): Record<string, string> {
  return process.env as Record<string, string>;
}

async function clientFor(command: string, args: string[], name: string): Promise<Client> {
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command,
      args,
      cwd: arena,
      env: environment(),
      stderr: "inherit",
    }),
  );
  return client;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: T }).structuredContent as T;
}

async function registerIntent(session: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:7074/v1/session/${encodeURIComponent(session)}/intent`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Pay Monitoring Pro Inc 1 USD for the sandbox invoice." }),
        },
      );
      if (response.ok) return;
    } catch {
      // The gateway starts its intent listener alongside the MCP transport.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("intent registration endpoint did not become ready");
}

async function registerAuthorization(session: string, authorizationId: string, invoiceId: string, payee: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:7074/v1/session/${encodeURIComponent(session)}/authorizations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorization_id: authorizationId,
        invoice_id: invoiceId,
        payee,
        amount: 1,
        tolerance: 0,
        currency: "USD",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    },
  );
  if (!response.ok) throw new Error(`authorization registration failed: ${await response.text()}`);
}

async function main(): Promise<void> {
  if (process.env["MOAT_STRIPE_SMOKE_CONFIRM"] !== "YES") {
    throw new Error("set MOAT_STRIPE_SMOKE_CONFIRM=YES to create three Stripe test payments");
  }
  const recipients = recipientsFromEnv();
  const authorized = recipients.find((recipient) => recipient.role === "authorized")!;
  const unauthorized = recipients.find((recipient) => recipient.role === "unauthorized")!;

  const direct = await clientFor(
    process.execPath,
    ["--import", "tsx", "stripe-sandbox/src/server.ts"],
    "moat-stripe-direct-smoke",
  );
  try {
    const inspected = structured<{ accounts: { id: string; charges_enabled: boolean }[] }>(
      await direct.callTool({ name: "inspect_accounts", arguments: {} }),
    );
    if (inspected.accounts.length !== 2 || new Set(inspected.accounts.map((a) => a.id)).size !== 2) {
      throw new Error("the two keys must belong to two different Stripe accounts");
    }
    if (inspected.accounts.some((account) => !account.charges_enabled)) {
      process.stderr.write(
        "note: Stripe reports charges_enabled=false; attempting test-mode PaymentIntents to determine actual sandbox readiness\n",
      );
    }
    await direct.callTool({
      name: "pay",
      arguments: { payee: authorized.payee, amount: 1, currency: "USD", authorization_id: `direct-auth-${Date.now()}`, invoice_id: `direct-inv-a-${Date.now()}` },
    });
    await direct.callTool({
      name: "pay",
      arguments: { payee: unauthorized.payee, amount: 1, currency: "USD", authorization_id: `direct-unauth-${Date.now()}`, invoice_id: `direct-inv-b-${Date.now()}` },
    });
  } finally {
    await direct.close();
  }

  const beforeBlocked = new Set((await listPayments(unauthorized)).map((payment) => payment.id));
  const gateway = gatewayCandidates.find(existsSync);
  if (!gateway) throw new Error("build moat-gateway before running the Stripe smoke test");
  const session = `stripe-smoke-${Date.now()}`;
  const protectedClient = await clientFor(
    gateway,
    ["--config", resolve(arena, "moat.stripe-sandbox.yaml"), "--session-id", session],
    "moat-stripe-gateway-smoke",
  );
  try {
    await registerIntent(session);
    const authorizationId = `auth-${Date.now()}`;
    const invoiceId = `inv-${Date.now()}`;
    await registerAuthorization(session, authorizationId, invoiceId, authorized.payee);
    await protectedClient.callTool({
      name: "stripe__pay",
      arguments: { payee: authorized.payee, amount: 1, currency: "USD", authorization_id: authorizationId, invoice_id: invoiceId },
    });
    let denied = false;
    try {
      await protectedClient.callTool({
        name: "stripe__pay",
        arguments: { payee: unauthorized.payee, amount: 1, currency: "USD", authorization_id: authorizationId, invoice_id: `${invoiceId}-wrong` },
      });
    } catch (error) {
      denied = error instanceof McpError && error.code === DENY_CODE;
    }
    if (!denied) throw new Error("Moat did not deny the unauthorized recipient");
  } finally {
    await protectedClient.close();
  }

  const afterBlocked = await listPayments(unauthorized);
  if (afterBlocked.some((payment) => !beforeBlocked.has(payment.id))) {
    throw new Error("the blocked gateway call created a Stripe PaymentIntent");
  }
  process.stdout.write(
    "PASS: both Stripe accounts accepted direct test payments; Moat allowed the authorized recipient and stopped the unauthorized recipient before Stripe.\n",
  );
}

await main();
