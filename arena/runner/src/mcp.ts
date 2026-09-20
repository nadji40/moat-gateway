// MCP client plumbing: connect to the servers either directly or through the
// gateway, and expose the two tools a backend needs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { PayCall } from "./attacks.js";
import type { PayOutcome, ToolDescriptor, Tools } from "./backends/types.js";

export const STEP_UP_CODE = -31050;
export const DENY_CODE = -31051;

/**
 * The `message` strings the gateway puts on those errors, from
 * `crates/moat-gateway/src/proxy.rs`.
 *
 * These matter because not every host surfaces `error.data`. The OpenAI
 * Agents SDK, for one, collapses an MCP tool error down to its message
 * before handing it to the model, so the code and the `data.moat` payload
 * are gone by the time anything downstream sees it. The message is then the
 * only thing left to recognise a verdict by.
 */
export const STEP_UP_MESSAGE = "Moat: payment needs human approval";
export const DENY_MESSAGE = "Moat: payment denied";

export interface Endpoints {
  /** Command for the stdio server to spawn (gateway or mock-stripe). */
  stdio: { command: string; args: string[]; env: Record<string, string>; cwd: string };
  /** HTTP MCP endpoint to connect to directly, if any (mock-web in direct mode). */
  http?: string;
  /**
   * Tool names as this mode exposes them. `approve` is present only on
   * rails that have a standing-allowance tool.
   */
  names: { fetch: string; pay: string; approve?: string };
}

export interface Connected {
  tools: Tools;
  close(): Promise<void>;
}

async function connectStdio(spec: Endpoints["stdio"]): Promise<Client> {
  const client = new Client({ name: "moat-arena-runner", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
    stderr: process.env["ARENA_VERBOSE"] ? "inherit" : "ignore",
  });
  await client.connect(transport);
  return client;
}

async function connectHttp(url: string): Promise<Client> {
  const client = new Client({ name: "moat-arena-runner", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/**
 * The receipt a provider printed in its text output.
 *
 * Every arena mock and adapter ends its confirmation with `Receipt <id>.`,
 * whatever the rail, because not every host passes `structuredContent`
 * through. The OpenAI Agents SDK hands the model the text and nothing else,
 * so the text is the only place a receipt is guaranteed to survive.
 */
export function receiptInText(text: string): string | undefined {
  return /\breceipt\s+([A-Za-z0-9_-]+)/i.exec(text)?.[1];
}

function textOf(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  return (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function outcomeFromError(err: unknown, ms: number): PayOutcome {
  if (err instanceof McpError) {
    const data = (err.data ?? {}) as { moat?: Record<string, unknown> };
    const moat = data.moat ?? {};
    if (err.code === STEP_UP_CODE) {
      return {
        kind: "step_up",
        evidenceId: String(moat["evidence_id"] ?? ""),
        prompt: String(moat["prompt"] ?? ""),
        ms,
      };
    }
    if (err.code === DENY_CODE) {
      const reasons = Array.isArray(moat["reasons"])
        ? (moat["reasons"] as { id?: string }[]).map((r) => String(r.id ?? "?"))
        : [];
      return { kind: "deny", evidenceId: String(moat["evidence_id"] ?? ""), reasons, ms };
    }
    return { kind: "error", message: `${err.code}: ${err.message}`, ms };
  }
  return { kind: "error", message: String(err), ms };
}

/** Connect per `endpoints` and return tools routed to the right client. */
export async function connect(endpoints: Endpoints): Promise<Connected> {
  const stdio = await connectStdio(endpoints.stdio);
  const http = endpoints.http ? await connectHttp(endpoints.http) : undefined;
  const fetchClient = http ?? stdio;

  const tools: Tools = {
    async fetch(url) {
      const t0 = performance.now();
      const result = await fetchClient.callTool({ name: endpoints.names.fetch, arguments: { url } });
      return { text: textOf(result), ms: performance.now() - t0 };
    },
    async pay(args: PayCall) {
      // A scripted call may name which of the rail's tools to make it
      // with. That is not an argument, so it is taken off here rather than
      // sent to a provider that has never heard of it.
      const { tool, ...arguments_ } = args as PayCall & { tool?: string };
      const name =
        tool === "approve" && endpoints.names.approve !== undefined
          ? endpoints.names.approve
          : endpoints.names.pay;
      const t0 = performance.now();
      try {
        const result = await stdio.callTool({ name, arguments: arguments_ });
        const ms = performance.now() - t0;
        const sc = (result as { structuredContent?: { receipt?: string } }).structuredContent;
        const receipt = sc?.receipt ?? receiptInText(textOf(result)) ?? "?";
        if ((result as { isError?: boolean }).isError) {
          return { kind: "error", message: textOf(result), ms };
        }
        return { kind: "paid", receipt, ms };
      } catch (err) {
        return outcomeFromError(err, performance.now() - t0);
      }
    },
    async descriptors(): Promise<ToolDescriptor[]> {
      const out: ToolDescriptor[] = [];
      for (const c of http ? [stdio, http] : [stdio]) {
        const list = await c.listTools();
        for (const t of list.tools) {
          out.push({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
      }
      return out;
    },
  };

  return {
    tools,
    async close() {
      await Promise.allSettled([stdio.close(), http?.close()]);
    },
  };
}
