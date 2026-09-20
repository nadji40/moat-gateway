// The public sandbox: a gateway anyone can point a payment at.
//
// Two surfaces over the same thing. A page where you compose the attack
// yourself -- what the user asked for, what the approver signed, what the
// agent then tries -- and an HTTP API with the same four calls, so the
// interesting version is driving it from your own agent rather than from
// a form.
//
// The API is deliberately not a copy of Moat's own. This exposes the four
// verbs a visitor needs and nothing else: no tenants, no keys, no
// reconciliation, no cancellation. A public sandbox that exposed the
// control plane would be demonstrating the wrong thing.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chainDemo, chainState } from "./chain.js";
import { runSuite, TESTS } from "./suite.js";
import {
  authorize,
  create,
  destroy,
  evidence,
  intent,
  LIMITS,
  pay,
  SandboxError,
  stats,
  type SandboxConfig,
} from "./sandbox.js";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(HERE, "public");
const CFG: SandboxConfig = {
  repo: resolve(HERE, ".."),
  config: process.env["MOAT_DEMO_CONFIG"] ?? join(resolve(HERE, ".."), "arena", "moat.demo.yaml"),
  api: process.env["MOAT_DEMO_INTENT_API"] ?? "http://127.0.0.1:7090",
  keys: process.env["MOAT_DEMO_KEYS"] ?? join(resolve(HERE, ".."), "arena", "keys"),
};
const PORT = Number(process.env["MOAT_DEMO_PORT"] ?? "8787");

/** Requests per address per minute, so one script cannot hold the page. */
const WINDOW_MS = 60_000;
const PER_WINDOW = 90;
const seen = new Map<string, { n: number; from: number }>();
/** Addresses with a suite in flight, so nobody can start nine more. */
const running = new Set<string>();

function caller(h: Record<string, string | string[] | undefined>): string {
  const fwd = h["cf-connecting-ip"] ?? h["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  const ip = (raw ?? "local").split(",")[0]!.trim();
  // Hashed: a counter works as well on a digest, and the page has no
  // business holding anyone's address.
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function overLimit(who: string): boolean {
  const now = Date.now();
  const s = seen.get(who);
  if (!s || now - s.from > WINDOW_MS) {
    seen.set(who, { n: 1, from: now });
    return false;
  }
  s.n += 1;
  return s.n > PER_WINDOW;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // A public endpoint should not accept an arbitrarily large body.
    if (size > 64 * 1024) throw new SandboxError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new SandboxError(400, "body is not valid JSON");
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    });
    return res.end();
  }

  try {
    if (path.startsWith("/v1/")) {
      if (overLimit(caller(req.headers))) {
        return json(res, 429, { error: "too many requests from here; wait a minute" });
      }
    }

    if (path === "/v1/tests") {
      return json(res, 200, { tests: TESTS });
    }

    if (path === "/v1/suite" && method === "POST") {
      const only = url.searchParams.get("test") ?? undefined;
      // A suite run is nine gateway processes; one per address at a time.
      if (running.has(caller(req.headers))) {
        return json(res, 429, { error: "a suite is already running for you" });
      }
      running.add(caller(req.headers));
      try {
        return json(res, 200, { results: await runSuite(CFG, only) });
      } finally {
        running.delete(caller(req.headers));
      }
    }

    if (path === "/v1/limits") {
      return json(res, 200, { ...stats(), ...LIMITS, chain: chainState() });
    }

    if (path === "/v1/sandbox" && method === "POST") {
      return json(res, 201, await create(CFG));
    }

    const m = /^\/v1\/sandbox\/([A-Za-z0-9_-]{1,32})(\/[a-z]+)?$/.exec(path);
    if (m) {
      const id = m[1]!;
      const leaf = m[2] ?? "";
      if (leaf === "/intent" && method === "POST") {
        const body = await readJson(req);
        const text = String(body["text"] ?? "").slice(0, 4000);
        if (!text.trim()) return json(res, 400, { error: "intent text is required" });
        await intent(CFG, id, text);
        return json(res, 200, { ok: true });
      }
      if (leaf === "/authorization" && method === "POST") {
        return json(res, 200, await authorize(CFG, id, await readJson(req)));
      }
      if (leaf === "/pay" && method === "POST") {
        return json(res, 200, await pay(CFG, id, await readJson(req)));
      }
      if (leaf === "/evidence" && method === "GET") {
        return json(res, 200, await evidence(CFG, id));
      }
      if (leaf === "" && method === "DELETE") {
        await destroy(id);
        return json(res, 200, { ok: true });
      }
    }

    if (path === "/v1/chain" && method === "POST") {
      const outcome = await chainDemo(caller(req.headers), url.searchParams.get("mode") ?? "approved");
      return json(res, outcome.status, outcome.body);
    }

    if (path.startsWith("/v1/")) return json(res, 404, { error: "no such endpoint" });

    const wanted = path === "/" ? "/index.html" : path;
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
    if (error instanceof SandboxError) return json(res, error.status, { error: error.message });
    process.stderr.write(`demo: ${String(error)}\n`);
    return json(res, 500, { error: "the sandbox could not complete that" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`moat sandbox on http://127.0.0.1:${PORT}\n`);
});
