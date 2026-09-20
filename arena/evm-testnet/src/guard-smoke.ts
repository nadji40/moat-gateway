// The claim the rest of this repository cannot make: going around Moat
// does not help.
//
//   MOAT_EVM_GUARD_CONFIRM=YES pnpm --filter @moat/evm-testnet guard
//
// Everywhere else, Moat is a proxy the agent chose to call, and an agent
// holding the key can skip it. Here the funds sit in MoatGuardedWallet on
// Base Sepolia, which executes a payment only against an EIP-712 signature
// from Moat's co-signing key over that exact payment. The owner key alone
// moves nothing. ADR 0010.
//
// What it proves, in order, against a real chain:
//
//   1. The owner, holding the only key, tries to pay itself with a
//      signature it made up. The chain refuses.
//   2. An approved payment is proposed, Moat allows it, the verdict is
//      co-signed, the owner executes, and the money moves.
//   3. The same signature is presented again. The chain refuses: one
//      evidence record, one payment.
//   4. A forged-address payment is proposed. Moat denies it, and the
//      co-sign endpoint refuses to turn a denial into a signature.
//   5. A signature is requested for an amount Moat did not allow. Refused,
//      because the endpoint checks the request against the evidence rather
//      than against what the caller says the evidence was.
//
// Step 1 is the one that matters. Every other line in this repository is
// about what Moat decides; that step is about what an agent can do anyway.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatUnits,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CHAIN, configFromEnv, NETWORK, retrying } from "./evm.js";
import { compileGuard, guardError, GUARD_ABI, NATIVE } from "./guard.js";

const DENY = -31051;
const API = "http://127.0.0.1:7076";
const here = dirname(fileURLToPath(import.meta.url));
const arena = resolve(here, "../..");
const repo = resolve(arena, "..");
const gatewayCandidates = [
  resolve(repo, "target/release/moat-gateway.exe"),
  resolve(repo, "target/release/moat-gateway"),
  resolve(repo, "target/debug/moat-gateway.exe"),
  resolve(repo, "target/debug/moat-gateway"),
];
/** What the guarded wallet is funded with, and what it pays out. */
const FUND = "0.0004";
const AMOUNT = "0.0001";

async function api(session: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}/v1/session/${encodeURIComponent(session)}${path}`, init);
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

/** A POST that is expected to be refused; returns the reason Moat gave. */
async function apiRefusal(session: string, path: string, body: unknown): Promise<string> {
  const response = await fetch(`${API}/v1/session/${encodeURIComponent(session)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) throw new Error(`${path} was expected to be refused and succeeded`);
  const text = await response.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text;
  }
}

async function waitForApi(session: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await api(session, "/workflow");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("Moat intent API did not become ready on 7076");
}

/**
 * Run a contract call that must not succeed, and say how it was stopped.
 *
 * Two ways count and both are the chain refusing. Usually the node rejects
 * it at estimation and viem raises the contract's own error; sometimes it
 * is mined and reverts. Anything else -- a receipt with status success --
 * means the guard let it through, which is the failure this whole script
 * exists to detect, so it throws.
 */
async function expectChainRefusal(
  label: string,
  send: () => Promise<Hex>,
  receiptOf: (hash: Hex) => Promise<{ status: string }>,
): Promise<string> {
  let hash: Hex;
  try {
    hash = await send();
  } catch (error) {
    const named = guardError(error);
    if (named) return named;
    throw new Error(`${label}: refused, but not by the guard: ${String(error)}`);
  }
  const receipt = await receiptOf(hash);
  if (receipt.status === "success") {
    throw new Error(`${label}: the guarded wallet executed it`);
  }
  return "reverted on chain";
}

interface Cosigned {
  signature: Hex;
  signer: Address;
  expiry: number;
  evidence_id_bytes32: Hex;
}

