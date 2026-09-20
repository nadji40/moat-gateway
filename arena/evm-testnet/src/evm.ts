// A real wallet on a real chain, kept narrow on purpose.
//
// This is the chain counterpart of stripe-sandbox: the mock arena measures,
// this demonstrates. It signs and broadcasts genuine transactions on Base
// Sepolia, a public testnet whose ether has no value, so that the states the
// outcome machine models -- submitted, confirmed, finalized -- come from a
// node and not from a mock I wrote. Nothing here is used by the arena runs.
//
// Three things it gets right that are easy to get wrong:
//
//   Idempotency is by signed bytes, not by intent. A transaction is signed
//   first, its hash is known from the signature, and the signed bytes are
//   written to disk under a key derived from the authorization and invoice
//   *before* they are broadcast. A retry after a lost response finds the
//   bytes and broadcasts the same ones again; the chain has one nonce for
//   them and will not mine them twice. Retrying by re-signing would produce
//   a second transaction with a second nonce, which is the double payment
//   the whole exercise is about.
//
//   Precision is refused, never rounded. An amount with more decimal places
//   than the asset has is an instruction the chain cannot carry out, and a
//   library that rounds it is hiding the unit confusion Moat exists to catch.
//
//   The chain is checked, not assumed. The node is asked for its chain id
//   at startup and the wallet refuses to run if it is not the one configured.
//   The network-substitution attack is about exactly this, and an adapter
//   that trusted its own config would be the thing it is meant to expose.
//
// What it is not: a control. It will send to any address it is asked to,
// because the arena's rule that the provider must not be the control holds
// for demonstrations too. The one limit it imposes -- MOAT_EVM_MAX_SEND --
// protects faucet ether from a runaway, and is documented as that.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/** The one chain this adapter knows. Named once, checked against the node. */
export const CHAIN = baseSepolia;
export const NETWORK = `eip155:${CHAIN.id}`;

// viem's client types carry the chain and the account in their generics, so
// the concrete clients are typed from the calls that make them rather than
// from the bare interfaces, which would not match.
const publicClientFor = (rpcUrl: string) =>
  createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
const walletClientFor = (rpcUrl: string, account: PrivateKeyAccount) =>
  createWalletClient({ account, chain: CHAIN, transport: http(rpcUrl) });

export interface Party {
  /** The label a payment is made under. Recorded, never verified. */
  payee: string;
  /** Checksummed. */
  address: Address;
}

export interface TokenConfig {
  symbol: string;
  address: Address;
  decimals: number;
}

