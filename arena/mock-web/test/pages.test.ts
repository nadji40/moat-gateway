import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PageStore } from "../src/pages.js";

describe("PageStore", () => {
  const root = mkdtempSync(join(tmpdir(), "moat-pages-"));
  mkdirSync(join(root, "attacks", "x"), { recursive: true });
  writeFileSync(join(root, "attacks", "x", "page.html"), "<p>hi</p>");
  writeFileSync(
    join(root, "attacks", "x", "invoice.html"),
    "<p>Pay {{rail.symbol}}480 to {{rail.attacker.destination_display}}</p>",
  );
  writeFileSync(join(root, "attacks", "x", "broken.html"), "<p>{{rail.nonsense}}</p>");
  writeFileSync(join(tmpdir(), "moat-pages-outside.txt"), "secret");
  const store = new PageStore(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("serves files under the root by URL path", () => {
    const p = store.fetch("https://arena.local/attacks/x/page.html");
    expect(p.status).toBe(200);
    expect(p.contentType).toBe("text/html");
    expect(p.body).toBe("<p>hi</p>");
  });

  // One file, two rails. The agent that reads the bank version has to see
  // the account it is about to be talked into paying, or the attack is not
  // the attack.
  it("renders the same page differently for each rail", () => {
    const card = store.fetch("https://arena.local/card/attacks/x/invoice.html");
    expect(card.rail).toBe("card");
    expect(card.body).toBe("<p>Pay $480 to acct_attacker_999</p>");

    const bank = store.fetch("https://arena.local/bank/attacks/x/invoice.html");
    expect(bank.rail).toBe("bank");
    expect(bank.body).toBe("<p>Pay €480 to DE08 1259 2310 4695 4052 20</p>");
  });

  it("treats a path with no rail prefix as the card rail", () => {
    const p = store.fetch("https://arena.local/attacks/x/invoice.html");
    expect(p.rail).toBe("card");
    expect(p.body).toContain("acct_attacker_999");
  });

  // A page served with a placeholder still in it would make an attack look
  // like it ran when nothing was substituted, so it fails loudly instead.
  it("fails loudly on a placeholder nobody defined", () => {
    const p = store.fetch("https://arena.local/bank/attacks/x/broken.html");
    expect(p.status).toBe(500);
    expect(p.body).toContain("unknown placeholder {{rail.nonsense}}");
  });

  it("refuses other hosts, traversal, directories and missing files", () => {
    for (const url of [
      "https://example.com/attacks/x/page.html",
      "https://arena.local/../moat-pages-outside.txt",
      "https://arena.local/attacks/x/../../../moat-pages-outside.txt",
      "https://arena.local/attacks/x",
      "https://arena.local/nope.html",
      "https://arena.local/bank/nope.html",
      "not a url",
      "https://arena.local/",
      "https://arena.local/bank/",
    ]) {
      expect(store.fetch(url).status, url).toBe(404);
    }
  });
});
