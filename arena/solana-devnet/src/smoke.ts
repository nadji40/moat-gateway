// Real transactions, on a real cluster, with Moat in front.
//
//   MOAT_SOLANA_SMOKE_CONFIRM=YES pnpm --filter @moat/solana-devnet smoke
//
// The sibling of evm-testnet's smoke, for the other chain family, and it
// proves the same things in the same order: the wallet is on the cluster it
// claims and is funded; through Moat, the approved payment goes out and
// lands, the forged-invoice address is refused before the wallet hears of
// it, and the right address on the wrong cluster is refused the same way; a
// lost reply after broadcast is held and quarantined, the retry is refused,
// an operator confirms the signature on chain and reconciles it, and the
// retry is then refused as a duplicate; and finally Moat's record agrees,
// signature for signature, with what the wallet signed.
//
// The one thing here that is not a translation of the EVM script is the
// last check: the retry rebroadcasts the *same signed bytes*, and the
// durable nonce is what makes that safe. On an EVM chain a stale
// transaction is still landable because its nonce is still next; on Solana
// a transaction built on a recent blockhash would have expired, and
// re-signing would produce a different signature and a second payment.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { configFromEnv, NETWORK, SentLedger, Wallet } from "./solana.js";

const DENY = -31051;
const API = "http://127.0.0.1:7078";
const here = dirname(fileURLToPath(import.meta.url));
const arena = resolve(here, "../..");
const repo = resolve(arena, "..");
const gatewayCandidates = [
  resolve(repo, "target/release/moat-gateway.exe"),
  resolve(repo, "target/release/moat-gateway"),
  resolve(repo, "target/debug/moat-gateway.exe"),
  resolve(repo, "target/debug/moat-gateway"),
];
/**
 * Above the rent-exempt minimum, which is the floor for creating an
 * account at all on this chain, and small enough that one airdrop covers
 * many runs.
 */
const AMOUNT = "0.002";

interface Outcome {
  authorization_id: string;
  evidence_id: string;
  receipt?: string;
  status_kind: string;
  committed: boolean;
  quarantined: boolean;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: T }).structuredContent as T;
}