export interface WalletConfig {
  rpcUrl: string;
  privateKey: Hex;
  authorized: Party;
  unauthorized: Party;
  /** A six-decimal test token, when one has been deployed. Optional: native ether needs nothing. */
  token?: TokenConfig;
  /** Where signed transactions are kept so a retry finds them. */
  stateDir: string;
  /** Blocks to wait before calling a transaction confirmed. */
  confirmations: number;
  /** Confirmations after which get_transaction reports finalized. */
  finality: number;
  /** Largest single send, in ether, as a guard on faucet funds. */
  maxSendEther: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required; see arena/evm-testnet/README.md`);
  return value;
}

function address(env: NodeJS.ProcessEnv, name: string): Address {
  const raw = required(env, name);
  if (!isAddress(raw)) throw new Error(`${name} is not an EVM address: ${raw}`);
  return getAddress(raw);
}

/** Read the wallet's configuration from the environment, refusing anything half-set. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WalletConfig {
  const key = required(env, "MOAT_EVM_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("MOAT_EVM_PRIVATE_KEY must be 0x followed by 64 hex characters");
  }
  const authorized: Party = {
    payee: env["MOAT_EVM_AUTHORIZED_PAYEE"]?.trim() || "Monitoring Pro Inc",
    address: address(env, "MOAT_EVM_AUTHORIZED_ADDRESS"),
  };
  const unauthorized: Party = {
    payee: env["MOAT_EVM_UNAUTHORIZED_PAYEE"]?.trim() || "ProMon Billing Ltd",
    address: address(env, "MOAT_EVM_UNAUTHORIZED_ADDRESS"),
  };
  if (authorized.address === unauthorized.address) {
    throw new Error("the authorized and unauthorized addresses must differ");
  }
  const tokenAddress = env["MOAT_EVM_TOKEN_ADDRESS"]?.trim();
  let token: TokenConfig | undefined;
  if (tokenAddress) {
    if (!isAddress(tokenAddress)) throw new Error("MOAT_EVM_TOKEN_ADDRESS is not an EVM address");
    const decimals = Number(env["MOAT_EVM_TOKEN_DECIMALS"] ?? "6");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error("MOAT_EVM_TOKEN_DECIMALS must be a whole number between 0 and 36");
    }
    token = {
      symbol: (env["MOAT_EVM_TOKEN_SYMBOL"]?.trim() || "USDC").toUpperCase(),
      address: getAddress(tokenAddress),
      decimals,
    };
  }
  const confirmations = Number(env["MOAT_EVM_CONFIRMATIONS"] ?? "1");
  const finality = Number(env["MOAT_EVM_FINALITY"] ?? "12");
  const maxSendEther = env["MOAT_EVM_MAX_SEND"]?.trim() || "0.001";
  checkAmount(maxSendEther, 18);
  return {
    rpcUrl: env["MOAT_EVM_RPC_URL"]?.trim() || CHAIN.rpcUrls.default.http[0],
    privateKey: key as Hex,
    authorized,
    unauthorized,
    ...(token ? { token } : {}),
    stateDir: env["MOAT_EVM_STATE_DIR"]?.trim() || join(process.cwd(), "state"),
    confirmations: Number.isInteger(confirmations) && confirmations >= 0 ? confirmations : 1,
    finality: Number.isInteger(finality) && finality >= 1 ? finality : 12,
    maxSendEther,
  };
}

/** The assets this wallet can move: ether always, the test token if configured. */
export function assetsOf(config: Pick<WalletConfig, "token">): { symbol: string; decimals: number }[] {
  return [{ symbol: "ETH", decimals: 18 }, ...(config.token ? [config.token] : [])];
}

/**
 * Validate an amount and convert it to base units exactly.
 *
 * Refuses exponent notation, signs, and any amount written with more
 * decimal places than the asset has. Rounding here would hide exactly the
 * unit confusion the arena exists to expose.
 */
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  const text = checkAmount(amount, decimals);
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** The validated decimal text of `amount`, or a thrown explanation. */
export function checkAmount(amount: string | number, decimals: number): string {
  const text = typeof amount === "number" ? String(amount) : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${JSON.stringify(amount)} is not a plain decimal amount`);
  }
  const fraction = text.includes(".") ? (text.split(".")[1] ?? "") : "";
  if (fraction.length > decimals) {
    throw new Error(`${text} has ${fraction.length} decimal places but the asset has ${decimals}`);
  }
  if (/^0+(\.0*)?$/.test(text)) throw new Error("amount must be greater than zero");
  return text;
}

/** What a retry needs to find: the bytes that were signed, and what they were for. */
export interface SentRecord {
  hash: Hex;
  /** The signed transaction, so a retry broadcasts the same bytes. */
  raw: Hex;
  to: Address;
  amount: string;
  asset: string;
  network: string;
  authorization_id: string;
  invoice_id: string;
  /** Whether the first broadcast attempt was known to reach the node. */
  broadcast: boolean;
  at: string;
}

/**
 * The idempotency map: one signed transaction per (sender, authorization,
 * invoice). File-backed and written before the broadcast, so the window in
 * which a crash could lose track of a signed transaction is closed.
 */
