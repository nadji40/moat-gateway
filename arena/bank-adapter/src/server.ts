// The bank adapter as an MCP server, for the gateway to sit in front of.
//
// Same argument names as the arena's mock bank -- beneficiary_name, iban,
// amount, currency, reference -- so policies/rails/bank-adapter.yaml is the
// arena bank policy with the address book taken out, and a verdict here is
// reached by the same code as a verdict in the measurement.
//
// It is a provider, not a control. It sends to any account the institution
// can reach and refuses only accounts it cannot, which is what a bank does:
// a bank does not know whether you meant to pay that supplier. The control
// is Moat, in front of it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { BankProvider } from "./contract.js";
import { moatStatus } from "./contract.js";
import { idempotencyKey } from "./idempotency.js";
import { configFromEnv, ReferenceBank } from "./providers/reference.js";

const config = configFromEnv();
const bank: BankProvider = new ReferenceBank(config);

const server = new McpServer({ name: "bank-adapter", version: "0.1.0" });

function refuse(text: string, reason: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { status: "failed", reason },
    isError: true,
  };
}

server.registerTool(
  "transfer",
  {
    description:
      `Instruct a bank transfer through ${bank.id}. Accepted, not settled: the transfer ` +
      "moves through pending, submitted and settled over time, and may later be returned. " +
      "Returns the provider's reference.",
    inputSchema: {
      beneficiary_name: z.string().describe("The name on the invoice"),
      iban: z.string().describe("Destination IBAN"),
      amount: z.union([z.string().min(1), z.number().positive()]).describe("Amount in major units"),
      currency: z.string().describe("ISO 4217 code"),
      reference: z.string().describe("What the beneficiary sees on their statement"),
      authorization_id: z.string().optional(),
      invoice_id: z.string().optional(),
      invoice_fingerprint: z.string().optional(),
      simulate_response_loss: z
        .boolean()
        .default(false)
        .describe("Test-only: fail after the transfer is accepted, as a dropped reply would"),
    },
  },
  async (args) => {
    const key = idempotencyKey(args.iban, args.authorization_id ?? "", args.invoice_id ?? "");
    let result;
    try {
      result = await bank.createTransfer(
        {
          beneficiaryName: args.beneficiary_name,
          iban: args.iban,
          amount: String(args.amount),
          currency: args.currency,
          reference: args.reference,
          moat: {
            ...(args.authorization_id ? { authorizationId: args.authorization_id } : {}),
            ...(args.invoice_id ? { invoiceId: args.invoice_id } : {}),
          },
        },
        key,
      );
    } catch (error) {
      return refuse(`Transfer refused: ${(error as Error).message}`, "rejected");
    }
    if (args.simulate_response_loss) {
      // Accepted by the bank, and the caller hears nothing. This is the
      // state that makes a bank rail different from a card: the money may
      // be on its way and retrying blindly sends it twice.
      throw new Error("simulated response loss after the bank accepted the transfer");
    }
    const payload = {
      status: moatStatus(result.state),
      receipt: result.reference,
      destination: result.iban,
      amount: result.amount,
      currency: result.currency,
      reference: args.reference,
      beneficiary_match: result.beneficiaryMatch,
      replayed: result.replayed,
      provider: bank.id,
      ...(result.fee ? { fee: result.fee, fee_currency: result.feeCurrency } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "get_transfer",
  {
    description: "Where a transfer has got to, by the provider's reference.",
    inputSchema: { reference: z.string() },
  },
  async (args) => {
    try {
      const status = await bank.getTransfer(args.reference);
      const payload = { ...status, status: moatStatus(status.state), provider: bank.id };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    } catch (error) {
      return refuse((error as Error).message, "not_found");
    }
  },
);

server.registerTool(
  "list_transfers",
  { description: "Every transfer this provider knows of, oldest first.", inputSchema: {} },
  async () => {
    const transfers = await bank.listTransfers();
    return {
      content: [{ type: "text", text: JSON.stringify(transfers) }],
      structuredContent: { transfers },
    };
  },
);

server.registerTool(
  "verify_payee",
  {
    description:
      "Confirmation of Payee: whether the name on the invoice is the name on the account. " +
      "A close match is not a match.",
    inputSchema: { iban: z.string(), beneficiary_name: z.string() },
  },
  async (args) => {
    if (!bank.verifyPayee) return refuse("this provider has no name check", "unavailable");
    try {
      const check = await bank.verifyPayee(args.iban, args.beneficiary_name);
      return {
        content: [{ type: "text", text: JSON.stringify(check) }],
        structuredContent: { ...check },
      };
    } catch (error) {
      return refuse((error as Error).message, "rejected");
    }
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `bank-adapter: ${bank.id}, ${config.accounts.length} accounts, state ${config.stateDir}\n`,
);
