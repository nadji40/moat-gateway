// A gateway of your own, for ten minutes.
//
// The point of this service is that a visitor composes the attack rather
// than picking one off a list: they say what the user asked for, they say
// what the approver signed off, and then they try whatever payment they
// like and watch Moat decide. That needs state between requests, so each
// sandbox holds a live gateway process with its own session and its own
// mock provider, and hands back an id.
//
// Which makes the pool the interesting part. A public endpoint that spawns
// a process per visitor is a way to run out of a server, so:
//
//   a hard ceiling on live sandboxes, and a new request past it is
//   refused rather than queued -- a slow page is a worse answer than a
//   clear "come back in a minute";
//
//   an idle timeout, because most visitors try two things and leave;
//
//   an absolute lifetime, because a tab left open all afternoon should
//   not hold a process all afternoon;
//
//   and a cap on how many payments one sandbox will evaluate, so a script
//   pointed at the API cannot turn one sandbox into unbounded work.
//
// Everything a sandbox holds dies with it. There is no database here and
// no way for one visitor to name another's session: the ids are random
// and the only thing they index is a process that will be gone shortly.

import { createServer } from "node:net";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

const NEWLINE = String.fromCharCode(10);
const DENY = -31051;
const STEP_UP = -31050;

export interface SandboxLimits {
  readonly maxLive: number;
  readonly idleMs: number;
  readonly lifetimeMs: number;
  readonly maxCalls: number;
}

export const LIMITS: SandboxLimits = {
  maxLive: Number(process.env["MOAT_DEMO_MAX_SANDBOXES"] ?? "12"),
  idleMs: 10 * 60_000,
  lifetimeMs: 30 * 60_000,
  maxCalls: 40,
};

export interface Verdict {
  decision: "allow" | "deny" | "step_up";
  reasons: { id: string; passed: boolean; message: string }[];
  evidence_id?: string;
  /** Whether the mock provider actually took the payment. */
  paid: boolean;
  ms: number;
}

interface Live {
  id: string;
  client: Client;
  session: string;
  created: number;
  touched: number;
  calls: number;
  ledger: string;
  /** This sandbox's own intent API, on a port nobody else has. */
  api: string;
  /** Generated config and evidence chain, removed when the sandbox dies. */
  configPath: string;
  evidencePath: string;
}

/** A port the kernel just told us was free. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * The environment a gateway child needs.
 *
 * The gateway spawns `node` from PATH to run the mock provider, so it has
 * to be the same Node that is running this service -- under systemd the
 * binary may be installed under another name entirely, and a PATH without
 * a plain `node` on it makes the gateway exit the moment it tries. The
 * arena learned this first; the symptom here is an MCP connection that
 * closes immediately and says nothing about why.
 */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...(process.env as Record<string, string>),
    [key]: `${dirname(process.execPath)}${delimiter}${process.env[key] ?? ""}`,
    ...extra,
  };
}

const live = new Map<string, Live>();

export function stats(): { live: number; max: number } {
  return { live: live.size, max: LIMITS.maxLive };
}

function reap(): void {
  const now = Date.now();
  for (const [id, s] of live) {
    if (now - s.touched > LIMITS.idleMs || now - s.created > LIMITS.lifetimeMs) {
      destroy(id).catch(() => {});
    }
  }
}
setInterval(reap, 30_000).unref();

export async function destroy(id: string): Promise<void> {
  const s = live.get(id);
  if (!s) return;
  // Unreachable from this moment: nothing can route to it once it is out of
  // the map, and the slot it occupied is free.
  live.delete(id);
  // The caller does not need to watch a process die. Closing the transport
  // waits for the gateway and the mock provider it spawned to exit, which was
  // two seconds of a DELETE that had already done its job. Reaping continues
  // in the background; a stray process outlives the response by a moment and
  // nothing observable depends on it.
  void reapSandbox(s);
}

async function reapSandbox(s: Live): Promise<void> {
  await s.client.close().catch(() => {});
  for (const path of [s.configPath, s.evidencePath, s.ledger]) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* the sandbox is gone either way */
    }
  }
}