async function api(session: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API}/v1/session/${encodeURIComponent(session)}${path}`, init);
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function post(session: string, path: string, body: unknown): Promise<unknown> {
  return api(session, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  throw new Error("Moat intent API did not become ready on 7078");
}

async function expectDenied(promise: Promise<unknown>, label: string): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof McpError) || error.code !== DENY) {
      throw new Error(`${label}: expected a Moat denial, got ${String(error)}`);
    }
    const data = error.data as { moat?: { reasons?: { id: string; passed: boolean }[] } };
    return (data.moat?.reasons ?? []).filter((r) => !r.passed).map((r) => r.id);
  }
  throw new Error(`${label}: expected a denial and the payment went through`);
}

async function main(): Promise<void> {
  if (process.env["MOAT_SOLANA_SMOKE_CONFIRM"] !== "YES") {
    throw new Error("set MOAT_SOLANA_SMOKE_CONFIRM=YES to broadcast real transactions on devnet");
  }
  const gateway = gatewayCandidates.find(existsSync);
  if (!gateway) throw new Error("build moat-gateway (cargo build -p moat-gateway --release) first");

  const config = configFromEnv();
  const wallet = new Wallet(config);
  await wallet.assertCluster();
  if ((await wallet.balanceLamports()) === 0n) {
    throw new Error(
      [
        `the sender ${wallet.address} holds no SOL on devnet.`,
        "Run: pnpm --filter @moat/solana-devnet fund",
      ].join(" "),
    );
  }
  if (!config.nonceAccount) {
    throw new Error("no durable nonce account; run `pnpm --filter @moat/solana-devnet fund`");
  }

  const run = Date.now().toString(36);
  const session = `solana-devnet-${run}`;
  const client = new Client({ name: "moat-solana-smoke", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: gateway,
      args: ["--config", resolve(arena, "moat.solana-devnet.yaml"), "--session-id", session],
      cwd: arena,
      env: process.env as Record<string, string>,
      stderr: "inherit",
    }),
  );

  const findings: Record<string, unknown> = {};
  const signatures = new Map<string, string>();
  try {
    await waitForApi(session);
    const authorize = (id: string, invoice: string, to: string) =>
      post(session, "/authorizations", {
        authorization_id: id,
        invoice_id: invoice,
        payee: config.authorized.payee,
        recipient_account_id: to,
        network: NETWORK,
        amount: AMOUNT,
        tolerance: 0,
        currency: "SOL",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        repeat_payments: false,
        max_payments: 1,
      });
    const send = (args: Record<string, unknown>) =>
      client.callTool({
        name: "wallet__send",
        arguments: {
          counterparty: config.authorized.payee,
          token: "SOL",
          amount: AMOUNT,
          network: NETWORK,
          ...args,
        },
      });
    const outcomes = async (): Promise<Outcome[]> =>
      ((await api(session, "/workflow")) as { payment_outcomes: Outcome[] }).payment_outcomes;

    // 1. The approved payment.
    const okAuth = `auth-ok-${run}`;
    const okInvoice = `INV-OK-${run}`;
    await post(session, "/intent", {
      text: `Pay ${config.authorized.payee} ${AMOUNT} SOL for invoice ${okInvoice} to ${config.authorized.address} on ${NETWORK}.`,
    });
    await authorize(okAuth, okInvoice, config.authorized.address);
    const paid = structured<{ receipt: string; status: string; explorer_url: string }>(
      await send({
        to_address: config.authorized.address,
        authorization_id: okAuth,
        invoice_id: okInvoice,
      }),
    );
    if (!paid.receipt) throw new Error("the approved payment returned no signature");
    signatures.set(okAuth, paid.receipt);
    findings["approved_payment"] = { status: paid.status, tx: paid.explorer_url };

    // 2. The forged invoice: right supplier name, attacker's address.
    const forged = `auth-forged-${run}`;
    await authorize(forged, `INV-FORGED-${run}`, config.authorized.address);
    findings["forged_address"] = await expectDenied(
      send({
        to_address: config.unauthorized.address,
        authorization_id: forged,
        invoice_id: `INV-FORGED-${run}`,
      }),
      "forged invoice address",
    );

    // 3. The right address on the wrong cluster.
    const wrongCluster = `auth-cluster-${run}`;
    await authorize(wrongCluster, `INV-CLUSTER-${run}`, config.authorized.address);
    findings["wrong_network"] = await expectDenied(
      send({
        to_address: config.authorized.address,
        authorization_id: wrongCluster,
        invoice_id: `INV-CLUSTER-${run}`,
        network: "solana:mainnet",
      }),
      "right address on the wrong cluster",
    );

    // 4. A lost reply after broadcast.
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
      send({
        to_address: config.authorized.address,
        authorization_id: lost,
        invoice_id: lostInvoice,
      }),
      "retry while held",
    );
    if (!heldRetry.includes("authorization-quarantine")) {
      throw new Error(`retry while held was refused for ${heldRetry.join(",")}, not the quarantine`);
    }
    const ledger = new SentLedger(config.stateDir);
    const signed = ledger.forAuthorization(lost);
    if (signed.length !== 1) throw new Error(`lost reply signed ${signed.length}, not one`);
    const onChain = await wallet.view(signed[0]!.signature, true);
    if (onChain.status === "failed" || onChain.status === "submitted") {
      throw new Error(`the lost transaction is ${onChain.status} on chain`);
    }
    signatures.set(lost, signed[0]!.signature);
    const open = (await outcomes()).find((o) => o.authorization_id === lost);
    if (!open) throw new Error("the lost payment is not among the outcomes");
    await post(session, `/outcomes/${encodeURIComponent(open.evidence_id)}/reconcile`, {
      status: "settled",
      receipt: signed[0]!.signature,
    });
    const afterRetry = await expectDenied(
      send({
        to_address: config.authorized.address,
        authorization_id: lost,
        invoice_id: lostInvoice,
      }),
      "retry after reconciliation",
    );
    findings["lost_reply"] = {
      held_then: heldRetry,
      on_chain: onChain.status,
      tx: onChain.explorer_url,
      after_reconcile: afterRetry,
    };

    // 5. Moat's record against the wallet's, and the durable-nonce
    //    property: one authorization, one signature, ever.
    const workflow = (await api(session, "/workflow")) as {
      payment_outcomes: Outcome[];
      evidence: { id: string }[];
    };
    for (const [authorizationId, signature] of signatures) {
      const outcome = workflow.payment_outcomes.find(
        (o) => o.authorization_id === authorizationId && o.receipt === signature && o.committed,
      );
      if (!outcome) throw new Error(`Moat has no committed outcome for ${authorizationId}`);
      const records = ledger.forAuthorization(authorizationId);
      if (records.length !== 1 || records[0]!.signature !== signature) {
        throw new Error(`the wallet signed ${records.length} transaction(s) for ${authorizationId}`);
      }
    }
    for (const id of [forged, wrongCluster]) {
      if (ledger.forAuthorization(id).length !== 0) {
        throw new Error(`${id} was refused by Moat and the wallet signed for it anyway`);
      }
    }

    process.stdout.write(
      JSON.stringify(
        {
          result: "PASS",
          cluster: `Solana devnet (${NETWORK})`,
          sender: wallet.address,
          nonce_account: config.nonceAccount,
          session,
          findings,
          reconciliation: {
            evidence_records: workflow.evidence.length,
            provider_outcomes: workflow.payment_outcomes.length,
            transactions_on_chain: signatures.size,
            refused_before_signing: 2,
          },
          balances_after: await wallet.balances(),
        },
        null,
        2,
      ) + String.fromCharCode(10),
    );
  } finally {
    await client.close();
  }
}

await main();
