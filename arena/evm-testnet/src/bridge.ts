// Move Ethereum Sepolia ether to Base Sepolia, for when no Base faucet will
// talk to you.
//
//   MOAT_EVM_BRIDGE_CONFIRM=YES pnpm --filter @moat/evm-testnet bridge [amount]
//
// Ethereum Sepolia ether is easier to come by than Base Sepolia ether --
// Google's faucet hands it out on a Google login alone -- and Base's own
// bridge turns one into the other. A plain transfer to the L1StandardBridge
// credits the same address on Base Sepolia a few minutes later; that is the
// OP Stack's receive() path, and needs no calldata.
//
// This is a one-off utility on a different chain from the adapter, so it
// does not share the adapter's client. It pins its own chain, checks the
// node agrees, sends only to the bridge address printed in Base's
// documentation, and only from the key in .env.evm-testnet to that same
// key's address on the other side. Testnet ether on both ends.

import { createPublicClient, createWalletClient, formatUnits, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";
import { configFromEnv } from "./evm.js";

/** Base Sepolia's L1StandardBridge on Ethereum Sepolia, from docs.base.org. */
const L1_STANDARD_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120" as const;

async function main(): Promise<void> {
  if (process.env["MOAT_EVM_BRIDGE_CONFIRM"] !== "YES") {
    throw new Error("set MOAT_EVM_BRIDGE_CONFIRM=YES to bridge Sepolia ether to Base Sepolia");
  }
  const amount = process.argv[2] ?? "0.02";
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 0.1) {
    throw new Error("amount must be a plain decimal between 0 and 0.1 ether");
  }
  const account = privateKeyToAccount(configFromEnv().privateKey);
  const l1 = createPublicClient({ chain: sepolia, transport: http() });
  const l1Wallet = createWalletClient({ account, chain: sepolia, transport: http() });
  const l2 = createPublicClient({ chain: baseSepolia, transport: http() });

  const l1Id = await l1.getChainId();
  if (l1Id !== sepolia.id) throw new Error(`L1 node is chain ${l1Id}, not ${sepolia.id}`);
  const l2Id = await l2.getChainId();
  if (l2Id !== baseSepolia.id) throw new Error(`L2 node is chain ${l2Id}, not ${baseSepolia.id}`);

  const value = parseEther(amount);
  const have = await l1.getBalance({ address: account.address });
  const gas = await l1.estimateGas({ account, to: L1_STANDARD_BRIDGE, value });
  const fee = (await l1.getGasPrice()) * gas * 2n;
  if (have < value + fee) {
    throw new Error(
      `${account.address} holds ${formatUnits(have, 18)} Sepolia ETH; needs ${amount} plus gas.\n` +
        "Google's faucet: https://cloud.google.com/application/web3/faucet (pick Ethereum Sepolia).",
    );
  }
  const before = await l2.getBalance({ address: account.address });
  process.stderr.write(
    `bridging ${amount} ETH from ${account.address} on Sepolia to the same address on Base Sepolia\n`,
  );
  const hash = await l1Wallet.sendTransaction({ to: L1_STANDARD_BRIDGE, value, gas });
  process.stderr.write(`L1 deposit: https://sepolia.etherscan.io/tx/${hash}\n`);
  const receipt = await l1.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("the L1 deposit reverted");
  process.stderr.write("mined on L1; waiting for Base Sepolia to credit it (usually one to three minutes)\n");

  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const now = await l2.getBalance({ address: account.address });
    if (now > before) {
      process.stdout.write(
        JSON.stringify(
          {
            result: "BRIDGED",
            l1_tx: hash,
            base_sepolia_balance: formatUnits(now, 18),
            explorer: `${baseSepolia.blockExplorers.default.url}/address/${account.address}`,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("the deposit was mined on L1 but Base Sepolia has not credited it after 15 minutes");
}

await main();
