// The bank rail, end to end, through the outcome state machine.
//
//   MOAT_BANK_CONFIRM=YES pnpm --filter @moat/bank-adapter smoke
//
// No network and no money: the provider is the reference implementation of
// BankProvider. What is real is everything between Moat and it — an
// asynchronous rail where a transfer is accepted before it is done, where
// the reply can be lost in the window that matters, and where a settled
// transfer can come back days later.
//
// What it proves, in order:
//
//   1. An approved transfer is accepted as `pending`, and Moat commits it
//      against the mandate immediately, because on this rail accepted may
//      already mean gone.
//   2. The bank settles it on its own clock; an operator reconciles the
//      reference and the outcome becomes terminal.
//   3. The forged-invoice account is refused before the bank hears of it.
//   4. A lost reply after acceptance is held and quarantined, the retry is
//      refused, and when the operator reconciles what the bank actually
//      did, the retry is refused again as a duplicate -- and the bank shows
//      exactly one transfer, because the idempotency key is computed from
//      what identifies the payment.
//   5. A transfer to an account that returns settles and then comes back.
//      Reconciling it as `returned` releases the mandate, and a replacement
//      transfer for the same invoice is then allowed -- which is the whole
//      reason `reversed` is a state and not an error.
//
// Step 5 is the one a card rail never reaches and the one the arena's mock
// bank does not model.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { configFromEnv, ReferenceBank } from "./providers/reference.js";
import { idempotencyKey } from "./idempotency.js";
import type { TransferStatus } from "./contract.js";

const DENY = -31051;
const API = "http://127.0.0.1:7077";
const here = dirname(fileURLToPath(import.meta.url));
const arena = resolve(here, "../..");
const repo = resolve(arena, "..");
const gatewayCandidates = [
  resolve(repo, "target/release/moat-gateway.exe"),
  resolve(repo, "target/release/moat-gateway"),
  resolve(repo, "target/debug/moat-gateway.exe"),
  resolve(repo, "target/debug/moat-gateway"),
];
const AMOUNT = "120.00";

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: T }).structuredContent as T;
}

interface Outcome {
  authorization_id: string;
  evidence_id: string;
  receipt?: string;
  status: string;
  status_kind: string;
  committed: boolean;
  quarantined: boolean;
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
  throw new Error("Moat intent API did not become ready on 7077");
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
  throw new Error(`${label}: expected a denial and the transfer went through`);
}

