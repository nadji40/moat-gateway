// A narrow pass-through to the authenticated gateway's control plane.
//
// The sandbox and the gateway are two different things on one origin. The
// sandbox is ephemeral and needs no credential; the gateway keeps tenants and
// keys in PostgreSQL and requires one. The dashboard has to reach the second
// from a page served by the first, so this forwards three paths and refuses
// everything else.
//
// What it will not do:
//
//   * forward any path it was not told about by name. The intent API is
//     forwarded, but only its per-session and per-tenant paths, and only to
//     an `approver` key: its health and cosigner endpoints stay where they
//     are, and an agent key presented there is refused by the gateway.
//   * invent, cache or inspect a bearer token. The header is copied across
//     untouched; this process never learns a key and never stores one.
//
// It rate-limits signup only. Key calls already need an admin bearer, so the
// gateway decides those; signup is the one that writes for a stranger.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Where the authenticated gateway listens. Loopback in every deployment. */
const GATEWAY = process.env["MOAT_GATEWAY_URL"] ?? "http://127.0.0.1:7081";
/** Where its intent API listens: a separate port, and now a separate key. */
const INTENT = process.env["MOAT_INTENT_URL"] ?? "http://127.0.0.1:7082";

/** Exactly the paths the dashboard needs. Anything else is a 404. */
function target(path: string, method: string): string | undefined {
  if (path === "/v1/signup" && method === "POST") return path;
  if (path === "/v1/keys" && (method === "GET" || method === "POST")) return path;
  if ((path === "/v1/usage" || path === "/v1/verdicts") && method === "GET") return path;
  if (/^\/v1\/keys\/[A-Za-z0-9_-]{1,64}$/.test(path) && method === "DELETE") return path;
  return undefined;
}

/** Signups per hour per caller. Generous for a person, useless for a script. */
const SIGNUP_LIMIT = 3;
const HOUR = 60 * 60 * 1000;
const signups = new Map<string, number[]>();

function signupAllowed(who: string): boolean {
  const now = Date.now();
  const recent = (signups.get(who) ?? []).filter((at) => now - at < HOUR);
  if (recent.length >= SIGNUP_LIMIT) {
    signups.set(who, recent);
    return false;
  }
  recent.push(now);
  signups.set(who, recent);
  // The map would otherwise grow for the life of the process.
  if (signups.size > 5000) {
    for (const [key, times] of signups) {
      if (!times.some((at) => now - at < HOUR)) signups.delete(key);
    }
  }
  return true;
}

export function isControlPath(path: string): boolean {
  return (
    path === "/v1/signup" ||
    path === "/v1/keys" ||
    path === "/v1/usage" ||
    path === "/v1/verdicts" ||
    path.startsWith("/v1/keys/")
  );
}

/**
 * Forward one control-plane call. Returns false when the path is not one of
 * the three, so the caller can fall through to its own 404 rather than this
 * module deciding what an unknown `/v1/` path means.
 */