export class SandboxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function gatewayBinary(repo: string): string {
  const found = [
    join(repo, "target", "release", "moat-gateway.exe"),
    join(repo, "target", "release", "moat-gateway"),
  ].find(existsSync);
  if (!found) throw new SandboxError(503, "the gateway binary is not built on this host");
  return found;
}

export interface SandboxConfig {
  readonly repo: string;
  readonly config: string;
  readonly api: string;
  /** A writable directory for the per-sandbox evidence signing key. */
  readonly keys: string;
}

/** Start a gateway and wait for its intent API to answer. */
export async function create(cfg: SandboxConfig): Promise<{ id: string; expires_in_s: number }> {
  reap();
  if (live.size >= LIMITS.maxLive) {
    throw new SandboxError(
      503,
      `all ${LIMITS.maxLive} sandboxes are in use; they expire quickly, try again shortly`,
    );
  }
  const id = randomBytes(9).toString("base64url");
  const session = `sandbox-${id}`;
  const tmp = tmpdir();
  const ledger = join(tmp, `moat-sandbox-${id}.json`);
  const evidencePath = join(tmp, `moat-sandbox-${id}.evidence.jsonl`);
  const configPath = join(tmp, `moat-sandbox-${id}.yaml`);

  // Its own port, because every gateway in the pool would otherwise try to
  // bind the one in the shared config. Only the first would win, and the
  // rest would quietly send their intents to that first gateway -- one
  // visitor's words registered against another visitor's session, which is
  // the most misleading failure this service could have.
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  // Its own evidence file too: the chain is hash-linked, and several
  // processes appending to one file produce a chain that verifies against
  // nothing.
  writeFileSync(
    configPath,
    [
      "listen: { transport: stdio }",
      "upstreams:",
      "  - name: stripe",
      "    transport: stdio",
      '    command: ["node", "--import", "tsx", "mock-stripe/src/server.ts"]',
      `policy: ${join(cfg.repo, "policies", "default.yaml").split("\\").join("/")}`,
      `evidence: ${evidencePath.split("\\").join("/")}`,
      // Its own key directory, not the arena's. The arena's evidence key is
      // readable only by whoever created it, and a service running as
      // another user gets "Permission denied" the moment it starts -- which
      // surfaces to the caller as an MCP connection closing and nothing
      // else. A sandbox is ephemeral, so a key generated for it is right
      // anyway: its evidence chain is its own and dies with it.
      `keys: ${cfg.keys.split("\\").join("/")}`,
      `intent_api: { addr: "127.0.0.1:${port}" }`,
      "",
    ].join(NEWLINE),
    "utf8",
  );

  const client = new Client({ name: "moat-sandbox", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: gatewayBinary(cfg.repo),
      args: ["--config", configPath, "--session-id", session],
      cwd: join(cfg.repo, "arena"),
      env: childEnv({ MOCK_STRIPE_LEDGER: ledger }),
      stderr: "ignore",
    }),
  );
  const now = Date.now();
  live.set(id, {
    id, client, session, created: now, touched: now, calls: 0,
    ledger, api, configPath, evidencePath,
  });

  // Ramp the wait instead of sleeping a flat 100ms. The gateway is usually
  // listening in a few tens of milliseconds, and a fixed tick meant a process
  // that was ready at 30ms still cost a full 100, several times over. Same
  // overall deadline, most of the idle time gone.
  const deadline = Date.now() + 8_000;
  for (let wait = 5; Date.now() < deadline; wait = Math.min(wait * 2, 100)) {
    try {
      if ((await fetch(`${api}/v1/session/${encodeURIComponent(session)}/evidence`)).ok) {
        return { id, expires_in_s: Math.round(LIMITS.idleMs / 1000) };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, wait));
  }
  await destroy(id);
  throw new SandboxError(503, "the gateway did not come up in time");
}

