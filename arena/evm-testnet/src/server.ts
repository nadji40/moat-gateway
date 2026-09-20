// The wallet as an MCP server, for the gateway to sit in front of.
//
// Same argument names as the arena's mock wallet -- counterparty, to_address,
// token, amount, network -- so policies/rails/evm-testnet.yaml is the arena
// policy with the address book taken out, and a verdict here is reached by
// the same code path as a verdict in the measurement.
//
// It checks the node is the chain it thinks it is before it will sign
// anything, and refuses an instruction for any other network. That refusal
// is a fact about the wallet, not a control: this wallet has one key on one
// chain. The control is Moat, in front of it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assetsOf, CHAIN, configFromEnv, NETWORK, Wallet } from "./evm.js";

const wallet = new Wallet(configFromEnv());
const chainId = await wallet.assertChain();

const server = new McpServer({ name: "evm-testnet", version: "0.1.0" });

const Amount = z.union([z.string().min(1), z.number().positive()]);

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
      `Send ${assetsOf(wallet.config).map((a) => a.symbol).join(" or ")} from this wallet to an ` +
      `address on ${CHAIN.name} (${NETWORK}). A real transaction on a public testnet: the ether ` +
      "has no value, the transaction is permanent. Returns the transaction hash.",
    inputSchema: {
      counterparty: z
        .string()
        .describe("Who the address is believed to belong to. A label: the chain does not check it"),
      to_address: z.string().describe("Destination address"),
      token: z
        .string()
        .default("ETH")
        .describe(`Asset symbol: ${assetsOf(wallet.config).map((a) => a.symbol).join(" or ")}`),
      amount: Amount.describe('Amount in whole units, e.g. "0.0001"'),
      network: z.string().default(NETWORK).describe(`CAIP-2 network id; this wallet is on ${NETWORK}`),
      reference: z.string().min(1).optional().describe("Memo, recorded locally"),
      authorization_id: z.string().min(1).describe("Moat payment authorization id"),
      invoice_id: z.string().min(1).describe("Supplier invoice id"),
      invoice_fingerprint: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional()
        .describe("Canonical invoice SHA-256"),
      wait: z
        .boolean()
        .default(true)
        .describe("Wait for the configured confirmations before answering"),
      simulate_response_loss: z
        .boolean()
        .default(false)
        .describe("Test-only: fail after the transaction is broadcast, as a dropped RPC reply would"),
    },
  },
  async (args) => {
    if (args.network.trim().toLowerCase() !== NETWORK) {
      return refuse(
        `This wallet is on ${NETWORK} and cannot send on ${args.network}.`,
        "unknown_network",
      );
    }
    let sent;
    try {
      sent = await wallet.send({
        to: args.to_address,
        symbol: args.token,
        amount: args.amount,
        authorization_id: args.authorization_id,
        invoice_id: args.invoice_id,
        wait: args.wait,
      });
    } catch (error) {
      return refuse(`Send refused: ${(error as Error).message}`, "rejected");
    }
    if (args.simulate_response_loss) {
      // The transaction is signed, on disk and broadcast. The caller hears
      // nothing, which is what a timed-out RPC call sounds like.
      throw new Error("simulated response loss after the transaction was broadcast");
    }
    const { record, view, replayed } = sent;
    return {
      content: [
        {
          type: "text",
          text:
            `${replayed ? "Already sent" : "Sent"}: ${record.amount} ${record.asset} to ${record.to} ` +
            `on ${NETWORK}. Status ${view.status}` +
            `${view.confirmations ? ` (${view.confirmations} confirmation(s))` : ""}. ` +
            `Receipt ${record.hash}. ${view.explorer_url}`,
        },
      ],
      structuredContent: {
        status: view.status,
        receipt: record.hash,
        tx_hash: record.hash,
        network: NETWORK,
        destination: record.to.toLowerCase(),
        destination_display: record.to,
        counterparty: args.counterparty,
        counterparty_verified: false,
        amount: record.amount,
        currency: record.asset,
        confirmations: view.confirmations,
        block: view.block,
        explorer_url: view.explorer_url,
        replayed,
        authorization_id: record.authorization_id,
        invoice_id: record.invoice_id,
        ...(args.reference ? { reference: args.reference } : {}),
      },
    };
  },
);

server.registerTool(
  "get_transaction",
  {
    description: "What the chain currently says about a transaction hash.",
    inputSchema: {
      receipt: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("Transaction hash returned by send"),
    },
  },
  async ({ receipt }) => {
    const view = await wallet.view(receipt as `0x${string}`, false);
    return {
      content: [{ type: "text", text: JSON.stringify(view) }],
      structuredContent: { status: "succeeded", transaction: view },
    };
  },
);

server.registerTool(
  "balances",
  { description: "Balances of the sender and the two configured counterparties.", inputSchema: {} },
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
    description: "The wallet's address, chain, assets and whether it is funded. Nothing that signs.",
    inputSchema: {},
  },
  async () => {
    const balances = await wallet.balances();
    const funded = Number(balances["sender.ETH"] ?? "0") > 0;
    const summary = {
      address: wallet.address,
      network: NETWORK,
      chain_id: chainId,
      chain: CHAIN.name,
      rpc: wallet.config.rpcUrl,
      assets: assetsOf(wallet.config),
      authorized: wallet.config.authorized,
      unauthorized: wallet.config.unauthorized,
      confirmations: wallet.config.confirmations,
      max_send_ether: wallet.config.maxSendEther,
      state_dir: wallet.config.stateDir,
      funded,
      explorer_url: `${CHAIN.blockExplorers.default.url}/address/${wallet.address}`,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary) }],
      structuredContent: { ...summary },
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `evm-testnet: ${wallet.address} on ${CHAIN.name} (${NETWORK}), state ${wallet.config.stateDir}\n`,
);
