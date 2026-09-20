// Ask devnet for money, and build the durable nonce account.
//
//   pnpm --filter @moat/solana-devnet fund
//
// Devnet has an airdrop RPC, so in principle the cluster funds itself with
// no faucet page and no human. In practice the public endpoint at
// api.devnet.solana.com rate-limits hard, per address and per IP, and
// answers 429 or a bare "Internal error" for long stretches. So this tries,
// then tells you exactly what to do by hand, rather than pretending the
// airdrop is reliable. It is idempotent: run it again once there are funds
// and it picks up where it stopped.
//
// The nonce account is the part that matters. A Solana transaction normally
// carries a recent blockhash and expires in a minute or two, which makes a
// retry after a lost reply unsafe: re-signing produces a different
// signature, and if the first one landed the supplier is paid twice. A
// durable nonce replaces the blockhash with a stored value that only
// advances when the transaction is processed, so one signed transaction
// stays valid indefinitely and lands exactly once, ever.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { accountUrl, configFromEnv, fromBaseUnits, SOL_DECIMALS, Wallet } from "./solana.js";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const ENV_PATH = join(REPO_ROOT, ".env.solana-devnet");
/** Enough for rent on the nonce account plus a few hundred transfers. */
const WANTED_SOL = 2;
/** Below this there is not enough for rent plus fees, so stop and say so. */
const MINIMUM_LAMPORTS = BigInt(0.05 * LAMPORTS_PER_SOL);

const NEWLINE = String.fromCharCode(10);

async function main(): Promise<void> {
  const config = configFromEnv();
  const wallet = new Wallet(config);
  await wallet.assertCluster();
  process.stderr.write(`sender ${wallet.address} on Solana devnet${NEWLINE}`);

  let lamports = await wallet.balanceLamports();
  if (lamports < MINIMUM_LAMPORTS) {
    // Smaller asks are refused less often, so work downwards.
    let refusal = "";
    for (const sol of [WANTED_SOL, 1, 0.5]) {
      process.stderr.write(`requesting an airdrop of ${sol} SOL...${NEWLINE}`);
      try {
        const signature = await wallet.connection.requestAirdrop(
          wallet.keypair.publicKey,
          Math.round(sol * LAMPORTS_PER_SOL),
        );
        await wallet.connection.confirmTransaction(signature, "confirmed");
        break;
      } catch (error) {
        refusal = (error as Error).message.split(NEWLINE)[0] ?? "refused";
        process.stderr.write(`  refused: ${refusal}${NEWLINE}`);
      }
    }
    lamports = await wallet.balanceLamports();
    if (lamports < MINIMUM_LAMPORTS) {
      throw new Error(
        [
          `the devnet airdrop is not giving anything out right now: ${refusal}`,
          "",
          "It rate-limits per address and per IP, and has long stretches of",
          "answering 429 or a bare internal error. Two ways on:",
          "",
          "  1. Paste the address at https://faucet.solana.com/ and pick devnet.",
          "     It wants a GitHub login, which is the one step nobody can do for you.",
          "  2. Wait and run this again. It is idempotent.",
          "",
          `  address:  ${wallet.address}`,
          `  explorer: ${accountUrl(wallet.address)}`,
          "",
          "Half a SOL is plenty: the nonce account costs about 0.0015 in rent",
          "and each transfer costs 5,000 lamports.",
        ].join(NEWLINE),
      );
    }
  }
  process.stderr.write(`balance ${fromBaseUnits(lamports, SOL_DECIMALS)} SOL${NEWLINE}`);

  if (config.nonceAccount) {
    const { nonce } = await wallet.nonce();
    process.stdout.write(
      JSON.stringify(
        { result: "ALREADY FUNDED", nonce_account: config.nonceAccount, nonce },
        null,
        2,
      ) + NEWLINE,
    );
    return;
  }

  const nonceAccount = Keypair.generate();
  const rent = await wallet.connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.keypair.publicKey,
      newAccountPubkey: nonceAccount.publicKey,
      lamports: rent,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({
      noncePubkey: nonceAccount.publicKey,
      authorizedPubkey: wallet.keypair.publicKey,
    }),
  );
  const { blockhash } = await wallet.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.keypair.publicKey;
  transaction.sign(wallet.keypair, nonceAccount);
  const signature = await wallet.connection.sendRawTransaction(transaction.serialize());
  await wallet.connection.confirmTransaction(signature, "confirmed");

  // Appended rather than rewritten: the file holds a private key and the
  // less this touches it the better.
  const existing = readFileSync(ENV_PATH, "utf8");
  if (existing.includes("MOAT_SOLANA_NONCE_ACCOUNT=")) {
    process.stderr.write(
      `set MOAT_SOLANA_NONCE_ACCOUNT=${nonceAccount.publicKey.toBase58()} by hand${NEWLINE}`,
    );
  } else {
    appendFileSync(
      ENV_PATH,
      `MOAT_SOLANA_NONCE_ACCOUNT=${nonceAccount.publicKey.toBase58()}${NEWLINE}`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        result: "FUNDED",
        sender: wallet.address,
        balance_sol: fromBaseUnits(await wallet.balanceLamports(), SOL_DECIMALS),
        nonce_account: nonceAccount.publicKey.toBase58(),
        rent_lamports: rent,
        explorer: accountUrl(wallet.address),
      },
      null,
      2,
    ) + NEWLINE,
  );
}

await main();
