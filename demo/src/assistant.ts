// The dashboard's assistant: a chat that knows Moat and the caller's own
// workspace, answered by Claude and streamed back a few words at a time.
//
// It sits here, in the website's server, for two reasons. The Anthropic key
// is a server secret, so the browser cannot call the model itself. And the
// context the assistant speaks from is the caller's workspace as the gateway
// sees it, which this server fetches with the caller's own bearer token,
// forwarded and never stored: an assistant that cannot be made to describe
// somebody else's workspace, because it only ever sees what the token opens.
//
// What it will not do: hold or echo a key, invent a number the gateway did
// not report, or talk about anything but Moat. Those are instructions to the
// model and also the shape of what it is given.

import type { IncomingMessage, ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";

const GATEWAY = process.env["MOAT_GATEWAY_URL"] ?? "http://127.0.0.1:7081";
const MODEL = "claude-sonnet-5-5";
const SUPPORT = "support@moatgateway.dpdns.org";

/** Messages per hour per caller. A conversation, not a crawler. */
const LIMIT = 40;
const HOUR = 60 * 60 * 1000;
const asked = new Map<string, number[]>();

function allowed(who: string): boolean {
  const now = Date.now();
  const recent = (asked.get(who) ?? []).filter((at) => now - at < HOUR);
  if (recent.length >= LIMIT) {
    asked.set(who, recent);
    return false;
  }
  recent.push(now);
  asked.set(who, recent);
  if (asked.size > 5000) {
    for (const [key, times] of asked) if (!times.some((at) => now - at < HOUR)) asked.delete(key);
  }
  return true;
}

export function isAssistantPath(path: string): boolean {
  return path === "/v1/assistant";
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantRequest {
  messages: Turn[];
  pane: string;
  lang: "en" | "ar";
}

/** The request as the dashboard sends it, or why it is refused. At most the
 *  last twelve turns and four thousand characters each: enough for a
 *  conversation, too little to be a channel for anything else. */
export function parseRequest(raw: unknown): AssistantRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be an object" };
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r["messages"]) ? r["messages"] : null;
  if (!list || list.length === 0) return { error: "messages must be a non-empty array" };
  const messages: Turn[] = [];
  for (const item of list.slice(-12)) {
    const m = item as Record<string, unknown>;
    const role = m["role"];
    const content = m["content"];
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      return { error: "each message is {role: user|assistant, content: string}" };
    }
    const text = content.trim().slice(0, 4000);
    if (text) messages.push({ role, content: text });
  }
  if (!messages.length || messages[messages.length - 1]!.role !== "user") {
    return { error: "the last message must be the user's" };
  }
  const pane = typeof r["pane"] === "string" ? r["pane"].slice(0, 40) : "";
  const lang = r["lang"] === "ar" ? "ar" : "en";
  return { messages, pane, lang };
}

/** What the gateway says about the caller's workspace. */
export interface WorkspaceContext {
  keys: { role: string; active: number; total: number }[];
  usage?: { total: number; week: number; allow: number; step_up: number; deny: number };
  recent: { at: string; verdict: string; payee: string; amount: string; currency: string; reasons: string }[];
}

