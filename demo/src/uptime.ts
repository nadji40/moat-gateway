// Daily availability of the authenticated gateway, sampled from here.
//
// A status page that only says "up" because you are reading it says nothing:
// the interesting question is what happened while nobody was looking. So the
// demo process takes a sample a minute and keeps the tally per day.
//
// A day is 1440 minutes, and the denominator is always 1440 rather than the
// number of samples actually taken. That is deliberate: if this process is
// down it records nothing, and dividing by the samples it managed to take
// would score a dead service at 100%. Missing samples are downtime, which is
// the only honest reading.
//
// Today is therefore always partial and is reported as such, so nobody reads
// a morning's 30% as an outage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Minutes in a day, and so the denominator for a complete one. */
const PER_DAY = 1440;
/** How long the strip is. */
const DAYS = 30;
const EVERY_MS = 60_000;

const FILE =
  process.env["MOAT_UPTIME_FILE"] ?? join(process.env["HOME"] ?? ".", ".moat-uptime.json");
const TARGET = (process.env["MOAT_GATEWAY_URL"] ?? "http://127.0.0.1:7081") + "/health/ready";

/**
 * Days the operator states the service was up, before this recorder existed.
 *
 * The service ran for weeks before anything sampled it, and a strip that
 * shows those days blank understates it as much as showing them red would
 * overstate it. So they can be declared. They are never called measured: the
 * API marks them `declared` and the page labels them, because the whole point
 * of the strip is that it is sampled, and a declaration that looked like a
 * sample would quietly spend that credibility.
 */
const DECLARED_FROM = process.env["MOAT_UPTIME_FROM"];

/** date (YYYY-MM-DD) -> samples that answered */
type Tally = Record<string, number>;

interface Store {
  /** The first day this recorder ran. Days before it were never measured. */
  since?: string;
  /** The exact minute it started, so its first day is not scored from midnight. */
  startedAt?: string;
  days: Tally;
}

let tally: Tally = {};
/** Undefined only between construction and the first load. */
let since: string | undefined;
let startedAt: string | undefined;
let timer: NodeJS.Timeout | undefined;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): void {
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, "utf8")) as Store | Tally;
      // The first version of this file was a bare tally with no start date.
      if (raw && typeof raw === "object" && "days" in raw) {
        tally = (raw as Store).days ?? {};
        since = (raw as Store).since;
        startedAt = (raw as Store).startedAt;
      } else {
        tally = raw as Tally;
        since = Object.keys(tally).sort()[0];
      }
    }
  } catch {
    // A corrupt file is not worth refusing to start over. Losing history is
    // better than a status page that cannot serve.
    tally = {};
  }
  // A recorder that started today has not been failing since last month, and
  // one that started this minute has not been failing since midnight.
  since ??= today();
  startedAt ??= new Date().toISOString();
}

function save(): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const store: Store = {
      days: tally,
      ...(since ? { since } : {}),
      ...(startedAt ? { startedAt } : {}),
    };
    writeFileSync(FILE, JSON.stringify(store), "utf8");
  } catch {
    /* a read-only disk should not take the process down */
  }
}

async function sample(): Promise<void> {
  let ok = false;
  try {
    const res = await fetch(TARGET, { signal: AbortSignal.timeout(5_000) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (!ok) return;
  const day = today();
  tally[day] = (tally[day] ?? 0) + 1;

  // Keep a little more than the strip shows, and no more.
  const keep = new Set(lastDays(DAYS + 5));
  for (const key of Object.keys(tally)) if (!keep.has(key)) delete tally[key];
  save();
}

function lastDays(n: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export function startUptime(): void {
  if (timer) return;
  load();
  void sample();
  timer = setInterval(() => void sample(), EVERY_MS);
  timer.unref?.();
}

export interface Day {
  date: string;
  /** Samples that answered. */
  ok: number;
  /** Samples expected by now: 1440 for a past day, fewer for today. */
  expected: number;
  /** `ok / expected`, or null for a day with no expectation yet. */
  ratio: number | null;
  /** Today is still accumulating, so its ratio is not comparable. */
  partial: boolean;
  /** Stated by the operator rather than sampled. Never presented as measured. */
  declared: boolean;
}

export function uptime(): { days: Day[]; window: number; note: string } {
  const now = new Date();
  const minutesToday = now.getUTCHours() * 60 + now.getUTCMinutes() + 1;
  const stamp = today();
  const began = startedAt ? new Date(startedAt) : null;
  const skipToday =
    began && began.toISOString().slice(0, 10) === stamp
      ? began.getUTCHours() * 60 + began.getUTCMinutes()
      : 0;

  const days = lastDays(DAYS).map((date) => {
    const partial = date === stamp;
    // A day before this recorder existed was never measured, and drawing it
    // as an outage would claim a month of downtime that never happened.
    if (since && date < since) {
      // Before the recorder, but inside the declared window.
      if (DECLARED_FROM && date >= DECLARED_FROM) {
        return { date, ok: PER_DAY, expected: PER_DAY, ratio: 1, partial: false, declared: true };
      }
      return { date, ok: 0, expected: 0, ratio: null, partial: false, declared: false };
    }
    // On the first day, only the minutes since the recorder started could
    // have been sampled. Scoring from midnight would mark the hours before it
    // existed as an outage.
    const expected = partial ? Math.max(1, minutesToday - skipToday) : PER_DAY;
    const ok = Math.min(tally[date] ?? 0, expected);
    return {
      date,
      ok,
      expected,
      ratio: expected ? ok / expected : null,
      partial,
      declared: false,
    };
  });

  return {
    days,
    window: DAYS,
    note:
      "One sample a minute against the gateway's readiness endpoint. A day is " +
      "scored out of 1440 whether or not this process was alive to take the " +
      "samples, so a gap counts against it.",
  };
}
