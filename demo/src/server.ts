// The public try-it service.
//
// It serves one page and runs real verdicts behind it. Each run spawns its
// own gateway process with its own session and kills it afterwards, so one
// visitor can never see or affect another's state. That costs about two
// seconds a run and is worth it: the alternative is a shared session on a
// public endpoint, which is a different demonstration entirely.
//
// What is deliberately not here: no accounts, no database, no persistence.
// The only mutable state is a spend counter, and it is in memory, so a
// restart is also a reset.
//
// Safety, because this is public and one path spends real value:
//
//   The gateway it drives talks to the arena's mock payment server, so the
//   scenario buttons move nothing anywhere.
//
//   The one button that does move value uses a wallet funded on purpose
//   with almost nothing, separate from the wallets the smoke scripts use.
//   It is rate limited per address and capped in total, and the cap is
//   enforced here rather than by hoping the balance lasts.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { SCENARIOS, scenario } from "./scenarios.js";
import { chainDemo, chainState } from "./chain.js";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(HERE, "..");
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env["MOAT_DEMO_PORT"] ?? "8787");
const CONFIG = process.env["MOAT_DEMO_CONFIG"] ?? join(REPO, "arena", "moat.demo.yaml");
const DENY = -31051;
const STEP_UP = -31050;

const GATEWAY = [
  join(REPO, "target", "release", "moat-gateway.exe"),
  join(REPO, "target", "release", "moat-gateway"),
].find(existsSync);

/** A crude per-address budget, so one visitor cannot hold the whole page. */
const RUNS = new Map<string, { count: number; first: number }>();
const RUN_WINDOW_MS = 60_000;
const RUNS_PER_WINDOW = 20;

function allowed(who: string): boolean {
  const now = Date.now();
  const seen = RUNS.get(who);
  if (!seen || now - seen.first > RUN_WINDOW_MS) {
    RUNS.set(who, { count: 1, first: now });
    return true;
  }
  seen.count += 1;
  return seen.count <= RUNS_PER_WINDOW;
}

/** The caller, as well as a tunnel lets us know it. */
function caller(headers: Record<string, string | string[] | undefined>): string {
  const forwarded = headers["cf-connecting-ip"] ?? headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = (raw ?? "local").split(",")[0]!.trim();
  // Hashed: the page has no reason to hold anyone's address, and the
  // counter works just as well on a digest.
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

interface Verdict {
  decision: "allow" | "deny" | "step_up";
  reasons: { id: string; passed: boolean; message: string }[];
  evidenceId?: string;
}

/**
 * Run one scenario through a real gateway and report what it decided.
 *
 * The session is thrown away afterwards. The intent is registered as the
 * user's own words, which is what gives those words provenance; everything
 * the agent then tries is measured against them.
 */
async function run(id: string): Promise<{ verdict: Verdict; ledger: boolean }> {
  const s = scenario(id);
  if (!s) throw new Error(`no scenario ${id}`);
  if (!GATEWAY) throw new Error("the gateway binary is not built");

  const session = `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const api = process.env["MOAT_DEMO_INTENT_API"] ?? "http://127.0.0.1:7090";
  const client = new Client({ name: "moat-demo", version: "0.1.0" });
  const ledgerPath = join(
    process.env["TMPDIR"] ?? process.env["TEMP"] ?? "/tmp",
    `moat-demo-${session}.json`,
  );

  await client.connect(
    new StdioClientTransport({
      command: GATEWAY,
      args: ["--config", CONFIG, "--session-id", session],
      cwd: join(REPO, "arena"),
      env: { ...process.env, MOCK_STRIPE_LEDGER: ledgerPath } as Record<string, string>,
      stderr: "ignore",
    }),
  );

  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        const probe = await fetch(`${api}/v1/session/${encodeURIComponent(session)}/evidence`);
        if (probe.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // The user's own words. This is the only channel that confers authority.
    await fetch(`${api}/v1/session/${encodeURIComponent(session)}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: s.task }),
    });

    const args: Record<string, unknown> = { ...s.call };
    if (s.authorization) {
      const authorizationId = `auth-${session}`;
      const invoiceId = `INV-${session}`;
      await fetch(`${api}/v1/session/${encodeURIComponent(session)}/authorizations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authorization_id: authorizationId,
          invoice_id: invoiceId,
          payee: s.authorization.payee,
          amount: s.authorization.amount,
          tolerance: 0,
          currency: s.authorization.currency,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          repeat_payments: false,
          max_payments: 1,
        }),
      });
      args["authorization_id"] = authorizationId;
      args["invoice_id"] = invoiceId;
    }

    let verdict: Verdict;
    try {
      await client.callTool({ name: "stripe__pay", arguments: args });
      verdict = { decision: "allow", reasons: [] };
    } catch (error) {
      if (!(error instanceof McpError) || (error.code !== DENY && error.code !== STEP_UP)) {
        throw error;
      }
      const data = error.data as {
        moat?: { reasons?: { id: string; passed: boolean; message: string }[]; evidence_id?: string };
      };
      verdict = {
        decision: error.code === DENY ? "deny" : "step_up",
        reasons: (data.moat?.reasons ?? []).filter((r) => !r.passed),
        ...(data.moat?.evidence_id ? { evidenceId: data.moat.evidence_id } : {}),
      };
    }

    // The evidence record, so the page can show that the verdict was
    // written down and signed rather than merely returned.
    let evidenceId = verdict.evidenceId;
    if (!evidenceId) {
      try {
        const res = await fetch(`${api}/v1/session/${encodeURIComponent(session)}/evidence`);
        const body = (await res.json()) as { evidence?: { id: string }[] };
        evidenceId = body.evidence?.at(-1)?.id;
      } catch {
        /* the page copes without it */
      }
    }

    // Did the mock provider actually take money? The only honest way to
    // answer "was the attacker paid".
    let ledger = false;
    try {
      const entries = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown[];
      ledger = Array.isArray(entries) && entries.length > 0;
    } catch {
      /* no ledger written means nothing was paid */
    }

    return { verdict: { ...verdict, ...(evidenceId ? { evidenceId } : {}) }, ledger };
  } finally {
    await client.close().catch(() => {});
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const who = caller(req.headers);

  // Nothing here is worth framing, embedding or sniffing.
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");

  try {
    if (url.pathname === "/api/scenarios") {
      return json(res, 200, { scenarios: SCENARIOS, chain: chainState() });
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      if (!allowed(who)) {
        return json(res, 429, { error: "too many runs from here; wait a minute" });
      }
      const id = url.searchParams.get("scenario") ?? "";
      if (!scenario(id)) return json(res, 400, { error: "unknown scenario" });
      const started = Date.now();
      const { verdict, ledger } = await run(id);
      return json(res, 200, { verdict, paid: ledger, ms: Date.now() - started });
    }

    if (url.pathname === "/api/chain" && req.method === "POST") {
      if (!allowed(who)) {
        return json(res, 429, { error: "too many runs from here; wait a minute" });
      }
      const outcome = await chainDemo(who, url.searchParams.get("mode") ?? "approved");
      return json(res, outcome.status, outcome.body);
    }

    // Static files, from one directory, resolved and then checked.
    const wanted = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = resolve(PUBLIC, `.${wanted}`);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    return res.end(readFileSync(file));
  } catch (error) {
    // Never leak an internal error to a public page.
    process.stderr.write(`demo: ${String(error)}\n`);
    return json(res, 500, { error: "the demo could not complete that run" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `moat demo on http://127.0.0.1:${PORT} (gateway ${GATEWAY ?? "NOT BUILT"})\n`,
  );
});
