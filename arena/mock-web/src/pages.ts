import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { renderForRail, splitRailPath, type Rail } from "@moat/arena-rails";

/** The host every arena URL uses. Anything else is "off the internet". */
export const ARENA_HOST = "arena.local";

export interface Page {
  status: number;
  contentType: string;
  body: string;
  /** Which rail the page was rendered for. */
  rail: Rail;
}

/**
 * Maps `https://arena.local/<rail>/<path>` onto files under `root`. The path
 * is confined to `root`; anything that escapes it, or any other host, is a
 * 404.
 *
 * One file serves every rail. An invoice carries `{{rail.*}}` placeholders
 * wherever the value is a property of how the money moves rather than of
 * the invoice, and the rail in the URL decides which values go in. That is
 * what lets the same attack be measured on a card and on a bank transfer
 * without two copies of the page drifting apart.
 */
export class PageStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The file a URL names, and the rail it should be rendered for. */
  resolveRequest(url: string): { path: string; rail: Rail } | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.hostname !== ARENA_HOST) return undefined;
    const decoded = decodeURIComponent(parsed.pathname);
    if (decoded.includes("\0")) return undefined;
    const { rail, rest } = splitRailPath(decoded);
    if (rest === "") return undefined;
    const full = resolve(this.root, rest);
    if (full !== this.root && !full.startsWith(this.root + sep)) return undefined;
    return { path: full, rail };
  }

  /** Kept for callers that only want the file. */
  resolvePath(url: string): string | undefined {
    return this.resolveRequest(url)?.path;
  }

  fetch(url: string): Page {
    const request = this.resolveRequest(url);
    if (request === undefined) {
      return { status: 404, contentType: "text/plain", body: `Not found: ${url}`, rail: "card" };
    }
    try {
      if (!statSync(request.path).isFile()) throw new Error("not a file");
      const raw = readFileSync(request.path, "utf8");
      return {
        status: 200,
        contentType: contentTypeFor(request.path),
        body: renderForRail(raw, request.rail, request.path),
        rail: request.rail,
      };
    } catch (err) {
      // An unrendered placeholder is a mistake in the corpus, not a missing
      // page. Saying so is the difference between a one-line fix and an
      // afternoon wondering why an attack stopped working.
      if (err instanceof Error && err.message.includes("unknown placeholder")) {
        return {
          status: 500,
          contentType: "text/plain",
          body: err.message,
          rail: request.rail,
        };
      }
      return {
        status: 404,
        contentType: "text/plain",
        body: `Not found: ${url}`,
        rail: request.rail,
      };
    }
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  return "text/plain";
}
