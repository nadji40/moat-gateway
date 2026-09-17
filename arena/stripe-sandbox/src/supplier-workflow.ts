import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { listPayments, recipientsFromEnv } from "./stripe.js";

const STEP_UP = -31050;
const DENY = -31051;
const here = dirname(fileURLToPath(import.meta.url));
const arena = resolve(here, "../..");
const repo = resolve(arena, "..");
const gatewayCandidates = [
  resolve(repo, "target/release/moat-gateway"),
  resolve(repo, "target/debug/moat-gateway"),
];

interface WorkflowSnapshot {
  authorizations: { id: string; invoice_id: string }[];
  payment_outcomes: {
    authorization_id: string;
    invoice_id: string;
    evidence_id: string;
    receipt?: string;
    status: string;
    succeeded: boolean;
  }[];
  evidence: { id: string; verdict: { decision: string } }[];
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: T }).structuredContent as T;
}

async function api(session: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(
    `http://127.0.0.1:7074/v1/session/${encodeURIComponent(session)}${path}`,
    init,
  );
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function waitForApi(session: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await api(session, "/workflow");
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error("Moat intent API did not become ready");
}

async function authorize(
  session: string,
  input: {
    authorization_id: string;
    invoice_id: string;
    payee: string;
    amount: number;
    tolerance?: number;
  },
): Promise<void> {
  await api(session, "/authorizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...input,
      tolerance: input.tolerance ?? 0,
      currency: "USD",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      repeat_payments: false,
      max_payments: 1,
    }),
  });
}

function paymentArgs(
  payee: string,
  authorizationId: string,
  invoiceId: string,
  amount: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    payee,
    amount,
    currency: "USD",
    authorization_id: authorizationId,
    invoice_id: invoiceId,
    ...extra,
  };
}

function assertMcpCode(error: unknown, code: number, label: string): McpError {
  if (!(error instanceof McpError) || error.code !== code) {
    throw new Error(`${label}: expected MCP error ${code}, got ${String(error)}`);
  }
  return error;
}

async function expectDenied(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assertMcpCode(error, DENY, label);
    return;
  }
  throw new Error(`${label}: expected denial`);
}