/** What every answer stands on. Stable across calls, so it is cached. */
export const KNOWLEDGE = `You are the assistant inside the Moat dashboard. Moat is a payment authorization gateway for AI agents: it sits between an agent and the money (Stripe, bank transfers, EVM and Solana chains) and checks every payment the agent attempts against what the user asked for and what a person approved, before it can reach the payment provider.

How Moat decides. Before the agent runs, the user's request is registered in plain words on a trusted channel the agent cannot write to; a person may also approve a specific payment (payee, amount, currency, a tolerance, an expiry). Each attempted payment gets one of four verdicts: allow (payee, amount and currency match what was asked and approved; forwarded to the provider), deny (the money would go somewhere else, or for a different amount or currency; the provider is never called), step up (more than approved: held until a person approves or refuses it), hold (the provider accepted but the outcome could not be confirmed: quarantined, never retried blind). Moat tracks where every value came from: a payee that only appears in a page, invoice or email the agent read is never trusted, however convincing. Every decision is written to a signed, hash-chained evidence log.

THIS DASHBOARD IS A TEST ENVIRONMENT. No real money moves anywhere: card payments go to Stripe in test mode and chain payments to public testnets (Base Sepolia, Solana devnet). Say this plainly whenever someone asks about money, risk, or "is this real".

The dashboard's panes:
- Playground: try an attack or a legitimate payment against the live gateway in seconds. Off chain is a card payment through Moat; On chain is a simulated co-signer decision for EVM and Solana. The off-chain scenario has one source of truth, chosen with the Fields / Free text switch. In Fields, you set what was approved (payee, amount, currency) and what the agent tries, and the two texts (what the user said, the invoice the agent read) are written from them, read-only. In Free text, you write the user's words and the invoice yourself in any language; the approval is the user's words, which Moat's reader parses, and the agent does what the invoice says: the party it is told to remit to and the last sum named. The "Choose a scenario" menu fills the attempt relative to the current approval: do what the invoice says (the attacker's name), exactly what was approved, one character off, a higher price, over the spending cap, another currency. Press Attempt payment and the verdict appears in the Verdict column with the reason and an evidence id. The spending cap is 500 US dollars valued across currencies, so 1,900 SAR is over the cap and 960 SAR only over a 480 SAR approval.
- Usage: counts of verdicts over time, and the ones held for a person.
- API keys: three roles. agent keys are what an AI agent presents to pay (scopes rail:card, rail:bank, rail:crypto); approver keys register the user's words and approvals and release holds (scopes intent:write, authorizations:write, holds:release, evidence:read); admin keys manage keys and read usage and verdicts. A key is shown once; it can be downloaded as a JSON file and the sign-in form reads that file back. Keys can expire and be revoked; an admin key cannot revoke itself.
- Connect: how to point an AI client (Claude, OpenAI, Cursor, any MCP client) at Moat. The MCP endpoint is https://api.moatgateway.dpdns.org/mcp with an agent key as the bearer token; the agent then talks to the payment tools through Moat and never holds the provider's keys.
- Verdicts: every decision with its reason; open one for the evidence.

Recovery: a workspace may carry an owner email, given at signup. "Lost your admin key?" on the sign-in page mails a single-use recovery key, good for 30 minutes; redeeming it issues a new admin key and withdraws the previous admin keys.

How to guide a new tester, briefly: 1) open Playground, press Attempt payment with the default scenario and watch the deny (the invoice told the agent to pay Nova Studio, the user asked for Al Noor Supplies); 2) choose "Exactly what was approved" and watch the allow; 3) try "A higher price" for a step up; 4) switch to Free text and write the request in their own language; 5) look at Verdicts for the evidence; 6) mint an agent key and connect a real client from Connect.

Rules. Answer in the language the user writes in (Arabic or English; the dashboard tells you which it is set to). Be concise: a few sentences, or a short list when steps are asked for. Use only the workspace numbers you are given; never invent counts, verdicts or names. Never ask for, repeat, or guess any key or secret; if the user pastes one, tell them not to share keys and to rotate it from API keys. If the user is stuck or asks for a human, give them ${SUPPORT}. Stay on Moat: for unrelated requests, say what you are for and offer to help with the dashboard.`;

/** The part of the prompt that changes per call: the caller's workspace. */
export function contextPrompt(ctx: WorkspaceContext, pane: string, lang: "en" | "ar"): string {
  const keys = ctx.keys.length
    ? ctx.keys.map((k) => `${k.role}: ${k.active} active of ${k.total}`).join("; ")
    : "no keys listed";
  const usage = ctx.usage
    ? `${ctx.usage.total} verdicts all time (${ctx.usage.week} in the last 7 days): ${ctx.usage.allow} allowed, ${ctx.usage.step_up} held for a person, ${ctx.usage.deny} refused`
    : "no usage reported";
  const recent = ctx.recent.length
    ? ctx.recent.map((v) => `${v.at} ${v.verdict} ${v.payee} ${v.amount} ${v.currency}${v.reasons ? ` (${v.reasons})` : ""}`).join("\n")
    : "none yet";
  return `Workspace context, from the gateway, for this caller only:
Keys: ${keys}
Usage: ${usage}
Most recent verdicts:
${recent}
The user is looking at the pane "${pane || "unknown"}" and the dashboard language is ${lang === "ar" ? "Arabic" : "English"}.`;
}

/** Fetch the caller's workspace with their own token. The token is the
 *  authorization: a wrong or missing one is a 401 from the gateway, which
 *  becomes a 401 here, and nothing about any workspace is said. */
