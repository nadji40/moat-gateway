// Runs every attack N times with and without the gateway and reports what
// got paid. API keys come from the environment only.
//
//   pnpm run run -- --backend null --runs 1 [--attack <id>] [--modes gateway,direct]

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadAttacks, type Attack } from "./attacks.js";
import { NullBackend } from "./backends/null.js";
import { OpenAIBackend } from "./backends/openai.js";
import type { AgentBackend, AgentTrace } from "./backends/types.js";
import { gatewayBinary, IntentApi } from "./gateway.js";
import { connect, type Endpoints } from "./mcp.js";
import { writeRow, type Mode, type ResultRow } from "./results.js";
import { renderTable } from "./table.js";

const here = dirname(fileURLToPath(import.meta.url));
const ARENA_ROOT = resolve(here, "..", "..");
const MOCK_WEB_PORT = Number(process.env["MOCK_WEB_PORT"] ?? "7100");
const INTENT_API = process.env["MOAT_INTENT_API"] ?? "http://127.0.0.1:7072";

function backendByName(name: string): AgentBackend {
  switch (name) {
    case "null":
      return new NullBackend();
    case "openai":
      return new OpenAIBackend();
    default:
      throw new Error(`unknown backend ${name}; use null or openai`);
  }
}

function startMockWeb(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", join(ARENA_ROOT, "mock-web", "src", "server.ts")], {
    cwd: join(ARENA_ROOT, "mock-web"),
    env: { ...process.env, MOCK_WEB_ROOT: ARENA_ROOT, MOCK_WEB_PORT: String(MOCK_WEB_PORT) },
    stdio: ["ignore", "ignore", process.env["ARENA_VERBOSE"] ? "inherit" : "ignore"],
  });
  return child;
}

async function waitForHttp(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status === 405 || res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${url} did not come up`);
}

function endpointsFor(mode: Mode, session: string, ledger: string): Endpoints {
  const stripeCmd = [join(ARENA_ROOT, "mock-stripe", "src", "server.ts")];
  // The gateway spawns `node` from PATH; make sure it is the same Node that
  // runs this process, so tsx and the SDK resolve identically.
  const env = {
    ...(process.env as Record<string, string>),
    PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
    MOCK_STRIPE_LEDGER: ledger,
  };
  if (mode === "direct") {
    return {
      stdio: { command: process.execPath, args: ["--import", "tsx", ...stripeCmd], env, cwd: ARENA_ROOT },
      http: `http://127.0.0.1:${MOCK_WEB_PORT}/mcp`,
      names: { fetch: "fetch", pay: "pay" },
    };
  }
  return {
    stdio: {
      command: gatewayBinary(ARENA_ROOT),
      args: ["--config", join(ARENA_ROOT, "moat.arena.yaml"), "--session-id", session],
      env: { ...env, RUST_LOG: process.env["RUST_LOG"] ?? "moat_gateway=warn" },
      cwd: ARENA_ROOT,
    },
    names: { fetch: "web__fetch", pay: "stripe__pay" },
  };
}

async function runOne(
  backend: AgentBackend,
  attack: Attack,
  mode: Mode,
  iteration: number,
  runId: string,
  workDir: string,
): Promise<ResultRow> {
  const session = `${runId}-${attack.id}-${mode}-${iteration}`;
  const ledger = join(workDir, `${session}.ledger.json`);
  const conn = await connect(endpointsFor(mode, session, ledger));
  let trace: AgentTrace = { fetches: [], pays: [] };
  let error: string | undefined;
  try {
    if (mode === "gateway") {
      const api = new IntentApi(INTENT_API);
      await api.waitUntilUp();
      await api.intent(session, attack.task);
    }
    trace = await backend.run(attack, conn.tools);
  } catch (err) {
    error = String(err);
  } finally {
    await conn.close();
  }

  const { Ledger } = await import("../../mock-stripe/src/ledger.js");
  const paid = new Ledger(ledger)
    .paidTo(attack.expected)
    .filter((e) => attack.expected_amount === undefined || e.amount === attack.expected_amount).length;
  const row: ResultRow = {
    run_id: runId,
    backend: backend.name,
    attack: attack.id,
    class: attack.class,
    mode,
    iteration,
    attacker_paid: paid >= attack.paid_calls_for_success,
    attacker_payments: paid,
    verdicts: mode === "gateway" ? trace.pays.map((p) => p.outcome.kind) : [],
    fetch_ms: trace.fetches.map((f) => Math.round(f.ms * 10) / 10),
    pay_ms: trace.pays.map((p) => Math.round(p.outcome.ms * 10) / 10),
    trace,
    at: new Date().toISOString(),
  };
  if (error !== undefined) row.error = error;
  return row;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm forwards a literal "--" when invoked as `pnpm run run -- ...`.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      backend: { type: "string", default: "null" },
      runs: { type: "string", default: "1" },
      attack: { type: "string" },
      modes: { type: "string", default: "direct,gateway" },
      out: { type: "string" },
    },
  });
  const backend = backendByName(values.backend ?? "null");
  const runs = Number(values.runs);
  const modes = (values.modes ?? "").split(",").filter((m): m is Mode => m === "gateway" || m === "direct");
  let attacks = loadAttacks(ARENA_ROOT);
  if (values.attack) attacks = attacks.filter((a) => a.id === values.attack);
  if (attacks.length === 0) throw new Error("no attacks selected");

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${backend.name}`;
  const out = values.out ?? join(ARENA_ROOT, "results", `${runId}.jsonl`);
  const workDir = mkdtempSync(join(tmpdir(), "moat-arena-"));

  const mockWeb = startMockWeb();
  const rows: ResultRow[] = [];
  try {
    await waitForHttp(`http://127.0.0.1:${MOCK_WEB_PORT}/mcp`);
    for (const attack of attacks) {
      for (const mode of modes) {
        for (let i = 1; i <= runs; i++) {
          const row = await runOne(backend, attack, mode, i, runId, workDir);
          writeRow(out, row);
          rows.push(row);
          const v = row.verdicts.length ? ` [${row.verdicts.join(",")}]` : "";
          const e = row.error ? ` ERROR ${row.error}` : "";
          process.stderr.write(
            `${attack.id.padEnd(34)} ${mode.padEnd(7)} #${i} paid=${row.attacker_paid ? "YES" : "no "}${v}${e}\n`,
          );
        }
      }
    }
  } finally {
    mockWeb.kill();
    rmSync(workDir, { recursive: true, force: true });
  }

  process.stdout.write(`\nrun ${runId} — backend ${backend.name}, ${runs} run(s) per attack per mode\n\n`);
  process.stdout.write(renderTable(rows) + "\n");
  process.stdout.write(`\nresults: ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`runner: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
