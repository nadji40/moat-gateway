import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PageStore } from "../src/pages.js";

describe("PageStore", () => {
  const root = mkdtempSync(join(tmpdir(), "moat-pages-"));
  mkdirSync(join(root, "attacks", "x"), { recursive: true });
  writeFileSync(join(root, "attacks", "x", "page.html"), "<p>hi</p>");
  writeFileSync(join(tmpdir(), "moat-pages-outside.txt"), "secret");
  const store = new PageStore(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("serves files under the root by URL path", () => {
    const p = store.fetch("https://arena.local/attacks/x/page.html");
    expect(p.status).toBe(200);
    expect(p.contentType).toBe("text/html");
    expect(p.body).toBe("<p>hi</p>");
  });

  it("refuses other hosts, traversal, directories and missing files", () => {
    for (const url of [
      "https://example.com/attacks/x/page.html",
      "https://arena.local/../moat-pages-outside.txt",
      "https://arena.local/attacks/x/../../../moat-pages-outside.txt",
      "https://arena.local/attacks/x",
      "https://arena.local/nope.html",
      "not a url",
      "https://arena.local/",
    ]) {
      expect(store.fetch(url).status, url).toBe(404);
    }
  });
});