/** How many payments the mock provider has taken in this sandbox. */
function ledgerCount(path: string): number {
  try {
    const entries = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

function get(id: string): Live {
  const s = live.get(id);
  if (!s) {
    throw new SandboxError(404, "no such sandbox, or it expired; create a new one");
  }
  s.touched = Date.now();
  return s;
}

/** Register what the user asked for, in their own words. */
export async function intent(cfg: SandboxConfig, id: string, text: string): Promise<void> {
  const s = get(id);
  const res = await fetch(`${s.api}/v1/session/${encodeURIComponent(s.session)}/intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new SandboxError(400, (await res.text()).slice(0, 300));
}

/** Register what an approver signed off. */
export async function authorize(
  cfg: SandboxConfig,
  id: string,
  body: Record<string, unknown>,
): Promise<{ authorization_id: string; invoice_id: string }> {
  const s = get(id);
  const authorization_id = String(body["authorization_id"] ?? `auth-${randomBytes(4).toString("hex")}`);
  const invoice_id = String(body["invoice_id"] ?? `INV-${randomBytes(4).toString("hex")}`);
  const payload = {
    ...body,
    authorization_id,
    invoice_id,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    // Repeatable by default. A single-use mandate is the right production
    // default and the wrong sandbox default: the second thing a visitor
    // tries would be refused as a duplicate, which teaches them about
    // replay protection when they were asking about provenance.
    repeat_payments: body["repeat_payments"] ?? true,
    max_payments: body["max_payments"] ?? 20,
    tolerance: body["tolerance"] ?? 0,
  };
  const res = await fetch(`${s.api}/v1/session/${encodeURIComponent(s.session)}/authorizations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new SandboxError(400, (await res.text()).slice(0, 400));
  return { authorization_id, invoice_id };
}

/** Attempt a payment, and report what Moat decided about it. */
export async function pay(
  cfg: SandboxConfig,
  id: string,
  args: Record<string, unknown>,
): Promise<Verdict> {
  const s = get(id);
  if (s.calls >= LIMITS.maxCalls) {
    throw new SandboxError(429, `this sandbox has evaluated its ${LIMITS.maxCalls} payments`);
  }
  s.calls += 1;
  const started = Date.now();

  // Each attempt is its own invoice unless the caller names one, so trying
  // a second payment is a second payment rather than a replay of the first.
  const call: Record<string, unknown> = {
    ...args,
    invoice_id: args["invoice_id"] ?? `INV-${randomBytes(4).toString("hex")}`,
  };

  // What the provider had been paid before this call, so "paid" can mean
  // this payment rather than any payment this sandbox ever made.
  const before = ledgerCount(s.ledger);

  let decision: Verdict["decision"] = "allow";
  let reasons: Verdict["reasons"] = [];
  let evidence_id: string | undefined;
  try {
    await s.client.callTool({ name: "stripe__pay", arguments: call });
  } catch (error) {
    if (!(error instanceof McpError) || (error.code !== DENY && error.code !== STEP_UP)) {
      throw new SandboxError(400, String((error as Error).message).slice(0, 300));
    }
    decision = error.code === DENY ? "deny" : "step_up";
    const data = error.data as {
      moat?: { reasons?: Verdict["reasons"]; evidence_id?: string };
    };
    reasons = (data.moat?.reasons ?? []).filter((r) => !r.passed);
    evidence_id = data.moat?.evidence_id;
  }

  // The ledger is the only honest answer to "was anyone actually paid",
  // and the delta is the only honest answer to "by this call".
  const paid = ledgerCount(s.ledger) > before;

  if (!evidence_id) {
    try {
      const res = await fetch(`${s.api}/v1/session/${encodeURIComponent(s.session)}/evidence`);
      const body = (await res.json()) as { evidence?: { id: string }[] };
      evidence_id = body.evidence?.at(-1)?.id;
    } catch {
      /* the caller copes without it */
    }
  }

  return {
    decision,
    reasons,
    ...(evidence_id ? { evidence_id } : {}),
    paid,
    ms: Date.now() - started,
  };
}

/** The signed record of everything this sandbox decided. */
export async function evidence(cfg: SandboxConfig, id: string): Promise<unknown> {
  const s = get(id);
  const res = await fetch(`${s.api}/v1/session/${encodeURIComponent(s.session)}/evidence`);
  if (!res.ok) throw new SandboxError(502, "could not read the evidence chain");
  return res.json();
}
