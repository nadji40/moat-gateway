// The tally must survive a restart: the process that samples is the process
// that deploys restart, and a strip that forgets a month at each deploy says
// nothing. Each test loads the module afresh, as a new process would, with
// the file pointed at its own temporary directory.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

type Uptime = typeof import("./uptime.js");

let n = 0;
/** A fresh copy of the module, as a restarted process would get. */
async function fresh(): Promise<Uptime> {
  return (await import(`${pathToFileURL(join(import.meta.dirname, "uptime.ts")).href}?run=${++n}`)) as Uptime;
}

function dayAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moat-uptime-"));
  process.env["MOAT_UPTIME_FILE"] = join(dir, "uptime.json");
  delete process.env["MOAT_UPTIME_FROM"];
  // Nothing listens here, so every sample the recorder takes on its own fails.
  process.env["MOAT_GATEWAY_URL"] = "http://127.0.0.1:9";
});
afterEach(() => {
  delete process.env["MOAT_UPTIME_FILE"];
});

test("a tally written by one process is read back by the next", async () => {
  // The previous process: started three days ago, counted two samples yesterday.
  writeFileSync(
    process.env["MOAT_UPTIME_FILE"]!,
    JSON.stringify({
      days: { [dayAgo(1)]: 2 },
      since: dayAgo(3),
      startedAt: `${dayAgo(3)}T00:00:00.000Z`,
    }),
  );

  const next = await fresh();
  next.startUptime();
  const yesterday = next.uptime().days.find((d) => d.date === dayAgo(1));
  assert.deepEqual(yesterday, {
    date: dayAgo(1),
    ok: 2,
    expected: 1440,
    ratio: 2 / 1440,
    partial: false,
    declared: false,
  });
});

test("a sample is written down at once, and the start date is kept", async () => {
  writeFileSync(
    process.env["MOAT_UPTIME_FILE"]!,
    JSON.stringify({ days: {}, since: dayAgo(3), startedAt: `${dayAgo(3)}T00:00:00.000Z` }),
  );
  const mod = await fresh();
  mod.startUptime();
  mod.recordSample(dayAgo(1));
  mod.recordSample(dayAgo(1));

  const stored = JSON.parse(readFileSync(mod.uptimeFile(), "utf8")) as {
    days: Record<string, number>;
    since: string;
  };
  assert.equal(stored.days[dayAgo(1)], 2);
  assert.equal(stored.since, dayAgo(3), "a restart must not move the start date forward");
});

test("a tally that cannot be saved says so once, and does not stop the service", async () => {
  // A path under a regular file cannot be created, as under a read-only home.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "");
  process.env["MOAT_UPTIME_FILE"] = join(blocker, "uptime.json");

  const mod = await fresh();
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    said.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    mod.recordSample(dayAgo(1));
    mod.recordSample(dayAgo(1));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(said.length, 1);
  assert.match(said[0]!, /cannot save the tally to .*uptime\.json/);
  assert.match(said[0]!, /MOAT_UPTIME_FILE/);
  assert.equal(mod.uptime().days.find((d) => d.date === dayAgo(1))?.ok, 2, "the tally still counts in memory");
});