async function workspaceContext(bearer: string | undefined): Promise<WorkspaceContext | "unauthorized" | "unavailable"> {
  if (!bearer) return "unauthorized";
  const get = async (path: string): Promise<unknown | "unauthorized" | "unavailable"> => {
    try {
      const r = await fetch(`${GATEWAY}${path}`, {
        headers: { authorization: bearer },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 401 || r.status === 403) return "unauthorized";
      if (!r.ok) return "unavailable";
      return (await r.json()) as unknown;
    } catch {
      return "unavailable";
    }
  };
  const keys = await get("/v1/keys");
  if (keys === "unauthorized" || keys === "unavailable") return keys;
  const [usage, verdicts] = await Promise.all([get("/v1/usage"), get("/v1/verdicts")]);

  const byRole = new Map<string, { active: number; total: number }>();
  for (const k of Array.isArray(keys) ? (keys as Record<string, unknown>[]) : []) {
    const role = String(k["access_role"] ?? "unknown");
    const live = Boolean(k["active"]) && !k["expired"];
    const row = byRole.get(role) ?? { active: 0, total: 0 };
    row.total += 1;
    if (live) row.active += 1;
    byRole.set(role, row);
  }
  const u = usage && typeof usage === "object" ? (usage as Record<string, number>) : undefined;
  const recent = (Array.isArray(verdicts) ? (verdicts as Record<string, unknown>[]) : []).slice(0, 5).map((v) => ({
    at: String(v["at"] ?? ""),
    verdict: String(v["verdict"] ?? ""),
    payee: String(v["payee"] ?? v["tool"] ?? ""),
    amount: String(v["amount"] ?? ""),
    currency: String(v["currency"] ?? ""),
    reasons: String(v["failed_rules"] ?? ""),
  }));
  return {
    keys: [...byRole.entries()].map(([role, n]) => ({ role, ...n })),
    ...(u ? { usage: { total: u["total"] ?? 0, week: u["week"] ?? 0, allow: u["allow"] ?? 0, step_up: u["step_up"] ?? 0, deny: u["deny"] ?? 0 } } : {}),
    recent,
  };
}

function event(res: ServerResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Answer one turn of the conversation as a stream of server-sent events:
 *  `thinking` when the model starts to think, `text` for each piece of the
 *  answer as it is written, `done` at the end, `error` with a sentence
 *  otherwise. */
export async function handleAssistant(
  req: IncomingMessage,
  res: ServerResponse,
  raw: string,
  who: string,
): Promise<void> {
  const refuse = (status: number, error: string) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error }));
  };
  const apiKey = process.env["MOAT_ASSISTANT_API_KEY"];
  if (!apiKey) return refuse(503, `the assistant is not configured on this server; write to ${SUPPORT}`);
  if (!allowed(who)) return refuse(429, `that is a lot of questions for one hour; write to ${SUPPORT} if something is wrong`);

  let parsedBody: unknown;
  try {
    parsedBody = raw ? JSON.parse(raw) : {};
  } catch {
    return refuse(400, "body must be JSON");
  }
  const request = parseRequest(parsedBody);
  if ("error" in request) return refuse(400, request.error);

  const auth = req.headers["authorization"];
  const ctx = await workspaceContext(typeof auth === "string" ? auth : undefined);
  if (ctx === "unauthorized") return refuse(401, "sign in to the workspace to use the assistant");
  if (ctx === "unavailable") return refuse(503, "the gateway is not answering; try again in a moment");

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1200,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: [
      { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
      { type: "text", text: contextPrompt(ctx, request.pane, request.lang) },
    ],
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  req.on("close", () => stream.abort());

  try {
    let thinkingSaid = false;
    for await (const ev of stream) {
      if (ev.type === "content_block_start" && ev.content_block.type === "thinking" && !thinkingSaid) {
        thinkingSaid = true;
        event(res, "thinking", {});
      } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        event(res, "text", { t: ev.delta.text });
      }
    }
    const final = await stream.finalMessage();
    event(res, "done", { stop: final.stop_reason });
  } catch (error) {
    if (!res.writableEnded) {
      event(res, "error", { message: `the assistant could not answer; try again, or write to ${SUPPORT}` });
    }
    console.error("assistant:", error instanceof Error ? error.message : String(error));
  } finally {
    res.end();
  }
}
