import assert from "node:assert/strict";
import { test } from "node:test";
import { contextPrompt, KNOWLEDGE, parseRequest } from "./assistant.js";

test("a request is the last twelve turns, ending with the user, trimmed to size", () => {
  const long = "x".repeat(5000);
  const turns = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` }));
  const parsed = parseRequest({ messages: [...turns, { role: "user", content: long }], pane: "pane-playground", lang: "ar" });
  assert.ok(!("error" in parsed));
  assert.equal(parsed.messages.length, 12);
  assert.equal(parsed.messages[parsed.messages.length - 1]!.content.length, 4000);
  assert.equal(parsed.lang, "ar");
  assert.equal(parsed.pane, "pane-playground");
});

test("a request that does not end with the user, or is not a list, is refused", () => {
  assert.ok("error" in parseRequest({ messages: [{ role: "assistant", content: "hi" }] }));
  assert.ok("error" in parseRequest({ messages: "hi" }));
  assert.ok("error" in parseRequest(null));
  assert.ok("error" in parseRequest({ messages: [{ role: "user", content: 42 }] }));
});

test("the knowledge says it is a test environment and gives the support address", () => {
  assert.match(KNOWLEDGE, /TEST ENVIRONMENT/);
  assert.match(KNOWLEDGE, /No real money moves/);
  assert.match(KNOWLEDGE, /support@moatgateway\.dpdns\.org/);
  assert.match(KNOWLEDGE, /Never ask for, repeat, or guess any key/);
});

test("the context carries the workspace's own numbers and nothing invented", () => {
  const text = contextPrompt(
    {
      keys: [{ role: "admin", active: 1, total: 1 }, { role: "agent", active: 2, total: 3 }],
      usage: { total: 12, week: 4, allow: 7, step_up: 2, deny: 3 },
      recent: [{ at: "2026-10-30T12:00:00Z", verdict: "deny", payee: "Nova Studio", amount: "480", currency: "SAR", reasons: "authorization-payee" }],
    },
    "pane-usage",
    "en",
  );
  assert.match(text, /admin: 1 active of 1; agent: 2 active of 3/);
  assert.match(text, /12 verdicts all time \(4 in the last 7 days\): 7 allowed, 2 held for a person, 3 refused/);
  assert.match(text, /deny Nova Studio 480 SAR \(authorization-payee\)/);
  assert.match(text, /pane "pane-usage"/);
  assert.match(contextPrompt({ keys: [], recent: [] }, "", "ar"), /no keys listed[\s\S]*no usage reported[\s\S]*none yet[\s\S]*Arabic/);
});
