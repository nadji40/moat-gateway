// Fake payment MCP server. Exposes pay(), records
// every call to the JSON file named by MOCK_STRIPE_LEDGER (default
// ./ledger.json) and returns a fake receipt. It never contacts the network.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Ledger } from "./ledger.js";

const ledger = new Ledger(process.env["MOCK_STRIPE_LEDGER"] ?? "./ledger.json");

const server = new McpServer({ name: "mock-stripe", version: "0.1.0" });

server.registerTool(
  "pay",
  {
    description:
      "Send a payment. Returns a receipt. This is a sandbox: nothing is charged.",
    inputSchema: {
      payee: z.string().describe("Name of the merchant or person to pay"),
      amount: z.number().positive().describe("Amount in major units, e.g. 480 for $480"),
      currency: z.string().default("USD").describe("ISO 4217 code"),
      authorization_id: z.string().min(1).optional().describe("Payment authorization id"),
      invoice_id: z.string().min(1).optional().describe("Supplier invoice id"),
      recipient_account_id: z.string().min(1).optional().describe("Payment-rail recipient identity"),
      invoice_fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("Canonical invoice SHA-256"),
    },
  },
  async ({ payee, amount, currency, authorization_id, invoice_id, recipient_account_id, invoice_fingerprint }) => {
    const entry = ledger.append({
      payee,
      amount,
      currency,
      ...(authorization_id ? { authorization_id } : {}),
      ...(invoice_id ? { invoice_id } : {}),
      ...(recipient_account_id ? { recipient_account_id } : {}),
      ...(invoice_fingerprint ? { invoice_fingerprint: invoice_fingerprint.toLowerCase() } : {}),
    });
    return {
      content: [
        {
          type: "text",
          text: `Payment sent: ${amount} ${currency} to ${payee}. Receipt ${entry.receipt}.`,
        },
      ],
      structuredContent: {
        receipt: entry.receipt,
        payee,
        amount,
        currency,
        status: "succeeded",
        ...(authorization_id ? { authorization_id } : {}),
        ...(invoice_id ? { invoice_id } : {}),
        ...(recipient_account_id ? { recipient_account_id } : {}),
        ...(invoice_fingerprint ? { invoice_fingerprint: invoice_fingerprint.toLowerCase() } : {}),
      },
    };
  },
);

server.registerTool(
  "list_payments",
  { description: "List payments made in this sandbox.", inputSchema: {} },
  async () => {
    const entries = ledger.read();
    return {
      content: [{ type: "text", text: JSON.stringify(entries) }],
      structuredContent: { payments: entries },
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(`mock-stripe: ready, ledger ${ledger["path"]}\n`);
