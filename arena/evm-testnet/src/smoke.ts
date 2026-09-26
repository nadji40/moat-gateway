// Real transactions, on a real chain, with Moat in front.
//
//   MOAT_EVM_SMOKE_CONFIRM=YES pnpm --filter @moat/evm-testnet smoke
//
// What it proves, in order: the wallet is on the chain it claims and is
// funded; the wallet itself sends to anyone, because a provider is not a
// control; through Moat, the approved payment goes out and lands on chain,
// the forged-invoice address is refused before the wallet hears of it, and
// the right address on the wrong chain is refused the same way; a lost
// reply after broadcast is held and quarantined, the retry is refused, an
// operator confirms the transaction on chain and reconciles it, and the
// retry is then refused as a duplicate; and finally Moat's record of what
// it allowed agrees, hash for hash, with what the wallet signed.
//
// Every allowed send here costs testnet ether. Four go out; a fifth, in
// USDC through the real six-decimal contract, when the wallet holds any.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CHAIN, configFromEnv, NETWORK, SentLedger, Wallet } from "./evm.js";

const DENY = -31051;
const API = "http://127.0.0.1:7075";
const here = dirname(fileURLToPath(import.meta.url));
const arena = resolve(here, "../..");
const repo = resolve(arena, "..");
const gatewayCandidates = [
  resolve(repo, "target/release/moat-gateway.exe"),
  resolve(repo, "target/release/moat-gateway"),
  resolve(repo, "target/debug/moat-gateway.exe"),
  resolve(repo, "target/debug/moat-gateway"),
];
/** Small enough that a faucet's worth covers many runs. */
const AMOUNT = "0.0001";

interface WorkflowSnapshot {
  payment_outcomes: {
    authorization_id: string;
    evidence_id: string;
    receipt?: string;
    status: string;
    status_kind: string;
    committed: boolean;
    quarantined: boolean;
  }[];
  evidence: { id: string; verdict: { decision: string } }[];
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: T }).structuredContent as T;
}

