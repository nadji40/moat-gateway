// The MCP TypeScript SDK's own StreamableHTTPClientTransport talking to
// moat-gateway over HTTP. This is the interop check for step 11: the client
// a real host ships with, unmodified, against the listen side we serve.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger } from "@moat/mock-ledger";
import { gatewayBinary } from "../src/gateway.js";
import { STEP_UP_CODE } from "../src/mcp.js";

const ARENA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_PORT = 7166;
const MCP_URL = "http://127.0.0.1:7071/mcp";
const INTENT = "http://127.0.0.1:7072";
const work = mkdtempSync(join(tmpdir(), "moat-http-listen-"));
const ledger = join(work, "ledger.json");
let mockWeb: ChildProcess;
let gateway: ChildProcess;

const hasGateway =
  ["moat-gateway", "moat-gateway.exe"].some((name) =>
    ["release", "debug"].some((profile) =>
      existsSync(resolve(ARENA_ROOT, "..", "target", profile, name)),
    ),
  ) || Boolean(process.env["MOAT_GATEWAY_BIN"]);

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${what} did not come up`);
}

beforeAll(async () => {
  if (!hasGateway) return;
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
    MOCK_STRIPE_LEDGER: ledger,
  };
  // The http config points the web upstream at 7100; run mock-web there.
  mockWeb = spawn(
    process.execPath,
    ["--import", "tsx", join(ARENA_ROOT, "mock-web", "src", "server.ts")],
    { cwd: join(ARENA_ROOT, "mock-web"), env: { ...env, MOCK_WEB_ROOT: ARENA_ROOT, MOCK_WEB_PORT: "7100" }, stdio: "ignore" },
  );
  await waitFor(async () => (await fetch("http://127.0.0.1:7100/mcp")).status === 405, "mock-web");
  gateway = spawn(
    gatewayBinary(ARENA_ROOT),
    ["--config", join(ARENA_ROOT, "moat.arena-http.yaml")],
    { cwd: ARENA_ROOT, env: { ...env, RUST_LOG: "moat_gateway=warn" }, stdio: "ignore" },
  );
  await waitFor(async () => (await fetch(MCP_URL, { method: "GET" })).status === 400, "gateway http listener");
}, 60_000);

afterAll(() => {
  gateway?.kill();
  mockWeb?.kill();
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!hasGateway || process.env["MOCK_WEB_PORT"] === String(WEB_PORT))(
  "MCP SDK StreamableHTTPClientTransport against moat-gateway",
  () => {
    it("initializes, lists namespaced tools, and Moat intercepts over HTTP", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
      const client = new Client({ name: "sdk-http-test", version: "0" });
      await client.connect(transport);

      const session = transport.sessionId;
      expect(session, "SDK captured Mcp-Session-Id").toMatch(/^s_/);

      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["stripe__list_payments", "stripe__pay", "web__fetch"]);

      // The SDK's session id is the Moat session id.
      const res = await fetch(`${INTENT}/v1/session/${session}/intent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Renew our monitoring tools with Monitoring Pro Inc, keep it under $500" }),
      });
      expect(res.status).toBe(200);

      // Read the injected page through the gateway's http upstream.
      const page = await client.callTool({
        name: "web__fetch",
        arguments: { url: "https://arena.local/card/attacks/inject-visible-text/renewal.html" },
      });
      expect(JSON.stringify(page)).toContain("ProMon Billing Ltd");

      // Injected payee -> the SDK throws the JSON-RPC error with code and data intact.
      let caught: unknown;
      try {
        await client.callTool({
          name: "stripe__pay",
          arguments: { payee: "ProMon Billing Ltd", amount: 480, currency: "USD" },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(McpError);
      const e = caught as McpError;
      expect(e.code).toBe(STEP_UP_CODE);
      const moat = (e.data as { moat?: Record<string, unknown> }).moat!;
      expect(moat["verdict"]).toBe("step_up");
      expect(String(moat["resume_token"])).toMatch(/^rt_/);
      expect(moat["session"]).toBe(session);
      expect(new Ledger(ledger).paidTo("ProMon Billing Ltd")).toHaveLength(0);

      // Legitimate payee with the page-sourced amount -> paid.
      const paid = await client.callTool({
        name: "stripe__pay",
        arguments: { payee: "Monitoring Pro Inc", amount: 480, currency: "USD" },
      });
      expect(JSON.stringify(paid)).toMatch(/fake_\d+/);
      expect(new Ledger(ledger).paidTo("Monitoring Pro Inc")).toHaveLength(1);

      await transport.terminateSession();
      await client.close();
    }, 60_000);
  },
);