/** Wait for the bank's own clock to move a transfer somewhere. */
async function until(
  bank: ReferenceBank,
  reference: string,
  state: TransferStatus["state"],
  budgetMs = 20_000,
): Promise<TransferStatus> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await bank.getTransfer(reference);
    if (status.state === state) return status;
    if (Date.now() > deadline) {
      throw new Error(`${reference} is ${status.state}, never reached ${state}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  if (process.env["MOAT_BANK_CONFIRM"] !== "YES") {
    throw new Error("set MOAT_BANK_CONFIRM=YES to run the bank adapter end to end");
  }
  const gateway = gatewayCandidates.find(existsSync);
  if (!gateway) throw new Error("build moat-gateway (cargo build -p moat-gateway --release) first");

  const run = Date.now().toString(36);
  // Each run gets its own bank, so a run never inherits another's ledger
  // and the transfer counts below mean what they say.
  const stateDir = resolve(here, "../state", run);
  const env = { ...process.env, MOAT_BANK_STATE_DIR: stateDir } as Record<string, string>;
  const config = { ...configFromEnv(env), stateDir };
  const bank = new ReferenceBank(config);
  const supplier = config.accounts[0]!;
  const other = config.accounts[1]!;
  const returning = config.accounts[2]!;

  const session = `bank-adapter-${run}`;
  const client = new Client({ name: "moat-bank-smoke", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: gateway,
      args: ["--config", resolve(arena, "moat.bank-adapter.yaml"), "--session-id", session],
      cwd: arena,
      env,
      stderr: "inherit",
    }),
  );

  const findings: Record<string, unknown> = {};
  try {
    await waitForApi(session);
    const authorize = (id: string, invoice: string, iban: string, payee: string) =>
      post(session, "/authorizations", {
        authorization_id: id,
        invoice_id: invoice,
        payee,
        recipient_account_id: iban,
        amount: AMOUNT,
        tolerance: 0,
        currency: "EUR",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        repeat_payments: false,
        max_payments: 1,
      });
    const transfer = (args: Record<string, unknown>) =>
      client.callTool({
        name: "bank__transfer",
        arguments: { currency: "EUR", amount: AMOUNT, ...args },
      });
    const outcomes = async (): Promise<Outcome[]> =>
      ((await api(session, "/workflow")) as { payment_outcomes: Outcome[] }).payment_outcomes;

    // 1 and 2. Accepted, committed, then settled and reconciled.
    const okAuth = `auth-ok-${run}`;
    const okInvoice = `INV-OK-${run}`;
    await post(session, "/intent", {
      text: `Pay ${supplier.nameOnAccount} ${AMOUNT} EUR for invoice ${okInvoice} to ${supplier.iban}.`,
    });
    await authorize(okAuth, okInvoice, supplier.iban, supplier.nameOnAccount);
    const accepted = structured<{ receipt: string; status: string; beneficiary_match: string }>(
      await transfer({
        beneficiary_name: supplier.nameOnAccount,
        iban: supplier.iban,
        reference: okInvoice,
        authorization_id: okAuth,
        invoice_id: okInvoice,
      }),
    );
    const reference = accepted.receipt;
    const committedAtOnce = (await outcomes()).find((o) => o.authorization_id === okAuth);
    if (!committedAtOnce?.committed) {
      throw new Error("an accepted transfer was not committed against the mandate");
    }
    const settled = await until(bank, reference, "settled");
    await post(session, `/outcomes/${encodeURIComponent(committedAtOnce.evidence_id)}/reconcile`, {
      status: "settled",
      receipt: reference,
    });
    const afterSettle = (await outcomes()).find((o) => o.evidence_id === committedAtOnce.evidence_id);
    findings["approved_transfer"] = {
      reference,
      accepted_as: accepted.status,
      beneficiary_match: accepted.beneficiary_match,
      bank_settled_at: settled.settledAt,
      moat_status: afterSettle?.status_kind,
      committed_before_settlement: true,
    };

    // 3. The forged invoice: right supplier name, someone else's account.
    const forgedAuth = `auth-forged-${run}`;
    const forgedInvoice = `INV-FORGED-${run}`;
    await authorize(forgedAuth, forgedInvoice, supplier.iban, supplier.nameOnAccount);
    findings["forged_account"] = await expectDenied(
      transfer({
        beneficiary_name: supplier.nameOnAccount,
        iban: other.iban,
        reference: forgedInvoice,
        authorization_id: forgedAuth,
        invoice_id: forgedInvoice,
      }),
      "forged account",
    );

    // 4. A lost reply in the window where the money may already be moving.
    const lostAuth = `auth-lost-${run}`;
    const lostInvoice = `INV-LOST-${run}`;
    await authorize(lostAuth, lostInvoice, supplier.iban, supplier.nameOnAccount);
    const lostArgs = {
      beneficiary_name: supplier.nameOnAccount,
      iban: supplier.iban,
      reference: lostInvoice,
      authorization_id: lostAuth,
      invoice_id: lostInvoice,
    };
    const dropped = await transfer({ ...lostArgs, simulate_response_loss: true });
    if (!(dropped as { isError?: boolean }).isError) throw new Error("the reply was not lost");
    const heldRetry = await expectDenied(transfer(lostArgs), "retry while held");
    if (!heldRetry.includes("authorization-quarantine")) {
      throw new Error(`retry while held was refused for ${heldRetry.join(",")}, not the quarantine`);
    }
    // What the bank actually did, which is the only way to find out.
    const key = idempotencyKey(supplier.iban, lostAuth, lostInvoice);
    const mine = (await bank.listTransfers()).filter(
      (t) => t.reference !== reference && t.state !== "returned",
    );
    const lostTransfer = mine.at(-1);
    if (!lostTransfer) throw new Error("the bank has no record of the lost transfer");
    const held = (await outcomes()).find((o) => o.authorization_id === lostAuth);
    if (!held?.quarantined) throw new Error("the lost transfer was not quarantined");
    await until(bank, lostTransfer.reference, "settled");
    await post(session, `/outcomes/${encodeURIComponent(held.evidence_id)}/reconcile`, {
      status: "settled",
      receipt: lostTransfer.reference,
    });
    const afterReconcile = await expectDenied(transfer(lostArgs), "retry after reconciliation");
    findings["lost_reply"] = {
      held_then: heldRetry,
      bank_reference: lostTransfer.reference,
      after_reconcile: afterReconcile,
      idempotency_key: `${key.slice(0, 16)}…`,
    };

    // 5. Settled, then returned. The state a card never reaches.
    const returnAuth = `auth-return-${run}`;
    const returnInvoice = `INV-RETURN-${run}`;
    await post(session, "/intent", {
      text: `Pay ${returning.nameOnAccount} ${AMOUNT} EUR for invoice ${returnInvoice} to ${returning.iban}.`,
    });
    await authorize(returnAuth, returnInvoice, returning.iban, returning.nameOnAccount);
    const returnArgs = {
      beneficiary_name: returning.nameOnAccount,
      iban: returning.iban,
      reference: returnInvoice,
      authorization_id: returnAuth,
      invoice_id: returnInvoice,
    };
    const outboundRef = structured<{ receipt: string }>(await transfer(returnArgs)).receipt;
    const returnOutcome = (await outcomes()).find((o) => o.authorization_id === returnAuth);
    if (!returnOutcome) throw new Error("the returning transfer produced no outcome");
    // While it is out and committed, the invoice cannot be paid again.
    const whileOutstanding = await expectDenied(transfer(returnArgs), "replacement while committed");

    const returned = await until(bank, outboundRef, "returned");
    await post(session, `/outcomes/${encodeURIComponent(returnOutcome.evidence_id)}/reconcile`, {
      status: "returned",
      receipt: outboundRef,
    });
    const reversed = (await outcomes()).find((o) => o.evidence_id === returnOutcome.evidence_id);
    if (reversed?.status_kind !== "reversed") {
      throw new Error(`reconciling a return gave ${reversed?.status_kind}, not reversed`);
    }
    if (reversed.committed) {
      throw new Error("a returned transfer is still counted against the mandate");
    }
    // And now the invoice can be paid again, to a corrected account.
    const replacementAuth = `auth-replacement-${run}`;
    await post(session, "/intent", {
      text: `Pay ${supplier.nameOnAccount} ${AMOUNT} EUR for invoice ${returnInvoice} to ${supplier.iban}.`,
    });
    await authorize(replacementAuth, `${returnInvoice}-R`, supplier.iban, supplier.nameOnAccount);
    const replacement = structured<{ receipt: string }>(
      await transfer({
        beneficiary_name: supplier.nameOnAccount,
        iban: supplier.iban,
        reference: `${returnInvoice}-R`,
        authorization_id: replacementAuth,
        invoice_id: `${returnInvoice}-R`,
      }),
    );
    findings["settled_then_returned"] = {
      bank_reference: outboundRef,
      reason: returned.reasonCode,
      returned_at: returned.returnedAt,
      replacement_refused_while_outstanding: whileOutstanding,
      moat_status_after_reconcile: reversed.status_kind,
      counted_against_mandate: reversed.committed,
      replacement_reference: replacement.receipt,
    };

    // Moat's record against the bank's.
    const all = await bank.listTransfers();
    const moatCommitted = (await outcomes()).filter((o) => o.committed).length;
    findings["reconciliation"] = {
      transfers_at_the_bank: all.length,
      outcomes_moat_holds: (await outcomes()).length,
      committed_against_mandates: moatCommitted,
      refused_before_the_bank_heard: 2,
    };
    if (all.length !== 4) {
      throw new Error(`the bank holds ${all.length} transfers, expected 4`);
    }

    process.stdout.write(
      JSON.stringify(
        { result: "PASS", provider: bank.id, session, state_dir: stateDir, findings },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await client.close();
  }
}

await main();
