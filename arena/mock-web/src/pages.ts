import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The host every arena URL uses. Anything else is "off the internet". */
export const ARENA_HOST = "arena.local";

export interface Page {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Maps `https://arena.local/<path>` onto files under `root`. The path is
 * confined to `root`; anything that escapes it, or any other host, is a 404.
 */
export class PageStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  resolvePath(url: string): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.hostname !== ARENA_HOST) return undefined;
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    if (rel === "" || rel.includes("\0")) return undefined;
    const full = resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + sep)) return undefined;
    return full;
  }

  fetch(url: string): Page {
    const path = this.resolvePath(url);
    if (path === undefined) {
      return { status: 404, contentType: "text/plain", body: `Not found: ${url}` };
    }
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
      return { status: 200, contentType: contentTypeFor(path), body: readFileSync(path, "utf8") };
    } catch {
      return { status: 404, contentType: "text/plain", body: `Not found: ${url}` };
    }
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  return "text/plain";
}