export class SentLedger {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "sent.json");
  }

  static key(sender: Address, authorizationId: string, invoiceId: string): string {
    return createHash("sha256")
      .update(`${sender.toLowerCase()} ${authorizationId} ${invoiceId}`)
      .digest("hex");
  }

  read(): Record<string, SentRecord> {
    if (!existsSync(this.path)) return {};
    const text = readFileSync(this.path, "utf8");
    return text.trim() === "" ? {} : (JSON.parse(text) as Record<string, SentRecord>);
  }

  get(key: string): SentRecord | undefined {
    return this.read()[key];
  }

  put(key: string, record: SentRecord): void {
    const all = this.read();
    all[key] = record;
    mkdirSync(join(this.path, ".."), { recursive: true });
    // Write-then-rename so a crash mid-write leaves the old file whole.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    renameSync(tmp, this.path);
  }

  /** Every record for an authorization, for reconciliation. */
  forAuthorization(authorizationId: string): SentRecord[] {
    return Object.values(this.read()).filter((r) => r.authorization_id === authorizationId);
  }
}

/** The vocabulary the gateway reads. See crates/moat-core/src/outcome.rs. */
export type ChainStatus = "submitted" | "confirmed" | "finalized" | "failed";

export interface TransactionView {
  hash: Hex;
  status: ChainStatus;
  confirmations: number;
  block: number | null;
  explorer_url: string;
}

export class Wallet {
  readonly account: PrivateKeyAccount;
  readonly publicClient: ReturnType<typeof publicClientFor>;
  readonly walletClient: ReturnType<typeof walletClientFor>;
  readonly sent: SentLedger;

  constructor(readonly config: WalletConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.publicClient = publicClientFor(config.rpcUrl);
    this.walletClient = walletClientFor(config.rpcUrl, this.account);
    this.sent = new SentLedger(config.stateDir);
  }

  get address(): Address {
    return this.account.address;
  }

  /**
   * Ask the node which chain it is, and refuse to proceed if it is not
   * ours. The right address on the wrong chain is one of the attacks; an
   * adapter that took its own configuration on trust would be a way in.
   */
  async assertChain(): Promise<number> {
    const id = await this.publicClient.getChainId();
    if (id !== CHAIN.id) {
      throw new Error(
        `${this.config.rpcUrl} is chain ${id}, not ${CHAIN.id} (${CHAIN.name}); refusing to sign`,
      );
    }
    return id;
  }

  /** The asset `symbol` names here, or a thrown list of what does exist. */
  asset(symbol: string): { symbol: string; decimals: number; token?: TokenConfig } {
    const want = symbol.trim().toUpperCase();
    if (want === "ETH") return { symbol: "ETH", decimals: 18 };
    if (this.config.token && this.config.token.symbol === want) {
      return { ...this.config.token, token: this.config.token };
    }
    throw new Error(
      `this wallet does not hold ${symbol}; it holds ${assetsOf(this.config)
        .map((a) => a.symbol)
        .join(", ")}`,
    );
  }

  async balances(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const parties: [string, Address][] = [
      ["sender", this.address],
      ["authorized", this.config.authorized.address],
      ["unauthorized", this.config.unauthorized.address],
    ];
    for (const [label, who] of parties) {
      const wei = await this.publicClient.getBalance({ address: who });
      out[`${label}.ETH`] = formatUnits(wei, 18);
      if (this.config.token) {
        const units = await this.publicClient.readContract({
          address: this.config.token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [who],
        });
        out[`${label}.${this.config.token.symbol}`] = formatUnits(units, this.config.token.decimals);
      }
    }
    return out;
  }

