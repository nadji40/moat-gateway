import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPayment,
  inspectAccount,
  listPayments,
  recipientFor,
  recipientsFromEnv,
} from "./stripe.js";

const recipients = recipientsFromEnv();
const server = new McpServer({ name: "stripe-sandbox", version: "0.1.0" });

server.registerTool(
  "pay",
  {
    description: "Create and confirm a Stripe test-mode payment to a configured sandbox payee.",
    inputSchema: {
      payee: z.string().describe("Exact configured merchant name"),
      amount: z.number().positive().describe("Amount in major units, for example 4.80 USD"),
      currency: z.string().length(3).default("USD").describe("ISO 4217 currency code"),
      authorization_id: z.string().min(1).describe("Moat payment authorization id"),
      invoice_id: z.string().min(1).describe("Supplier invoice id"),
      simulate_response_loss: z.boolean().default(false).describe("Test-only failure after Stripe accepts the payment"),
    },
  },
  async ({ payee, amount, currency, authorization_id, invoice_id, simulate_response_loss }) => {
    const recipient = recipientFor(payee, recipients);
    const payment = await createPayment(recipient, amount, currency, authorization_id, invoice_id);
    if (simulate_response_loss) {
      throw new Error("simulated response loss after Stripe accepted the idempotent payment");
    }
    return {
      content: [
        {
          type: "text",
          text: `Stripe sandbox payment ${payment.status}: ${amount} ${currency.toUpperCase()} to ${payment.payee}. PaymentIntent ${payment.id}.`,
        },
      ],
      structuredContent: {
        receipt: payment.id,
        payee: payment.payee,
        amount,
        currency: payment.currency,
        status: payment.status,
        account: payment.account,
        recipient_role: payment.role,
        authorization_id: payment.authorization_id,
        invoice_id: payment.invoice_id,
      },
    };
  },
);

server.registerTool(
  "list_payments",
  {
    description: "List recent Moat-created Stripe sandbox payments from both test accounts.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
  },
  async ({ limit }) => {
    const groups = await Promise.all(recipients.map((recipient) => listPayments(recipient, limit)));
    const payments = groups.flat().sort((a, b) => b.created.localeCompare(a.created));
    return {
      content: [{ type: "text", text: JSON.stringify(payments) }],
      structuredContent: { payments },
    };
  },
);

server.registerTool(
  "inspect_accounts",
  {
    description: "Show the safe identifiers and readiness state of the configured Stripe accounts.",
    inputSchema: {},
  },
  async () => {
    const accounts = await Promise.all(recipients.map(inspectAccount));
    return {
      content: [{ type: "text", text: JSON.stringify(accounts) }],
      structuredContent: { accounts },
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `stripe-sandbox: ready for ${recipients.map((recipient) => `${recipient.role}:${recipient.payee}`).join(", ")}\n`,
);
