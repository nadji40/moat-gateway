// Fake web MCP server over Streamable HTTP (stateless: no session ids).
// fetch(url) returns the raw file under MOCK_WEB_ROOT (default: the arena
// directory) for https://arena.local/... URLs. Listens on MOCK_WEB_PORT
// (default 7100) at /mcp, loopback only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { PageStore } from "./pages.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env["MOCK_WEB_ROOT"] ?? resolve(here, "..", "..");
const port = Number(process.env["MOCK_WEB_PORT"] ?? "7100");
const pages = new PageStore(root);

function buildServer(): McpServer {
  const server = new McpServer({ name: "mock-web", version: "0.1.0" });
  server.registerTool(
    "fetch",
    {
      description: "Fetch a web page and return its contents.",
      inputSchema: { url: z.string().url().describe("Absolute URL") },
    },
    async ({ url }) => {
      const page = pages.fetch(url);
      return {
        content: [{ type: "text", text: page.body }],
        structuredContent: { url, status: page.status, contentType: page.contentType },
        isError: page.status !== 200,
      };
    },
  );
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  // Stateless: a fresh server and transport per request, no session id.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    const body = await readJson(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    process.stderr.write(`mock-web: ${String(err)}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
}

const http = createServer((req, res) => {
  void handle(req, res);
});
http.listen(port, "127.0.0.1", () => {
  process.stderr.write(`mock-web: serving ${root} at http://127.0.0.1:${port}/mcp\n`);
});