  /**
   * Send `amount` of `symbol` to `to`, exactly once per (authorization,
   * invoice), and say what the chain says about it.
   */
  async send(input: {
    to: string;
    symbol: string;
    amount: string | number;
    authorization_id: string;
    invoice_id: string;
    wait?: boolean;
  }): Promise<{ record: SentRecord; view: TransactionView; replayed: boolean }> {
    if (!isAddress(input.to)) throw new Error(`${input.to} is not an EVM address`);
    const to = getAddress(input.to);
    const asset = this.asset(input.symbol);
    const units = toBaseUnits(input.amount, asset.decimals);
    if (asset.symbol === "ETH" && units > toBaseUnits(this.config.maxSendEther, 18)) {
      throw new Error(
        `${input.amount} ETH is above MOAT_EVM_MAX_SEND (${this.config.maxSendEther}); ` +
          "this guards faucet funds and is not a policy",
      );
    }
    if (!input.authorization_id.trim()) throw new Error("authorization_id is required");
    if (!input.invoice_id.trim()) throw new Error("invoice_id is required");

    const key = SentLedger.key(this.address, input.authorization_id, input.invoice_id);
    const existing = this.sent.get(key);
    if (existing) {
      // The same instruction again. Broadcast the same signed bytes -- if
      // the node already has them it says so, and either way there is one
      // transaction with this nonce.
      await this.rebroadcast(existing);
      return { record: existing, view: await this.view(existing.hash, input.wait), replayed: true };
    }

    const request = await this.walletClient.prepareTransactionRequest({
      account: this.account,
      chain: CHAIN,
      ...(asset.token
        ? {
            to: asset.token.address,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [to, units],
            }),
          }
        : { to, value: units }),
    });
    const raw = await this.walletClient.signTransaction(request);
    const hash = keccak256(raw);
    const record: SentRecord = {
      hash,
      raw,
      to,
      amount: checkAmount(input.amount, asset.decimals),
      asset: asset.symbol,
      network: NETWORK,
      authorization_id: input.authorization_id,
      invoice_id: input.invoice_id,
      broadcast: false,
      at: new Date().toISOString(),
    };
    // On disk before it is on the wire. If the process dies between these
    // two lines, the retry finds the bytes and broadcasts them; it never
    // signs a second transaction for the same invoice.
    this.sent.put(key, record);
    await this.publicClient.sendRawTransaction({ serializedTransaction: raw });
    this.sent.put(key, { ...record, broadcast: true });
    return { record, view: await this.view(hash, input.wait), replayed: false };
  }

  private async rebroadcast(record: SentRecord): Promise<void> {
    try {
      await this.publicClient.sendRawTransaction({ serializedTransaction: record.raw });
    } catch (error) {
      // "already known", "nonce too low" and their relatives all mean the
      // chain has these bytes. Anything else is worth hearing about.
      const message = String((error as Error).message ?? error).toLowerCase();
      if (!/already known|nonce too low|already imported|known transaction|replacement/.test(message)) {
        throw error;
      }
    }
  }

  /** What the chain currently says about `hash`. */
  async view(hash: Hex, wait = true): Promise<TransactionView> {
    const explorer_url = `${CHAIN.blockExplorers.default.url}/tx/${hash}`;
    if (wait && this.config.confirmations > 0) {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: this.config.confirmations,
      });
      const head = await this.publicClient.getBlockNumber();
      const confirmations = Number(head - receipt.blockNumber) + 1;
      return {
        hash,
        status: receipt.status === "reverted" ? "failed" : this.settle(confirmations),
        confirmations,
        block: Number(receipt.blockNumber),
        explorer_url,
      };
    }
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      const head = await this.publicClient.getBlockNumber();
      const confirmations = Number(head - receipt.blockNumber) + 1;
      return {
        hash,
        status: receipt.status === "reverted" ? "failed" : this.settle(confirmations),
        confirmations,
        block: Number(receipt.blockNumber),
        explorer_url,
      };
    } catch {
      return { hash, status: "submitted", confirmations: 0, block: null, explorer_url };
    }
  }

  private settle(confirmations: number): ChainStatus {
    return confirmations >= this.config.finality ? "finalized" : "confirmed";
  }
}