async function main(): Promise<void> {
  if (process.env["MOAT_STRIPE_WORKFLOW_CONFIRM"] !== "YES") {
    throw new Error("set MOAT_STRIPE_WORKFLOW_CONFIRM=YES to run real Stripe test-mode payments");
  }
  const gateway = gatewayCandidates.find(existsSync);
  if (!gateway) throw new Error("build moat-gateway before running the supplier workflow");
  const recipient = recipientsFromEnv().find((candidate) => candidate.role === "authorized")!;
  const run = Date.now().toString(36);
  const session = `supplier-invoice-${run}`;
  const client = new Client({ name: "moat-supplier-workflow", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: gateway,
      args: ["--config", resolve(arena, "moat.supplier-invoice.yaml"), "--session-id", session],
      cwd: arena,
      env: process.env as Record<string, string>,
      stderr: "inherit",
    }),
  );

  const receipts = new Map<string, string>();
  const pay = async (authorizationId: string, invoiceId: string, amount: number, extra = {}) => {
    const result = await client.callTool({
      name: "stripe__pay",
      arguments: paymentArgs(recipient.payee, authorizationId, invoiceId, amount, extra),
    });
    const payment = structured<{ receipt: string; status: string }>(result);
    if ((result as { isError?: boolean }).isError) return result;
    if (!payment || payment.status !== "succeeded") {
      throw new Error(`${invoiceId}: Stripe did not return a succeeded payment`);
    }
    receipts.set(authorizationId, payment.receipt);
    return result;
  };

  try {
    await waitForApi(session);

    const ordinary = `auth-ordinary-${run}`;
    await authorize(session, {
      authorization_id: ordinary,
      invoice_id: `INV-ORD-${run}`,
      payee: recipient.payee,
      amount: 1,
    });
    await pay(ordinary, `INV-ORD-${run}`, 1);
    await expectDenied(pay(ordinary, `INV-ORD-${run}`, 1), "duplicate settled invoice");

    const tolerance = `auth-tolerance-${run}`;
    await authorize(session, {
      authorization_id: tolerance,
      invoice_id: `INV-TOL-${run}`,
      payee: recipient.payee,
      amount: 1,
      tolerance: 0.1,
    });
    await pay(tolerance, `INV-TOL-${run}`, 1.05);

    const approval = `auth-approval-${run}`;
    const approvalInvoice = `INV-APR-${run}`;
    await authorize(session, {
      authorization_id: approval,
      invoice_id: approvalInvoice,
      payee: recipient.payee,
      amount: 1,
      tolerance: 0.05,
    });
    const approvalArgs = paymentArgs(recipient.payee, approval, approvalInvoice, 1.1);
    let resumeToken = "";
    try {
      await client.callTool({ name: "stripe__pay", arguments: approvalArgs });
    } catch (error) {
      const stepUp = assertMcpCode(error, STEP_UP, "unexpected price increase");
      resumeToken = (stepUp.data as { moat?: { resume_token?: string } } | undefined)?.moat
        ?.resume_token ?? "";
    }
    if (!resumeToken) throw new Error("step-up response did not include a resume token");
    await api(session, "/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume_token: resumeToken, approved: true }),
    });
    await pay(approval, approvalInvoice, 1.1);

    for (const suffix of ["A", "B"]) {
      const fresh = `auth-repeat-${suffix}-${run}`;
      const invoice = `INV-REPEAT-${suffix}-${run}`;
      await authorize(session, {
        authorization_id: fresh,
        invoice_id: invoice,
        payee: recipient.payee,
        amount: 1,
      });
      await pay(fresh, invoice, 1);
    }

    const cancelled = `auth-cancelled-${run}`;
    const cancelledInvoice = `INV-CANCEL-${run}`;
    await authorize(session, {
      authorization_id: cancelled,
      invoice_id: cancelledInvoice,
      payee: recipient.payee,
      amount: 1,
    });
    await api(session, `/authorizations/${encodeURIComponent(cancelled)}/cancel`, { method: "POST" });
    await expectDenied(pay(cancelled, cancelledInvoice, 1), "cancelled authorization");

    const retry = `auth-retry-${run}`;
    const retryInvoice = `INV-RETRY-${run}`;
    await authorize(session, {
      authorization_id: retry,
      invoice_id: retryInvoice,
      payee: recipient.payee,
      amount: 1,
    });
    const lost = await pay(retry, retryInvoice, 1, { simulate_response_loss: true });
    if (!(lost as { isError?: boolean }).isError) {
      throw new Error("fault injection did not simulate a lost provider response");
    }
    await pay(retry, retryInvoice, 1);

    const workflow = (await api(session, "/workflow")) as WorkflowSnapshot;
    const stripePayments = await listPayments(recipient, 100);
    for (const [authorizationId, receipt] of receipts) {
      const outcome = workflow.payment_outcomes.find(
        (candidate) =>
          candidate.authorization_id === authorizationId &&
          candidate.receipt === receipt &&
          candidate.succeeded,
      );
      const providerRecord = stripePayments.find(
        (candidate) =>
          candidate.authorization_id === authorizationId && candidate.id === receipt,
      );
      if (!outcome || !providerRecord || providerRecord.status !== "succeeded") {
        throw new Error(`reconciliation failed for ${authorizationId}`);
      }
    }
    const retryProviderRecords = stripePayments.filter(
      (payment) => payment.authorization_id === retry && payment.invoice_id === retryInvoice,
    );
    if (retryProviderRecords.length !== 1) {
      throw new Error(`safe retry created ${retryProviderRecords.length} provider transactions`);
    }

    process.stdout.write(
      JSON.stringify(
        {
          result: "PASS",
          session,
          cases: {
            ordinary_invoice: "settled",
            permitted_price_change: "settled",
            unexpected_price_increase: "approved_then_settled",
            repeat_purchase: "two_fresh_authorizations_settled",
            cancellation: "denied_before_provider",
            retry_after_lost_response: "one_stripe_payment_reconciled",
            duplicate_payment: "denied_before_provider",
          },
          reconciliation: {
            authorizations: workflow.authorizations.length,
            evidence_records: workflow.evidence.length,
            provider_outcomes: workflow.payment_outcomes.length,
            successful_receipts: receipts.size,
          },
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await client.close();
  }
}

await main();