async function main(): Promise<void> {
  if (process.env["MOAT_EVM_GUARD_CONFIRM"] !== "YES") {
    throw new Error(
      `set MOAT_EVM_GUARD_CONFIRM=YES to deploy a contract and move real value on ${CHAIN.name}`,
    );
  }
  const gateway = gatewayCandidates.find(existsSync);
  if (!gateway) throw new Error("build moat-gateway (cargo build -p moat-gateway --release) first");

  const config = configFromEnv();
  const owner = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({
    account: owner,
    chain: baseSepolia,
    transport: http(config.rpcUrl),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== baseSepolia.id) throw new Error(`node is chain ${chainId}`);

  const run = Date.now().toString(36);
  const session = `evm-guard-${run}`;
  const client = new Client({ name: "moat-evm-guard", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: gateway,
      args: ["--config", resolve(arena, "moat.evm-guard.yaml"), "--session-id", session],
      cwd: arena,
      env: process.env as Record<string, string>,
      stderr: "inherit",
    }),
  );

  const findings: Record<string, unknown> = {};
  try {
    await waitForApi(session);

    // Moat's co-signing address, as the gateway reports it. The contract is
    // constructed around this, so the deployment is bound to this gateway's
    // key and no other.
    const cosigner = (await (await fetch(`${API}/v1/cosigner`)).json()) as {
      cosign_address?: string;
      enabled: boolean;
    };
    const moatAddress = cosigner.cosign_address as Address | undefined;
    if (!moatAddress) {
      throw new Error("this gateway reports no co-signing address; is cosign_keys configured?");
    }

    // Deploy, from source, so what runs is what is in the repository.
    const { bytecode, compiler } = compileGuard();
    const deployHash = await walletClient.sendTransaction({
      data: encodeDeployData({ abi: GUARD_ABI, bytecode, args: [moatAddress] }),
      value: parseEther(FUND),
    });
    const deployed = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const guard = deployed.contractAddress;
    if (deployed.status !== "success" || !guard) throw new Error("the guard did not deploy");
    findings["deployed"] = {
      guard,
      moat: moatAddress,
      owner: owner.address,
      compiler,
      funded: FUND,
      tx: `${CHAIN.blockExplorers.default.url}/tx/${deployHash}`,
    };

    const payee = config.authorized.address as Address;
    const value = parseEther(AMOUNT);
    const before = await publicClient.getBalance({ address: payee });

    // 1. The owner alone, with a signature nobody made. This is the bypass
    //    every other demonstration in this repository is exposed to.
    const forgedSignature = `0x${"11".repeat(65)}` as Hex;
    const refusedWithoutMoat = await expectChainRefusal(
      "owner alone",
      () =>
        walletClient.writeContract({
          address: guard,
          abi: GUARD_ABI,
          functionName: "execute",
          args: [
            payee,
            NATIVE,
            value,
            `0x${"22".repeat(32)}` as Hex,
            BigInt(2_000_000_000),
            forgedSignature,
          ],
          gas: 200_000n,
        }),
      (hash) => publicClient.waitForTransactionReceipt({ hash }),
    );
    const unmoved = await publicClient.getBalance({ address: payee });
    if (unmoved !== before) throw new Error("the payee's balance moved without Moat");
    findings["owner_alone_is_refused"] = refusedWithoutMoat;

    // 2. The approved payment: propose, allow, co-sign, execute.
    const authorizationId = `auth-guard-${run}`;
    const invoiceId = `INV-GUARD-${run}`;
    const authorize = async (id: string, invoice: string, to: string) =>
      api(session, "/authorizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorization_id: id,
          invoice_id: invoice,
          payee: config.authorized.payee,
          recipient_account_id: to,
          network: NETWORK,
          amount: AMOUNT,
          tolerance: 0,
          currency: "ETH",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          repeat_payments: false,
          max_payments: 1,
        }),
      });
    await api(session, "/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `Pay ${config.authorized.payee} ${AMOUNT} ETH at ${payee} on ${NETWORK}.`,
      }),
    });
    await authorize(authorizationId, invoiceId, payee);

    const propose = async (args: Record<string, unknown>) =>
      client.callTool({
        name: "wallet__propose",
        arguments: {
          counterparty: config.authorized.payee,
          token: "ETH",
          amount: AMOUNT,
          network: NETWORK,
          ...args,
        },
      });

    await propose({
      to_address: payee,
      authorization_id: authorizationId,
      invoice_id: invoiceId,
    });
    const workflow = (await api(session, "/workflow")) as {
      evidence: { id: string; verdict: string }[];
    };
    const allowed = workflow.evidence.filter((e) => e.verdict === "allow").at(-1);
    if (!allowed) throw new Error("Moat allowed nothing to co-sign");

    const cosigned = (await api(session, "/cosign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidence_id: allowed.id,
        wallet: guard,
        chain_id: baseSepolia.id,
        to: payee,
        value: value.toString(),
      }),
    })) as Cosigned;
    if (!cosigned.signature) throw new Error("the gateway returned no signature");
    if (cosigned.signer.toLowerCase() !== moatAddress.toLowerCase()) {
      throw new Error("the signature is not by the address the contract was built around");
    }

    const paidHash = await walletClient.writeContract({
      address: guard,
      abi: GUARD_ABI,
      functionName: "execute",
      args: [
        payee,
        NATIVE,
        value,
        cosigned.evidence_id_bytes32,
        BigInt(cosigned.expiry),
        cosigned.signature,
      ],
    });
    const paid = await publicClient.waitForTransactionReceipt({ hash: paidHash });
    if (paid.status !== "success") throw new Error("the co-signed payment reverted");
    // Pinned to the block that carried it, and retried: one endpoint is
    // many nodes and the next one may not have that block yet.
    const after = await retrying(() =>
      publicClient.getBalance({ address: payee, blockNumber: paid.blockNumber }),
    );
    if (after - before !== value) {
      throw new Error(`the payee gained ${after - before} wei, expected ${value}`);
    }
    findings["co_signed_payment"] = {
      evidence_id: allowed.id,
      tx: `${CHAIN.blockExplorers.default.url}/tx/${paidHash}`,
      payee_gained: formatUnits(after - before, 18),
    };

    // 3. The same verdict, presented twice.
    findings["replayed_verdict_is_refused"] = await expectChainRefusal(
      "replayed verdict",
      () =>
        walletClient.writeContract({
          address: guard,
          abi: GUARD_ABI,
          functionName: "execute",
          args: [
            payee,
            NATIVE,
            value,
            cosigned.evidence_id_bytes32,
            BigInt(cosigned.expiry),
            cosigned.signature,
          ],
          gas: 200_000n,
        }),
      (hash) => publicClient.waitForTransactionReceipt({ hash }),
    );

    // 4. A denial never becomes a signature.
    const forgedAuth = `auth-forged-${run}`;
    const forgedInvoice = `INV-FORGED-${run}`;
    await authorize(forgedAuth, forgedInvoice, payee);
    let denyReasons: string[] = [];
    try {
      await propose({
        to_address: config.unauthorized.address,
        authorization_id: forgedAuth,
        invoice_id: forgedInvoice,
      });
      throw new Error("Moat allowed a payment to the forged address");
    } catch (error) {
      if (!(error instanceof McpError) || error.code !== DENY) throw error;
      const data = error.data as { moat?: { reasons?: { id: string; passed: boolean }[] } };
      denyReasons = (data.moat?.reasons ?? []).filter((r) => !r.passed).map((r) => r.id);
    }
    const denied = (await api(session, "/workflow")) as {
      evidence: { id: string; verdict: string }[];
    };
    const deniedRecord = denied.evidence.filter((e) => e.verdict === "deny").at(-1);
    if (!deniedRecord) throw new Error("no denial was recorded");
    findings["denial_cannot_be_co_signed"] = {
      reasons: denyReasons,
      refusal: await apiRefusal(session, "/cosign", {
        evidence_id: deniedRecord.id,
        wallet: guard,
        chain_id: baseSepolia.id,
        to: config.unauthorized.address,
        value: value.toString(),
      }),
    };

    // 5. And an allow cannot be stretched to cover something else.
    findings["a_different_amount_cannot_be_co_signed"] = await apiRefusal(session, "/cosign", {
      evidence_id: allowed.id,
      wallet: guard,
      chain_id: baseSepolia.id,
      to: payee,
      value: (value * 10n).toString(),
    });

    const left = await publicClient.getBalance({ address: guard });
    process.stdout.write(
      JSON.stringify(
        {
          result: "PASS",
          claim: "the owner holds the only key and still cannot move this wallet without Moat",
          chain: `${CHAIN.name} (${NETWORK})`,
          session,
          findings,
          guard_balance_left: formatUnits(left, 18),
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await client.close();
  }
}

await main();
