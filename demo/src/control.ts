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
//   * forward any path it was not told about by name. `/mcp` is on the same
//     listener and must not become reachable from a browser through here,
//     and neither must the intent API, which is a separate port precisely so
//     that it is not public.
//   * invent, cache or inspect a bearer token. The header is copied across
//     untouched; this process never learns a key and never stores one.
//
// It rate-limits signup only. Key calls already need an admin bearer, so the
// gateway decides those; signup is the one that writes for a stranger.

import type { IncomingMessage, ServerResponse } from "node:http";

/** Where the authenticated gateway listens. Loopback in every deployment. */
const GATEWAY = process.env["MOAT_GATEWAY_URL"] ?? "http://127.0.0.1:7081";

/** Exactly the paths the dashboard needs. Anything else is a 404. */
function target(path: string, method: string): string | undefined {
  if (path === "/v1/signup" && method === "POST") return path;
  if (path === "/v1/keys" && (method === "GET" || method === "POST")) return path;
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
  return path === "/v1/signup" || path === "/v1/keys" || path.startsWith("/v1/keys/");
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
