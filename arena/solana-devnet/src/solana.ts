// A real wallet on Solana devnet, kept narrow on purpose.
//
// The sibling of evm-testnet, for the other chain family. Same claim, same
// shape, and one genuinely different problem underneath.
//
// **Idempotency on Solana is not the same problem as on an EVM chain.** An
// EVM transaction carries a nonce that increments per account, so signing
// once and rebroadcasting the same bytes is exactly safe: the chain has one
// nonce for them and will mine them once. A Solana transaction instead
// carries a recent blockhash, which expires after about 150 slots -- a
// minute or two. Inside that window rebroadcasting is safe, because the
// cluster dedupes by signature. Outside it the transaction can never land,
// and a retry has to re-sign with a fresh blockhash, which produces a
// *different* signature. If the first one did land and the reply was lost,
// that retry pays twice. Which is the failure this whole exercise is about.
//
// The answer the chain provides is a durable nonce account: the transaction
// carries a stored nonce instead of a blockhash, and that nonce only
// advances when the transaction is processed. A signed transaction stays
// valid indefinitely and can be landed exactly once, ever. So every
// transfer here is built on a durable nonce, and the retry path rebroadcasts
// the same signed bytes the way the EVM adapter does.
//
// **Precision is refused, never rounded**, as on the EVM side: an amount
// with more decimal places than the asset has is an instruction the chain
// cannot carry out.
//
// **The cluster is checked, not assumed.** The genesis hash is read and
// compared against devnet's, so a wallet pointed at mainnet by a stray
// environment variable refuses to run rather than spending real money.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** CAIP-2 for Solana devnet, the identifier the arena and policies use. */
export const NETWORK = "solana:devnet";
/** Devnet's genesis hash. What the cluster must say it is. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** The SPL Memo program, for carrying Moat's identifiers on chain. */
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Lamports per SOL, and SOL's exponent. */
export const SOL_DECIMALS = 9;

export interface Party {
  readonly address: string;
  readonly payee: string;
}

export interface WalletConfig {
  readonly rpcUrl: string;
  readonly secretKey: Uint8Array;
  readonly authorized: Party;
  readonly unauthorized: Party;
  /** The durable nonce account this wallet signs against, once created. */
  readonly nonceAccount?: string;
  /** Largest single send in SOL. A guard on airdropped funds, not a policy. */
  readonly maxSendSol: string;
  readonly stateDir: string;
}

/**
 * Where signed transactions are kept when nothing says otherwise.
 *
 * Anchored to this package rather than the working directory, for the
 * reason the EVM adapter learned the hard way: the wallet runs as a child
 * of the gateway and inherits its directory, while the smoke script that
 * audits the same ledger runs from here.
 */
export function defaultStateDir(): string {
  return join(PACKAGE_ROOT, "state");
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WalletConfig {
  const secret = env["MOAT_SOLANA_SECRET_KEY"]?.trim();
  if (!secret) {
    throw new Error(
      "MOAT_SOLANA_SECRET_KEY is not set; run `pnpm --filter @moat/solana-devnet keygen`",
    );
  }
  const party = (prefix: string): Party => {
    const address = env[`MOAT_SOLANA_${prefix}_ADDRESS`]?.trim();
    if (!address) throw new Error(`MOAT_SOLANA_${prefix}_ADDRESS is not set`);
    // Parsing is the validation: PublicKey refuses anything that is not
    // 32 bytes of base58.
    new PublicKey(address);
    return { address, payee: env[`MOAT_SOLANA_${prefix}_PAYEE`]?.trim() || prefix.toLowerCase() };
  };
  const maxSendSol = env["MOAT_SOLANA_MAX_SEND"]?.trim() || "0.01";
  checkAmount(maxSendSol, SOL_DECIMALS);
  return {
    rpcUrl: env["MOAT_SOLANA_RPC_URL"]?.trim() || "https://api.devnet.solana.com",
    secretKey: decodeSecret(secret),
    authorized: party("AUTHORIZED"),
    unauthorized: party("UNAUTHORIZED"),
    ...(env["MOAT_SOLANA_NONCE_ACCOUNT"]?.trim()
      ? { nonceAccount: env["MOAT_SOLANA_NONCE_ACCOUNT"].trim() }
      : {}),
    maxSendSol,
    stateDir: env["MOAT_SOLANA_STATE_DIR"]?.trim() || defaultStateDir(),
  };
}

/** A 64-byte secret key, as JSON array or base64. */
export function decodeSecret(text: string): Uint8Array {
  const trimmed = text.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed) as number[])
    : Uint8Array.from(Buffer.from(trimmed, "base64"));
  if (bytes.length !== 64) throw new Error(`a Solana secret key is 64 bytes, got ${bytes.length}`);
  return bytes;
}

/**
 * Refuse an amount the asset cannot carry.
 *
 * Never rounds. A library that quietly rounds 0.0000000001 SOL to zero, or
 * seven decimal places of a six-decimal token to six, is hiding exactly the
 * unit confusion Moat exists to catch.
 */
