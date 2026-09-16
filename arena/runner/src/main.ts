// Runs every attack N times with and without the gateway and reports what
// got paid. API keys come from the environment only.
//
//   pnpm --filter @moat/runner start --backend null --runs 1
//   pnpm --filter @moat/runner start --backend openai --runs 1 --model gpt-5.6-luna

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadAttacks, type Attack } from "./attacks.js";
import { ARENA_ROOT, contextFor, mockWebPort } from "./context.js";
import { NullBackend } from "./backends/null.js";
import { DEFAULT_MODEL, OpenAIBackend } from "./backends/openai.js";
import type { AgentBackend, AgentTrace } from "./backends/types.js";
import { writeRow, type Mode, type ResultRow } from "./results.js";
import { renderTable } from "./table.js";


function backendByName(name: string, model: string): AgentBackend {
  switch (name) {
    case "null":
      return new NullBackend();
    case "openai":
      if (!process.env["OPENAI_API_KEY"]) {
        throw new Error(
          "the openai backend needs OPENAI_API_KEY in the environment; " +
            "export it, or use --backend null",
        );
      }
      return new OpenAIBackend(model);
    default:
      throw new Error(`unknown backend ${name}; use null or openai`);
  }
}

function startMockWeb(): ChildProcess {
  return spawn(
    process.execPath,
    ["--import", "tsx", join(ARENA_ROOT, "mock-web", "src", "server.ts")],
    {
      cwd: join(ARENA_ROOT, "mock-web"),
      env: { ...process.env, MOCK_WEB_ROOT: ARENA_ROOT, MOCK_WEB_PORT: String(mockWebPort()) },
      stdio: ["ignore", "ignore", process.env["ARENA_VERBOSE"] ? "inherit" : "ignore"],
    },
  );
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
  let trace: AgentTrace = { fetches: [], pays: [] };
  let error: string | undefined;
  const t0 = performance.now();
  try {
    trace = await backend.run(attack, contextFor(mode, session, ledger));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Math.round(performance.now() - t0);

  const { Ledger } = await import("../../mock-stripe/src/ledger.js");
  const paid = new Ledger(ledger)
    .paidTo(attack.expected)
    .filter((e) => attack.expected_amount === undefined || e.amount === attack.expected_amount)
    .length;

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
    wall_ms: wallMs,
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
      model: { type: "string", default: DEFAULT_MODEL },
      out: { type: "string" },
    },
  });
  const backend = backendByName(values.backend ?? "null", values.model ?? DEFAULT_MODEL);
  const runs = Number(values.runs);
  const modes = (values.modes ?? "")
    .split(",")
    .filter((m): m is Mode => m === "gateway" || m === "direct");
  let attacks = loadAttacks(ARENA_ROOT);
  if (values.attack) attacks = attacks.filter((a) => a.id === values.attack);
  if (attacks.length === 0) throw new Error("no attacks selected");

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${backend.name}`;
  const out = values.out ?? join(ARENA_ROOT, "results", `${runId}.jsonl`);
  const workDir = mkdtempSync(join(tmpdir(), "moat-arena-"));

  const mockWeb = startMockWeb();
  const rows: ResultRow[] = [];
  try {
    await waitForHttp(`http://127.0.0.1:${mockWebPort()}/mcp`);
    for (const attack of attacks) {
      for (const mode of modes) {
        for (let i = 1; i <= runs; i++) {
          const row = await runOne(backend, attack, mode, i, runId, workDir);
          writeRow(out, row);
          rows.push(row);
          const v = row.verdicts.length ? ` [${row.verdicts.join(",")}]` : "";
          const e = row.error ? ` ERROR ${row.error}` : "";
          process.stderr.write(
            `${attack.id.padEnd(26)} ${mode.padEnd(7)} #${i} ${String(row.wall_ms).padStart(6)}ms ` +
              `paid=${row.attacker_paid ? "YES" : "no "}${v}${e}\n`,
          );
        }
      }
    }
  } finally {
    mockWeb.kill();
    rmSync(workDir, { recursive: true, force: true });
  }

  const modelNote = backend.name === "openai" ? `, model ${values.model}` : "";
  process.stdout.write(
    `\nrun ${runId} — backend ${backend.name}${modelNote}, ${runs} run(s) per attack per mode\n\n`,
  );
  process.stdout.write(renderTable(rows) + "\n");
  process.stdout.write(`\nresults: ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `runner: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
