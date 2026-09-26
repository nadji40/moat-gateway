// The Solana wallet as an MCP server, for the gateway to sit in front of.
//
// Same argument names as the arena's mock wallet on the solana rail --
// counterparty, to_address, token, amount, network -- so
// policies/rails/solana-devnet.yaml is the arena policy with the address
// book taken out, and a verdict here is reached by the same code path as a
// verdict in the measurement.
//
// It refuses any cluster but devnet before it will sign. That refusal is a
// fact about the wallet, not a control: this wallet has one key on one
// cluster. The control is Moat, in front of it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  accountUrl,
  configFromEnv,
  fromBaseUnits,
  NETWORK,
  SOL_DECIMALS,
  Wallet,
} from "./solana.js";

const wallet = new Wallet(configFromEnv());
const genesis = await wallet.assertCluster();

const server = new McpServer({ name: "solana-devnet", version: "0.1.0" });

function refuse(text: string, reason: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { status: "failed", reason },
    isError: true,
  };
}

server.registerTool(
  "send",
  {
    description:
      `Send SOL from this wallet to an address on Solana devnet (${NETWORK}). A real ` +
      "transaction on a public cluster: the SOL has no value, the transaction is permanent. " +
      "Returns the signature.",
    inputSchema: {
      counterparty: z
        .string()
        .optional()
        .describe("Who the address is believed to belong to. Optional, and a label: the chain does not check it"),
      to_address: z.string().describe("Destination address, base58"),
      token: z.string().default("SOL").describe("Asset symbol; this wallet moves SOL"),
      amount: z.union([z.string().min(1), z.number().positive()]).describe("Amount in whole SOL"),
      network: z.string().optional().describe(`CAIP-2 network; must be ${NETWORK}`),
      authorization_id: z.string().optional(),
      invoice_id: z.string().optional(),
      invoice_fingerprint: z.string().optional(),
      wait: z.boolean().default(true).describe("Wait for confirmation before answering"),
      simulate_response_loss: z
        .boolean()
        .default(false)
        .describe("Test-only: fail after the transaction is broadcast, as a dropped reply would"),
    },
  },
  async (args) => {
    if (args.network && args.network.trim() !== NETWORK) {
      return refuse(
        `This wallet is on ${NETWORK} and was asked for ${args.network}.`,
        "wrong_network",
      );
    }
    if (args.token.trim().toUpperCase() !== "SOL") {
      return refuse(`This wallet moves SOL, not ${args.token}.`, "unknown_asset");
    }
    let sent;
    try {
      sent = await wallet.send({
        to: args.to_address,
        amount: args.amount,
        ...(args.authorization_id ? { authorizationId: args.authorization_id } : {}),
        ...(args.invoice_id ? { invoiceId: args.invoice_id } : {}),
      });
    } catch (error) {
      return refuse(`Send refused: ${(error as Error).message}`, "rejected");
    }
    if (args.simulate_response_loss) {
      // Signed, on disk and broadcast. The caller hears nothing, which is
      // what a timed-out RPC call sounds like.
      throw new Error("simulated response loss after the transaction was broadcast");
    }
    const view = args.wait ? await wallet.view(sent.record.signature, true) : sent.view;
    const payload = {
      status: view.status === "failed" ? "failed" : view.status,
      receipt: sent.record.signature,
      to_address: sent.record.to,
      amount: sent.record.amount,
      currency: "SOL",
      network: NETWORK,
      slot: view.slot,
      replayed: sent.replayed,
      explorer_url: view.explorer_url,
      counterparty_verified: false,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "get_transaction",
  {
    description: "What the cluster says about a signature now.",
    inputSchema: { signature: z.string(), wait: z.boolean().default(false) },
  },
  async (args) => {
    const view = await wallet.view(args.signature, args.wait);
    return {
      content: [{ type: "text", text: JSON.stringify(view) }],
      structuredContent: { ...view },
    };
  },
);

server.registerTool(
  "balances",
  { description: "What the sender and the two counterparties hold.", inputSchema: {} },
  async () => {
    const balances = await wallet.balances();
    return {
      content: [{ type: "text", text: JSON.stringify(balances) }],
      structuredContent: { balances },
    };
  },
);

server.registerTool(
  "inspect_wallet",
  {
    description: "The address, the cluster the node actually returned, and whether it is funded.",
    inputSchema: {},
  },
  async () => {
    const lamports = await wallet.balanceLamports();
    const summary = {
      address: wallet.address,
      network: NETWORK,
      genesis,
      authorized: wallet.config.authorized,
      unauthorized: wallet.config.unauthorized,
      nonce_account: wallet.config.nonceAccount ?? null,
      max_send_sol: wallet.config.maxSendSol,
      state_dir: wallet.config.stateDir,
      balance_sol: fromBaseUnits(lamports, SOL_DECIMALS),
      funded: lamports > 0n,
      explorer_url: accountUrl(wallet.address),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary) }],
      structuredContent: { ...summary },
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `solana-devnet: ${wallet.address} on ${NETWORK}, state ${wallet.config.stateDir}\n`,
);