export function checkAmount(amount: string | number, decimals: number): void {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${text} is not a plain decimal amount`);
  }
  const places = text.includes(".") ? (text.split(".")[1] ?? "").length : 0;
  if (places > decimals) {
    throw new Error(`${text} has ${places} decimal places; this asset has ${decimals}`);
  }
  if (Number(text) <= 0) throw new Error("amount must be greater than zero");
}

/** Whole units to base units, exactly, without floating point. */
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  checkAmount(amount, decimals);
  const text = String(amount).trim();
  const [whole, fraction = ""] = text.split(".");
  return BigInt((whole ?? "0") + fraction.padEnd(decimals, "0"));
}

/** Base units back to a decimal string, for reporting. */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export interface SentRecord {
  /** The transaction signature, known from signing and before broadcast. */
  signature: string;
  to: string;
  amount: string;
  asset: string;
  network: string;
  authorization_id: string;
  invoice_id: string;
  /** The signed transaction, base64, so a retry rebroadcasts these bytes. */
  raw: string;
  broadcast: boolean;
  at: string;
}

/**
 * What this wallet has signed, on disk, keyed by what identifies a payment.
 *
 * The same design as the EVM adapter's: sign, write, then broadcast. A
 * retry finds the bytes and sends the identical transaction, which the
 * cluster dedupes by signature and the durable nonce makes landable exactly
 * once whenever it arrives.
 */
export class SentLedger {
  private readonly path: string;

  constructor(private readonly stateDir: string) {
    this.path = join(stateDir, "sent.json");
  }

  static key(sender: string, authorizationId: string, invoiceId: string): string {
    return createHash("sha256")
      .update(`${sender}\0${authorizationId}\0${invoiceId}`)
      .digest("hex");
  }

  read(): Record<string, SentRecord> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, SentRecord>;
  }

  get(key: string): SentRecord | undefined {
    return this.read()[key];
  }

  put(key: string, record: SentRecord): void {
    mkdirSync(this.stateDir, { recursive: true });
    const entries = this.read();
    entries[key] = record;
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }

  forAuthorization(authorizationId: string): SentRecord[] {
    return Object.values(this.read()).filter((r) => r.authorization_id === authorizationId);
  }
}

export type ChainStatus = "submitted" | "confirmed" | "finalized" | "failed";

export interface TransactionView {
  signature: string;
  status: ChainStatus;
  slot: number | null;
  explorer_url: string;
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function accountUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

/** The wallet. Signs and broadcasts genuine devnet transactions. */
export class Wallet {
  readonly keypair: Keypair;
  readonly connection: Connection;
  private readonly sent: SentLedger;

  constructor(readonly config: WalletConfig) {
    this.keypair = Keypair.fromSecretKey(config.secretKey);
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.sent = new SentLedger(config.stateDir);
  }

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Refuse to run against anything but devnet.
   *
   * The genesis hash is the cluster's identity and cannot be spoofed by a
   * misconfigured URL the way a self-reported name could.
   */
  async assertCluster(): Promise<string> {
    const genesis = await this.connection.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) {
      throw new Error(
        `this endpoint is cluster ${genesis}, not devnet (${DEVNET_GENESIS}); refusing to sign`,
      );
    }
    return genesis;
  }

  async balanceLamports(address = this.address): Promise<bigint> {
    return BigInt(await this.connection.getBalance(new PublicKey(address)));
  }

  async balances(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [label, address] of [
      ["sender", this.address],
      ["authorized", this.config.authorized.address],
      ["unauthorized", this.config.unauthorized.address],
    ] as const) {
      out[`${label}.SOL`] = fromBaseUnits(await this.balanceLamports(address), SOL_DECIMALS);
    }
    return out;
  }

  /** The durable nonce this wallet signs against, and its current value. */
  async nonce(): Promise<{ account: PublicKey; nonce: string }> {
    if (!this.config.nonceAccount) {
      throw new Error(
        "no durable nonce account; run `pnpm --filter @moat/solana-devnet fund` to create one",
      );
    }
    const account = new PublicKey(this.config.nonceAccount);
    const info = await this.connection.getAccountInfo(account);
    if (!info) throw new Error(`nonce account ${account.toBase58()} does not exist on devnet`);
    const parsed = NonceAccount.fromAccountData(info.data);
    if (parsed.authorizedPubkey.toBase58() !== this.address) {
      throw new Error("this wallet is not the authority on that nonce account");
    }
    return { account, nonce: parsed.nonce };
  }

  /**
   * Send SOL, exactly once per (authorization, invoice).
   *
   * Signed first, written to disk second, broadcast third. A retry finds
   * the bytes and rebroadcasts them: the durable nonce keeps them valid and
   * lets them land exactly once, whenever they arrive.
   */
  async send(input: {
    to: string;
    amount: string | number;
    authorizationId?: string;
    invoiceId?: string;
    memo?: string;
  }): Promise<{ record: SentRecord; view: TransactionView; replayed: boolean }> {
    const lamports = toBaseUnits(input.amount, SOL_DECIMALS);
    const max = toBaseUnits(this.config.maxSendSol, SOL_DECIMALS);
    if (lamports > max) {
      throw new Error(`${input.amount} SOL exceeds this wallet's ${this.config.maxSendSol} cap`);
    }
    const to = new PublicKey(input.to);
    const key = SentLedger.key(this.address, input.authorizationId ?? "", input.invoiceId ?? "");

    const existing = this.sent.get(key);
    if (existing) {
      // The same bytes, again. Not a new transaction.
      await this.broadcast(existing.raw);
      return { record: existing, view: await this.view(existing.signature, false), replayed: true };
    }

    // Solana will not leave an account below the rent-exempt minimum, so a
    // transfer that would create one with dust fails in simulation with a
    // message about account index 2. There is no equivalent on an EVM
    // chain, where an address costs nothing to exist, and it is the first
    // thing anyone plugging in Solana hits. Say it plainly and early.
    const rentExempt = BigInt(await this.connection.getMinimumBalanceForRentExemption(0));
    const held = await this.balanceLamports(input.to);
    if (held + lamports < rentExempt) {
      throw new Error(
        `${input.amount} SOL would leave ${input.to} below the rent-exempt minimum of ` +
          `${fromBaseUnits(rentExempt, SOL_DECIMALS)} SOL; it holds ` +
          `${fromBaseUnits(held, SOL_DECIMALS)}. Send at least ` +
          `${fromBaseUnits(rentExempt - held, SOL_DECIMALS)} SOL, or fund the account first.`,
      );
    }

    const { account, nonce } = await this.nonce();
    const transaction = new Transaction();
    // The nonce advance must be the first instruction; that is what makes
    // the stored nonce, rather than a recent blockhash, the transaction's
    // lifetime.
    transaction.add(
      SystemProgram.nonceAdvance({
        noncePubkey: account,
        authorizedPubkey: this.keypair.publicKey,
      }),
    );
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: to,
        lamports,
      }),
    );
    const memo = input.memo ?? moatMemo(input.authorizationId, input.invoiceId);
    if (memo) {
      transaction.add(
        new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo) }),
      );
    }
    transaction.recentBlockhash = nonce;
    transaction.feePayer = this.keypair.publicKey;
    transaction.sign(this.keypair);
    const signature = transaction.signature;
    if (!signature) throw new Error("signing produced no signature");
    const raw = transaction.serialize().toString("base64");
    const record: SentRecord = {
      signature: bs58Encode(signature),
      to: input.to,
      amount: String(input.amount),
      asset: "SOL",
      network: NETWORK,
      authorization_id: input.authorizationId ?? "",
      invoice_id: input.invoiceId ?? "",
      raw,
      broadcast: false,
      at: new Date().toISOString(),
    };
    // On disk before the wire. A crash between these two lines leaves a
    // record of a transaction that may or may not have landed, which is
    // recoverable; the other order leaves a payment nobody can find.
    this.sent.put(key, record);
    await this.broadcast(raw);
    const stored = { ...record, broadcast: true };
    this.sent.put(key, stored);
    return { record: stored, view: await this.view(stored.signature, true), replayed: false };
  }

  private async broadcast(raw: string): Promise<void> {
    try {
      await this.connection.sendEncodedTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
    } catch (error) {
      // A transaction the cluster has already seen is not a failure: it is
      // the retry path working. Anything else is real.
      const text = String(error);
      if (!/already been processed|AlreadyProcessed/i.test(text)) throw error;
    }
  }

  async view(signature: string, wait = true): Promise<TransactionView> {
    const explorer_url = explorerUrl(signature);
    const deadline = Date.now() + (wait ? 60_000 : 0);
    for (;;) {
      const statuses = await this.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = statuses.value[0];
      if (status) {
        if (status.err) return { signature, status: "failed", slot: status.slot, explorer_url };
        const level = status.confirmationStatus ?? "processed";
        const mapped: ChainStatus =
          level === "finalized" ? "finalized" : level === "confirmed" ? "confirmed" : "submitted";
        if (mapped !== "submitted" || !wait || Date.now() > deadline) {
          return { signature, status: mapped, slot: status.slot, explorer_url };
        }
      } else if (!wait || Date.now() > deadline) {
        return { signature, status: "submitted", slot: null, explorer_url };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * Moat's identifiers, for the memo program.
 *
 * On chain and readable, so a statement line can be matched to a verdict
 * later. The memo is not a control: anybody can write anything there.
 */
export function moatMemo(authorizationId?: string, invoiceId?: string): string | undefined {
  const parts: string[] = [];
  if (authorizationId) parts.push(`auth=${authorizationId}`);
  if (invoiceId) parts.push(`inv=${invoiceId}`);
  return parts.length > 0 ? `moat:${parts.join(";")}` : undefined;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58, for turning a raw signature into the string explorers use. */
export function bs58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = B58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out === "" ? "1" : out;
}

export { LAMPORTS_PER_SOL, NONCE_ACCOUNT_LENGTH };
