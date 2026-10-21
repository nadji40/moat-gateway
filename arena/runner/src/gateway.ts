// Locating the gateway binary and talking to its intent API.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function gatewayBinary(arenaRoot: string): string {
  const fromEnv = process.env["MOAT_GATEWAY_BIN"];
  if (fromEnv) return fromEnv;
  const names = process.platform === "win32" ? ["moat-gateway.exe", "moat-gateway"] : ["moat-gateway"];
  const candidates = ["release", "debug"].flatMap((profile) =>
    names.map((name) => resolve(arenaRoot, "..", "target", profile, name)),
  );
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `moat-gateway binary not found (looked in ${candidates.join(", ")}); ` +
        "run `cargo build -p moat-gateway` or set MOAT_GATEWAY_BIN",
    );
  }
  return found;
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
