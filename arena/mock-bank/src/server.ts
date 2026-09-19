// Fake bank-transfer MCP server. Exposes transfer(), records every accepted
// instruction to the JSON file named by MOCK_BANK_LEDGER (default
// ./bank-ledger.json) and returns a receipt. It never contacts the network.
//
// What makes this a different rail rather than the card mock with new field
// names:
//
//   The destination is the payment. A card names a merchant the network
//   already knows; a transfer names an account number, and the name beside
//   it is decoration the rail is not obliged to check. So the IBAN is
//   validated and canonicalized here, and the beneficiary name is checked
//   against it only advisorily.
//
//   Acceptance is not arrival. `status` says the bank took the instruction;
//   `settlement` says whether the money has landed. They move apart, and on
//   this rail the second one cannot be undone. Nothing in the gateway reads
//   `settlement` yet -- the outcome state machine that will is its own piece
//   of work -- but the mock records it from the start so that work is a
//   change to the core and not to the arena.
//
// Permissive by design: a mismatched name, an unknown account and a missing
// reference are all recorded and all go through. The arena measures what
// stands between the agent and the money, so the provider must not be it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Ledger, type LedgerSettlement } from "@moat/mock-ledger";
import { canonicalIban, groupIban } from "@moat/mock-ledger/destination";
import { z } from "zod";
import { confirmPayee, directoryFromEnv } from "./accounts.js";

const ledger = new Ledger(process.env["MOCK_BANK_LEDGER"] ?? "./bank-ledger.json", "bank");
const directory = directoryFromEnv(process.env["MOCK_BANK_ACCOUNTS"]);
/** Whether an accepted instruction settles at once. Off means it stays pending. */
const autosettle = process.env["MOCK_BANK_AUTOSETTLE"] === "1";

const server = new McpServer({ name: "mock-bank", version: "0.1.0" });

/** Amounts arrive as decimal strings; a JSON number is accepted and kept exact. */
const Amount = z.union([z.string().min(1), z.number().positive()]);

server.registerTool(
  "transfer",
  {
    description:
      "Instruct a bank transfer to a beneficiary account. Returns a receipt. " +
      "This is a sandbox: no money moves.",
    inputSchema: {
      beneficiary_name: z.string().describe("Name of the account holder being paid"),
      beneficiary_iban: z.string().describe("Beneficiary account in IBAN form"),
      amount: Amount.describe("Amount in major units, e.g. 100 or \"100.00\""),
      currency: z.string().default("EUR").describe("ISO 4217 code"),
      reference: z.string().min(1).optional().describe("Remittance information the beneficiary sees"),
      authorization_id: z.string().min(1).optional().describe("Payment authorization id"),
      invoice_id: z.string().min(1).optional().describe("Supplier invoice id"),
      invoice_fingerprint: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional()
        .describe("Canonical invoice SHA-256"),
    },
  },
  async (args) => {
    const amount = String(args.amount);
    const canonical = canonicalIban(args.beneficiary_iban);
    if (!canonical) {
      // A bank rejects an unparseable account before anything is instructed.
      return {
        content: [
          {
            type: "text",
            text: `Transfer rejected: ${args.beneficiary_iban} is not a valid IBAN.`,
          },
        ],
        structuredContent: { status: "failed", reason: "invalid_iban" },
        isError: true,
      };
    }
    const beneficiary_match = confirmPayee(directory, canonical, args.beneficiary_name);
    const settlement: LedgerSettlement = autosettle ? "settled" : "pending";
    const entry = ledger.append({
      rail: "bank",
      payee: args.beneficiary_name,
      amount,
      currency: args.currency.toUpperCase(),
      status: "succeeded",
      settlement,
      destination: args.beneficiary_iban,
      destination_key: `iban:${canonical}`,
      ...(args.authorization_id ? { authorization_id: args.authorization_id } : {}),
      ...(args.invoice_id ? { invoice_id: args.invoice_id } : {}),
      ...(args.reference ? { reference: args.reference } : {}),
      ...(args.invoice_fingerprint
        ? { invoice_fingerprint: args.invoice_fingerprint.toLowerCase() }
        : {}),
      detail: { beneficiary_match, account_holder: directory[canonical] ?? "not on file" },
    });
    return {
      content: [
        {
          type: "text",
          text:
            `Transfer instructed: ${amount} ${entry.currency} to ${args.beneficiary_name} ` +
            `at ${groupIban(canonical)}. Beneficiary check: ${beneficiary_match}. ` +
            `Settlement ${settlement}. Receipt ${entry.receipt}.`,
        },
      ],
      structuredContent: {
        // What the bank can honestly say. It has taken the instruction; it
        // has not moved the money, and on this rail it cannot take it back
        // once it does. Reporting "succeeded" here would be the mock
        // claiming an outcome it does not have, and the gateway now has a
        // vocabulary that can say the true thing instead.
        status: settlement === "settled" ? "settled" : "pending",
        receipt: entry.receipt,
        settlement,
        beneficiary_name: args.beneficiary_name,
        beneficiary_iban: groupIban(canonical),
        destination: canonical,
        amount,
        currency: entry.currency,
        beneficiary_match,
        ...(args.reference ? { reference: args.reference } : {}),
        ...(args.authorization_id ? { authorization_id: args.authorization_id } : {}),
        ...(args.invoice_id ? { invoice_id: args.invoice_id } : {}),
      },
    };
  },
);

server.registerTool(
  "settle",
  {
    description: "Mark a pending transfer as settled, the way a clearing cycle would.",
    inputSchema: { receipt: z.string().min(1).describe("Receipt returned by transfer") },
  },
  async ({ receipt }) => {
    const updated = ledger.update(receipt, { settlement: "settled" });
    if (!updated) {
      return {
        content: [{ type: "text", text: `No transfer with receipt ${receipt}.` }],
        structuredContent: { status: "failed", reason: "unknown_receipt" },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Transfer ${receipt} settled.` }],
      structuredContent: { status: "succeeded", receipt, settlement: updated.settlement },
    };
  },
);

server.registerTool(
  "get_transfer",
  {
    description: "Look up one transfer by receipt.",
    inputSchema: { receipt: z.string().min(1).describe("Receipt returned by transfer") },
  },
  async ({ receipt }) => {
    const found = ledger.read().find((entry) => entry.receipt === receipt);
    if (!found) {
      return {
        content: [{ type: "text", text: `No transfer with receipt ${receipt}.` }],
        structuredContent: { status: "failed", reason: "unknown_receipt" },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(found) }],
      structuredContent: { status: "succeeded", transfer: found },
    };
  },
);

server.registerTool(
  "list_transfers",
  { description: "List transfers instructed in this sandbox.", inputSchema: {} },
  async () => {
    const transfers = ledger.read();
    return {
      content: [{ type: "text", text: JSON.stringify(transfers) }],
      structuredContent: { transfers },
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(`mock-bank: ready, ledger ${process.env["MOCK_BANK_LEDGER"] ?? "./bank-ledger.json"}\n`);
