// Measures what the gateway adds to a passthrough tool call on localhost.
// Calls mock-stripe's list_payments N times directly over stdio and N times
// through the gateway (stdio -> gateway -> stdio), same process, same
// machine, and prints p50/p95 for each and the difference.
//
//   pnpm --filter @moat/runner bench [--n 500]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gatewayBinary } from "./gateway.js";
import { percentile } from "./results.js";

const here = dirname(fileURLToPath(import.meta.url));
const ARENA_ROOT = resolve(here, "..", "..");

async function client(command: string, args: string[], env: Record<string, string>): Promise<Client> {
  const c = new Client({ name: "moat-bench", version: "0.1.0" });
  await c.connect(new StdioClientTransport({ command, args, env, cwd: ARENA_ROOT, stderr: "ignore" }));
  return c;
}

async function measure(c: Client, tool: string, n: number): Promise<number[]> {
  // Warm up: first calls include JIT and page-cache effects on both sides.
  for (let i = 0; i < 20; i++) await c.callTool({ name: tool, arguments: {} });
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await c.callTool({ name: tool, arguments: {} });
    out.push(performance.now() - t0);
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: { n: { type: "string", default: "500" } },
  });
  const n = Number(values.n);
  const work = mkdtempSync(join(tmpdir(), "moat-bench-"));
  const env = {
    ...(process.env as Record<string, string>),
    PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
    MOCK_STRIPE_LEDGER: join(work, "ledger.json"),
    RUST_LOG: "moat_gateway=error",
  };
  try {
    const direct = await client(process.execPath, ["--import", "tsx", "mock-stripe/src/server.ts"], env);
    const d = await measure(direct, "list_payments", n);
    await direct.close();

    const gateway = await client(
      gatewayBinary(ARENA_ROOT),
      ["--config", join(ARENA_ROOT, "moat.bench.yaml"), "--session-id", "bench"],
      env,
    );
    const g = await measure(gateway, "stripe__list_payments", n);
    await gateway.close();

    const f = (x: number | undefined): string => (x === undefined ? "n/a" : x.toFixed(2));
    const d50 = percentile(d, 50) ?? 0;
    const d95 = percentile(d, 95) ?? 0;
    const g50 = percentile(g, 50) ?? 0;
    const g95 = percentile(g, 95) ?? 0;
    process.stdout.write(
      [
        `passthrough tool call latency, n=${n} per mode, localhost, stdio`,
        `  direct  (client -> mock-stripe):            p50 ${f(d50)} ms  p95 ${f(d95)} ms`,
        `  gateway (client -> moat-gateway -> mock-stripe): p50 ${f(g50)} ms  p95 ${f(g95)} ms`,
        `  added by the gateway:                       p50 ${f(g50 - d50)} ms  p95 ${f(g95 - d95)} ms`,
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`bench: ${String(err)}\n`);
  process.exit(1);
});
