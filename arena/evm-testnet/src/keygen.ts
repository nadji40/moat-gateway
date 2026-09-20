// Create the keys the demonstration needs and write them where the other
// adapters keep theirs: a .env file at the repository root, ignored by Git,
// readable by nobody else. Prints the addresses to fund and nothing that
// signs.
//
//   pnpm --filter @moat/evm-testnet keygen
//
// Refuses to overwrite an existing file. Testnet keys are worthless, but a
// script that silently replaced a funded key with an empty one would waste
// somebody's afternoon at the faucet.

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN } from "./evm.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const target = process.argv[2] ?? resolve(repo, ".env.evm-testnet");

if (existsSync(target)) {
  process.stderr.write(`${target} already exists; not overwriting.\n`);
  process.exit(1);
}

const sender = generatePrivateKey();
const supplier = generatePrivateKey();
const senderAddress = privateKeyToAccount(sender).address;
const supplierAddress = privateKeyToAccount(supplier).address;
// Nobody holds this key. It is the address an attacker would put on an
// invoice, and the demonstration proves nothing is ever sent to it.
const attackerAddress = "0x6F0e2d1Cf744BB115e14BDdED63d2561A55b8ce0";

const lines = [
  `# Moat EVM testnet demonstration -- ${CHAIN.name} (${CHAIN.id}). Testnet only.`,
  `# Generated ${new Date().toISOString()}. Never commit this file.`,
  "",
  "# The wallet Moat's agent spends from. Fund it from a Base Sepolia faucet.",
  `MOAT_EVM_PRIVATE_KEY=${sender}`,
  "",
  "# The supplier the user has approved. You hold this key too, so you can",
  "# watch the balance arrive. Nothing needs to be funded here.",
  "MOAT_EVM_AUTHORIZED_PAYEE=Monitoring Pro Inc",
  `MOAT_EVM_AUTHORIZED_ADDRESS=${supplierAddress}`,
  `# MOAT_EVM_AUTHORIZED_PRIVATE_KEY=${supplier}`,
  "",
  "# The address on the forged invoice. Nobody holds this key.",
  "MOAT_EVM_UNAUTHORIZED_PAYEE=ProMon Billing Ltd",
  `MOAT_EVM_UNAUTHORIZED_ADDRESS=${attackerAddress}`,
  "",
  "# Optional. A six-decimal test token, once one is deployed; ether needs nothing.",
  "# MOAT_EVM_TOKEN_ADDRESS=0x...",
  "# MOAT_EVM_TOKEN_SYMBOL=USDC",
  "# MOAT_EVM_TOKEN_DECIMALS=6",
  "",
  "# Guards on faucet funds and on how long to wait. Not policy.",
  "MOAT_EVM_MAX_SEND=0.001",
  "MOAT_EVM_CONFIRMATIONS=1",
  `# MOAT_EVM_RPC_URL=${CHAIN.rpcUrls.default.http[0]}`,
  "",
];

writeFileSync(target, lines.join("\n"), { mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  // Windows has no mode bits; the file is still under the user's own profile.
}

process.stdout.write(
  [
    `wrote ${target}`,
    "",
    `fund this address with ${CHAIN.name} ether (a few thousandths is plenty):`,
    `  ${senderAddress}`,
    "",
    `the approved supplier's address, which will receive the allowed payments:`,
    `  ${supplierAddress}`,
    "",
    `explorer: ${CHAIN.blockExplorers.default.url}/address/${senderAddress}`,
    "",
  ].join("\n"),
);
