// Locating the gateway binary and talking to its intent API.
//
// The binary is the thing under test, so which one runs is part of the
// result. The runner used to take `target/release` before `target/debug`,
// and a release build left over from five weeks earlier outranked the
// debug build of the day: three attacks were "paid" through a gateway whose
// code was not in the tree. Now the newest build wins, a build older than
// the newest source change is refused, and the manifest records what ran.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The gateway binary a run used, and whether it is the code in the tree. */
export interface GatewayBuild {
  path: string;
  /** When the binary was built (its modification time), RFC 3339. */
  built_at: string;
  /** The newest change to a Rust source or Cargo file under `crates/`, RFC 3339. */
  source_changed_at: string;
  /** The binary predates a source change, so it is not the code in the tree. */
  stale: boolean;
  /** `env` when `MOAT_GATEWAY_BIN` named it; otherwise the newest build found. */
  chosen: "env" | "newest-build";
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The newest modification time among `.rs` and `Cargo.*` files under `dir`. */
function newestSourceMs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMs(path));
    } else if (entry.name.endsWith(".rs") || entry.name.startsWith("Cargo.")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/** Find the gateway binary and say how it relates to the sources. */
export function gatewayBuild(arenaRoot: string): GatewayBuild {
  const fromEnv = process.env["MOAT_GATEWAY_BIN"];
  let path: string;
  let chosen: GatewayBuild["chosen"];
  if (fromEnv) {
    path = fromEnv;
    chosen = "env";
  } else {
    const names =
      process.platform === "win32" ? ["moat-gateway.exe", "moat-gateway"] : ["moat-gateway"];
    const candidates = ["release", "debug"].flatMap((profile) =>
      names.map((name) => resolve(arenaRoot, "..", "target", profile, name)),
    );
    const found = candidates.filter((p) => existsSync(p));
    if (found.length === 0) {
      throw new Error(
        `moat-gateway binary not found (looked in ${candidates.join(", ")}); ` +
          "run `cargo build -p moat-gateway` or set MOAT_GATEWAY_BIN",
      );
    }
    // The newest build, whatever its profile.
    found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    path = found[0]!;
    chosen = "newest-build";
  }
  const builtMs = statSync(path).mtimeMs;
  const sourceMs = newestSourceMs(resolve(arenaRoot, "..", "crates"));
  return {
    path,
    built_at: iso(builtMs),
    source_changed_at: iso(sourceMs),
    stale: builtMs < sourceMs,
    chosen,
  };
}

/**
 * Refuse a build that is not the code in the tree, unless somebody chose it:
 * a binary named by `MOAT_GATEWAY_BIN` is a decision, and the manifest still
 * says it is stale. `MOAT_ALLOW_STALE_GATEWAY=1` runs the found one anyway.
 */
export function assertCurrent(build: GatewayBuild): GatewayBuild {
  if (build.stale && build.chosen !== "env" && !process.env["MOAT_ALLOW_STALE_GATEWAY"]) {
    throw new Error(
      `moat-gateway at ${build.path} was built ${build.built_at}, before the newest ` +
        `source change at ${build.source_changed_at}: a run of it would measure code that ` +
        "is not in the tree. Run `cargo build -p moat-gateway`, or set MOAT_GATEWAY_BIN " +
        "to choose a binary on purpose, or MOAT_ALLOW_STALE_GATEWAY=1 to run it anyway.",
    );
  }
  return build;
}

export function gatewayBinary(arenaRoot: string): string {
  return assertCurrent(gatewayBuild(arenaRoot)).path;
}

export class IntentApi {
  constructor(private readonly base: string) {}

  async waitUntilUp(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(`${this.base}/v1/session/probe/evidence`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error(`intent API at ${this.base} did not come up`);
  }

  async intent(session: string, text: string): Promise<number> {
    const res = await fetch(`${this.base}/v1/session/${encodeURIComponent(session)}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`intent: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { turn: number };
    return body.turn;
  }

  /** Payments Moat is still waiting on, newest state first. */
  async openOutcomes(session: string): Promise<{ evidence_id: string; status_kind: string }[]> {
    const res = await fetch(
      `${this.base}/v1/session/${encodeURIComponent(session)}/outcomes`,
      { method: "GET" },
    );
    if (!res.ok) throw new Error(`open outcomes failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      open?: { evidence_id: string; status_kind: string }[];
    };
    return body.open ?? [];
  }

  /**
   * Tell Moat what the provider actually did, the way an operator would
   * after checking. The outcome is addressed by the evidence id of the
   * verdict that allowed it.
   */
  async reconcile(session: string, evidenceId: string, status: string): Promise<void> {
    const res = await fetch(
      `${this.base}/v1/session/${encodeURIComponent(session)}/outcomes/${encodeURIComponent(
        evidenceId,
      )}/reconcile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      },
    );
    if (!res.ok) throw new Error(`reconcile failed: ${res.status} ${await res.text()}`);
  }

  async authorization(
    session: string,
    body: {
      authorization_id: string;
      invoice_id?: string;
      payee: string;
      // Decimal strings as well as JSON numbers: a rail with more than two
      // decimal places cannot round-trip through a double.
      amount: string | number;
      tolerance: string | number;
      currency: string;
      expires_at: string;
      repeat_payments: boolean;
      max_payments: number;
      recipient_account_id?: string;
      /** The chain the payment must move on, on rails that have more than one. */
      network?: string;
      invoice_fingerprint?: string;
      require_invoice_fingerprint: boolean;
      aggregate_limit?: string | number;
    },
  ): Promise<void> {
    const res = await fetch(
      `${this.base}/v1/session/${encodeURIComponent(session)}/authorizations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`authorization: ${res.status} ${await res.text()}`);
  }

  async evidence(session: string): Promise<unknown[]> {
    const res = await fetch(`${this.base}/v1/session/${encodeURIComponent(session)}/evidence`);
    if (!res.ok) throw new Error(`evidence: ${res.status}`);
    return (await res.json()) as unknown[];
  }
}