export async function proxyControl(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: string,
  who: string,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const forward = target(path, method);
  if (!forward) return false;

  if (forward === "/v1/signup" && !signupAllowed(who)) {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `at most ${SIGNUP_LIMIT} workspaces an hour` }));
    return true;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = req.headers["authorization"];
  if (typeof auth === "string") headers["authorization"] = auth;

  try {
    // `exactOptionalPropertyTypes` will not take `body: undefined`, and a
    // GET carrying a body is a protocol error anyway, so the key is absent
    // rather than present-and-empty.
    const sends = method !== "GET" && method !== "DELETE";
    const upstream = await fetch(`${GATEWAY}${forward}`, {
      method,
      headers,
      ...(sends ? { body } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(text);
  } catch {
    // The gateway being down is not the caller's fault and not their problem
    // to debug, so it gets the same answer either way.
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the control plane is unavailable" }));
  }
  return true;
}


/* ---- the MCP endpoint ---------------------------------------------------
   An agent key exists to be used against /mcp and nothing else. While this
   proxy refused to forward it, a tenant could issue one from the dashboard
   and then have nowhere on the internet to present it: the gateway binds
   127.0.0.1, so the only way to use a key was to run the gateway yourself.
   That made the page's offer untrue.

   Forwarded rather than reimplemented. Every check that matters already lives
   in the gateway -- the bearer is authenticated per request, the role must be
   `agent`, scopes are checked at the tool call, and the tenant bounds every
   read and write -- so this adds no decision of its own. It carries bytes and
   headers faithfully and gets out of the way.

   Two things it does not do:

     * It does not widen CORS. The OPTIONS handler still allows only
       content-type, so a browser page cannot send an authorization header
       here cross-origin. The gateway would refuse it anyway: its own origin
       check accepts loopback origins only, and Origin is forwarded so that
       check still runs. An MCP client is not a browser and sends no Origin.
     * It does not buffer. The streamable HTTP transport answers a POST with
       either JSON or an event stream, and a GET is a long-lived stream, so
       the body is piped. Reading it to a string the way the control paths do
       would hold every event until the stream closed, which for a GET is
       never. */

/** The path the gateway serves MCP on, here and there. */
const MCP_PATH = "/mcp";

/** Headers an MCP client needs carried to the gateway. */
const FORWARD = [
  "authorization",
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  // Forwarded so the gateway's own origin check still runs. It accepts
  // loopback only, which is the DNS-rebinding defence, and stripping it here
  // would silently disarm that.
  "origin",
] as const;

/** Headers the client needs carried back. The session id is how it resumes. */
const RETURN = ["content-type", "mcp-session-id", "cache-control"] as const;

/** A tool call can carry a page of text; a JSON-RPC frame is still not large. */
const MAX_BODY = 1024 * 1024;

export function isMcpPath(path: string): boolean {
  return path === MCP_PATH;
}

/** Whether an Origin names the host this very request was addressed to. */
function sameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    // Compared by host rather than by whole origin: the browser says https
    // and the proxy in front terminates it, so the schemes legitimately
    // differ and the port is already part of Host when it is not the default.
    return new URL(origin).host === host;
  } catch {
    // An Origin that is not a URL is not this one. "null" arrives from a
    // sandboxed frame, and that is exactly a caller to forward and refuse.
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Forward one MCP call, streaming the answer. */
export async function proxyMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  // POST carries a JSON-RPC frame, GET opens the stream, DELETE ends the
  // session. Nothing else is part of the transport.
  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET,POST,DELETE" });
    res.end(JSON.stringify({ error: "the MCP endpoint takes GET, POST or DELETE" }));
    return;
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARD) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  // The gateway's origin check trusts loopback origins and nothing else,
  // which is the DNS-rebinding defence: a page on some other site must not be
  // able to drive a gateway listening on 127.0.0.1. A page this server itself
  // served is not that page, and it is the only party in the chain that can
  // tell the difference -- the gateway sees every request arriving from
  // loopback and cannot know which host the browser asked for.
  //
  // So a same-origin Origin is dropped and every other one is forwarded to be
  // refused. Dropping it is not a hole: a genuinely cross-origin caller never
  // reaches here either way, because the preflight allows content-type alone
  // and an authorization header is not on that list.
  if (headers["origin"] && sameOrigin(headers["origin"], req.headers.host)) {
    delete headers["origin"];
  }

  let body: string | undefined;
  if (method === "POST") {
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "body too large" }));
      return;
    }
  }

  // A stream ends when the client goes away, not after a fixed time: a GET is
  // held open for as long as the agent wants it. Tying the upstream to this
  // connection is what stops an abandoned client leaving one behind.
  const stop = new AbortController();
  const abort = (): void => stop.abort();
  req.on("close", abort);

  try {
    const upstream = await fetch(`${GATEWAY}${MCP_PATH}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: stop.signal,
    });

    const out: Record<string, string> = {};
    for (const name of RETURN) {
      const value = upstream.headers.get(name);
      if (value) out[name] = value;
    }
    res.writeHead(upstream.status, out);

    if (!upstream.body) {
      res.end();
      return;
    }
    // pipeline rather than a write loop: it honours backpressure and tears
    // both ends down together when either fails.
    await pipeline(Readable.fromWeb(upstream.body as never), res);
  } catch (error) {
    // An abort is the client hanging up, which is not an error to report.
    if (stop.signal.aborted) {
      res.end();
      return;
    }
    if (!res.headersSent) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the gateway is unavailable" }));
    } else {
      // Mid-stream there is no status left to change, so the honest thing is
      // to close and let the client's transport notice.
      res.end();
    }
    void error;
  } finally {
    req.off("close", abort);
  }
}


/* ---- the intent API -----------------------------------------------------
   The trusted side. What the user said, what a person approved, and what
   came of it. It is on its own port and takes an `approver` key, and both of
   those are the design rather than an accident: an agent key cannot reach
   it, so an agent cannot register its own intent, so provenance means what
   it says.

   While this stayed loopback-only, a remote agent could be refused but never
   allowed. Every payment through the public /mcp resolved to Unknown because
   nothing on the internet could tell the session what the user had asked.
   Now the customer's own application -- the code that owns the chat box, not
   the agent -- registers the user's words here with an approver key the agent
   never sees, and a legitimate payment can pass.

   Plain request and reply, so it is read to a string like the control paths.
   Nothing here streams. */

/** The paths a customer's application needs, and only those. */
const INTENT_PATH = /^\/v1\/(session\/[A-Za-z0-9_-]{1,128}(\/[a-z/_-]{1,80})?|outcomes|authorizations\/[A-Za-z0-9_-]{1,128})$/;

export function isIntentPath(path: string): boolean {
  return INTENT_PATH.test(path);
}

/** Forward one intent API call. */
export async function proxyIntent(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: string,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = req.headers["authorization"];
  if (typeof auth === "string") headers["authorization"] = auth;
  try {
    const sends = method !== "GET" && method !== "DELETE";
    const upstream = await fetch(`${INTENT}${path}`, {
      method,
      headers,
      ...(sends ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(text);
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the intent API is unavailable" }));
  }
}