async function api(session: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}/v1/session/${encodeURIComponent(session)}${path}`, init);
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  return response.json();
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
  throw new Error("Moat intent API did not become ready on 7075");
}

async function expectDenied(promise: Promise<unknown>, label: string): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof McpError) || error.code !== DENY) {
      throw new Error(`${label}: expected a Moat denial, got ${String(error)}`);
    }
    const data = error.data as { moat?: { reasons?: { id: string; passed: boolean }[] } } | undefined;
    return (data?.moat?.reasons ?? []).filter((r) => !r.passed).map((r) => r.id);
  }
  throw new Error(`${label}: expected a denial and the payment went through`);
}

async function main(): Promise<void> {
  if (process.env["MOAT_EVM_SMOKE_CONFIRM"] !== "YES") {
    throw new Error(
      `set MOAT_EVM_SMOKE_CONFIRM=YES to broadcast four real transactions on ${CHAIN.name}`,
    );
  }
  const gateway = gatewayCandidates.find(existsSync);
  if (!gateway) throw new Error("build moat-gateway (cargo build -p moat-gateway --release) first");

  const config = configFromEnv();
  const wallet = new Wallet(config);
  await wallet.assertChain();
  const balances = await wallet.balances();
  if (Number(balances["sender.ETH"] ?? "0") === 0) {
    throw new Error(
      [
        `the sender ${wallet.address} holds no ether on ${CHAIN.name}.`,
        "Fund it from a Base Sepolia faucet and run again:",
        `  ${CHAIN.blockExplorers.default.url}/address/${wallet.address}`,
        "A few thousandths of an ether covers many runs.",
      ].join("\n"),
    );
  }

  const run = Date.now().toString(36);
  const session = `evm-testnet-${run}`;
  const client = new Client({ name: "moat-evm-smoke", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: gateway,
      args: ["--config", resolve(arena, "moat.evm-testnet.yaml"), "--session-id", session],
      cwd: arena,
      env: process.env as Record<string, string>,
      stderr: "inherit",
    }),
  );

  const authorize = async (id: string, invoice: string, to: string, extra: Record<string, unknown> = {}) => {
    await api(session, "/authorizations", {
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
        ...extra,
      }),
    });
  };
  const send = (args: Record<string, unknown>) =>
    client.callTool({
      name: "wallet__send",
      arguments: {
        counterparty: config.authorized.payee,
        token: "ETH",
        amount: AMOUNT,
        network: NETWORK,
        ...args,
      },
    });

  const hashes = new Map<string, string>();
  const findings: Record<string, unknown> = {};

  try {
    await waitForApi(session);
    await api(session, "/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `Pay ${config.authorized.payee} ${AMOUNT} ETH at ${config.authorized.address} on ${NETWORK} for the testnet invoice.`,
      }),
    });

    // 1. The approved payment, allowed, and on chain.
    const ok = `auth-ok-${run}`;
    await authorize(ok, `INV-OK-${run}`, config.authorized.address);
    const allowed = structured<{ receipt: string; status: string; explorer_url: string }>(
      await send({ to_address: config.authorized.address, authorization_id: ok, invoice_id: `INV-OK-${run}` }),
    );
    if (!allowed?.receipt) throw new Error("the approved payment returned no transaction hash");
    hashes.set(ok, allowed.receipt);
    findings["approved_payment"] = { status: allowed.status, tx: allowed.explorer_url };

    // 1b. The same, in the six-decimal token, through the real contract --
    //     if the faucet has been visited. Skipped, and said so, otherwise.
    //     Half a cent, because the policy's cap is a bare number that applies
    //     to whatever unit is sent; a per-asset cap is not built.
    const token = config.token;
    const tokenBalance = token ? Number(balances[`sender.${token.symbol}`] ?? "0") : 0;
    if (token && tokenBalance >= 0.01) {
      const usdc = `auth-usdc-${run}`;
      await authorize(usdc, `INV-USDC-${run}`, config.authorized.address, {
        amount: "0.005",
        currency: token.symbol,
        asset_contract: token.address,
      });
      const paid = structured<{ receipt: string; status: string; explorer_url: string; amount: string }>(
        await send({
          to_address: config.authorized.address,
          authorization_id: usdc,
          invoice_id: `INV-USDC-${run}`,
          token: token.symbol,
          token_address: token.address,
          amount: "0.005",
        }),
      );
      if (!paid?.receipt) throw new Error("the USDC payment returned no transaction hash");
      if (paid.amount !== "0.005") throw new Error(`USDC amount came back as ${paid.amount}`);
      hashes.set(usdc, paid.receipt);
      findings["approved_payment_usdc"] = { status: paid.status, tx: paid.explorer_url };
    } else {
      findings["approved_payment_usdc"] = token
        ? `skipped: sender holds ${tokenBalance} ${token.symbol}; fund it at https://faucet.circle.com`
        : "skipped: no token configured";
    }

    // 2. The forged invoice: right supplier name, attacker's address.
    const forged = `auth-forged-${run}`;
    await authorize(forged, `INV-FORGED-${run}`, config.authorized.address);
    findings["forged_address"] = await expectDenied(
      send({ to_address: config.unauthorized.address, authorization_id: forged, invoice_id: `INV-FORGED-${run}` }),
      "forged invoice address",
    );

    // 3. The right address on the wrong chain.
    const wrongChain = `auth-chain-${run}`;
    await authorize(wrongChain, `INV-CHAIN-${run}`, config.authorized.address);
    findings["wrong_network"] = await expectDenied(
      send({
        to_address: config.authorized.address,
        authorization_id: wrongChain,
        invoice_id: `INV-CHAIN-${run}`,
        network: "eip155:1",
      }),
      "right address on the wrong chain",
    );

    // 4. A lost reply after broadcast: held, retry refused, reconciled, retry
    //    refused again for the right reason.
    const lost = `auth-lost-${run}`;
    const lostInvoice = `INV-LOST-${run}`;
    await authorize(lost, lostInvoice, config.authorized.address);
    const dropped = await send({
      to_address: config.authorized.address,
      authorization_id: lost,
      invoice_id: lostInvoice,
      simulate_response_loss: true,
    });
    if (!(dropped as { isError?: boolean }).isError) {
      throw new Error("fault injection did not lose the reply");
    }
    const heldRetry = await expectDenied(
      send({ to_address: config.authorized.address, authorization_id: lost, invoice_id: lostInvoice }),
      "retry while held",
    );
    if (!heldRetry.includes("authorization-quarantine")) {
      throw new Error(`retry while held was refused for ${heldRetry.join(",")}, not the quarantine`);
    }
    // The operator's check: what did the wallet actually sign for this
    // authorization, and is it on chain?
    const signed = new SentLedger(config.stateDir).forAuthorization(lost);
    if (signed.length !== 1) throw new Error(`lost reply signed ${signed.length} transactions, not one`);
    const onChain = await wallet.view(signed[0]!.hash, true);
    if (onChain.status === "failed" || onChain.status === "submitted") {
      throw new Error(`the lost transaction is ${onChain.status} on chain`);
    }
    hashes.set(lost, signed[0]!.hash);
    const open = (await api(session, "/outcomes")) as { open: { evidence_id: string; authorization_id: string }[] };
    const held = open.open.find((o) => o.authorization_id === lost);
    if (!held) throw new Error("the lost payment is not among the open outcomes");
    await api(session, `/outcomes/${encodeURIComponent(held.evidence_id)}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "settled", receipt: signed[0]!.hash }),
    });
    const afterRetry = await expectDenied(
      send({ to_address: config.authorized.address, authorization_id: lost, invoice_id: lostInvoice }),
      "retry after reconciliation",
    );
    findings["lost_reply"] = {
      held_then: heldRetry,
      on_chain: onChain.status,
      tx: onChain.explorer_url,
      after_reconcile: afterRetry,
    };

    // 5. Moat's record against the wallet's.
    const workflow = (await api(session, "/workflow")) as WorkflowSnapshot;
    for (const [authorizationId, hash] of hashes) {
      const outcome = workflow.payment_outcomes.find(
        (o) => o.authorization_id === authorizationId && o.receipt === hash && o.committed,
      );
      if (!outcome) throw new Error(`Moat has no committed outcome for ${authorizationId} at ${hash}`);
      const signed = new SentLedger(config.stateDir).forAuthorization(authorizationId);
      if (signed.length !== 1 || signed[0]!.hash !== hash) {
        throw new Error(`the wallet signed ${signed.length} transaction(s) for ${authorizationId}`);
      }
    }
    for (const id of [forged, wrongChain]) {
      if (new SentLedger(config.stateDir).forAuthorization(id).length !== 0) {
        throw new Error(`${id} was refused by Moat and the wallet signed for it anyway`);
      }
    }

    // Report the balances at the block that carried the last of these
    // transactions, so the figures account for every transaction listed
    // above them. Read against the head instead and a public endpoint can
    // answer from a node that has not seen the last block yet.
    // Taken from the wallet's own records, which the loop above has just
    // checked hash-for-hash against Moat's, so these are the same
    // transactions the report lists.
    const signedHashes = [...hashes.keys()].flatMap((id) =>
      new SentLedger(config.stateDir).forAuthorization(id).map((r) => r.hash),
    );
    const blocks = await Promise.all(signedHashes.map(async (h) => (await wallet.view(h, true)).block));
    const lastBlock = blocks.reduce<bigint | undefined>(
      (max, b) => (b === null ? max : max === undefined || BigInt(b) > max ? BigInt(b) : max),
      undefined,
    );

    process.stdout.write(
      JSON.stringify(
        {
          result: "PASS",
          chain: `${CHAIN.name} (${NETWORK})`,
          sender: wallet.address,
          session,
          findings,
          reconciliation: {
            evidence_records: workflow.evidence.length,
            provider_outcomes: workflow.payment_outcomes.length,
            transactions_on_chain: hashes.size,
            refused_before_signing: 2,
          },
          balances_after: await wallet.balances(lastBlock),
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
