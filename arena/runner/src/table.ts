import type { Rail } from "./rails.js";
import { ARMS, armForMode, percentile, type Arm, type ResultRow } from "./results.js";

export interface SummaryLine {
  attack: string;
  class: string;
  runs: number;
  paidDirect: number;
  paidGateway: number;
  verdicts: string;
}

export interface ControlSummaryLine {
  control: string;
  class: string;
  runs: number;
  completedDirect: number;
  completedGateway: number;
  verdicts: string;
}

export function summarize(rows: ResultRow[]): SummaryLine[] {
  const byAttack = new Map<string, ResultRow[]>();
  for (const r of rows) {
    if (r.scenario_kind === "control") continue;
    const list = byAttack.get(r.attack) ?? [];
    list.push(r);
    byAttack.set(r.attack, list);
  }
  const out: SummaryLine[] = [];
  for (const [attack, list] of [...byAttack.entries()].sort()) {
    const direct = list.filter((r) => r.mode === "direct");
    const gateway = list.filter((r) => r.mode === "gateway");
    const counts = new Map<string, number>();
    for (const r of gateway) for (const v of r.verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
    out.push({
      attack,
      class: list[0]?.class ?? "?",
      runs: Math.max(direct.length, gateway.length),
      paidDirect: direct.filter((r) => r.attacker_paid).length,
      paidGateway: gateway.filter((r) => r.attacker_paid).length,
      verdicts: [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(" ") || "-",
    });
  }
  return out;
}

export function summarizeControls(rows: ResultRow[]): ControlSummaryLine[] {
  const byControl = new Map<string, ResultRow[]>();
  for (const row of rows) {
    if (row.scenario_kind !== "control") continue;
    const list = byControl.get(row.attack) ?? [];
    list.push(row);
    byControl.set(row.attack, list);
  }
  const out: ControlSummaryLine[] = [];
  for (const [control, list] of [...byControl.entries()].sort()) {
    const direct = list.filter((row) => row.mode === "direct");
    const gateway = list.filter((row) => row.mode === "gateway");
    const counts = new Map<string, number>();
    for (const row of gateway) {
      for (const verdict of row.verdicts) {
        counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
      }
    }
    out.push({
      control,
      class: list[0]?.class ?? "?",
      runs: Math.max(direct.length, gateway.length),
      completedDirect: direct.filter((row) => row.legitimate_completed).length,
      completedGateway: gateway.filter((row) => row.legitimate_completed).length,
      verdicts: [...counts.entries()].map(([key, value]) => `${key}×${value}`).join(" ") || "-",
    });
  }
  return out;
}

function markdownTable(header: string[], body: string[][]): string[] {
  const widths = header.map((heading, index) =>
    Math.max(heading.length, ...body.map((row) => (row[index] ?? "").length)),
  );
  const format = (row: string[]): string =>
    "| " + row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join(" | ") + " |";
  const separator = "|" + widths.map((width) => "-".repeat(width + 2)).join("|") + "|";
  return [format(header), separator, ...body.map(format)];
}

function renderLegacyTable(rows: ResultRow[]): string {
  const lines = summarize(rows);
  const controls = summarizeControls(rows);
  const header = ["attack", "class", "runs", "paid (direct)", "paid (gateway)", "gateway verdicts"];
  const body = lines.map((l) => [
    l.attack,
    l.class,
    String(l.runs),
    `${l.paidDirect}/${l.runs}`,
    `${l.paidGateway}/${l.runs}`,
    l.verdicts,
  ]);
  const out: string[] = [];
  if (lines.length > 0) out.push(...markdownTable(header, body));

  const totalDirect = lines.reduce((a, l) => a + l.paidDirect, 0);
  const totalGateway = lines.reduce((a, l) => a + l.paidGateway, 0);
  const totalRuns = lines.reduce((a, l) => a + l.runs, 0);
  if (lines.length > 0) {
    out.push("", `attacker paid: direct ${totalDirect}/${totalRuns}, gateway ${totalGateway}/${totalRuns}`);
  }

  if (controls.length > 0) {
    const controlHeader = [
      "control",
      "class",
      "runs",
      "completed (direct)",
      "completed (gateway)",
      "gateway verdicts",
    ];
    const controlBody = controls.map((line) => [
      line.control,
      line.class,
      String(line.runs),
      `${line.completedDirect}/${line.runs}`,
      `${line.completedGateway}/${line.runs}`,
      line.verdicts,
    ]);
    if (out.length > 0) out.push("");
    out.push(...markdownTable(controlHeader, controlBody));
    const direct = controls.reduce((sum, line) => sum + line.completedDirect, 0);
    const gateway = controls.reduce((sum, line) => sum + line.completedGateway, 0);
    const total = controls.reduce((sum, line) => sum + line.runs, 0);
    out.push("", `legitimate completed: direct ${direct}/${total}, gateway ${gateway}/${total}`);
  }

  const fetchDirect = rows.filter((r) => r.mode === "direct").flatMap((r) => r.fetch_ms);
  const fetchGateway = rows.filter((r) => r.mode === "gateway").flatMap((r) => r.fetch_ms);
  const p = (v: number[], q: number): string => {
    const x = percentile(v, q);
    return x === undefined ? "n/a" : x.toFixed(1);
  };
  if (fetchDirect.length && fetchGateway.length) {
    const d50 = percentile(fetchDirect, 50) ?? 0;
    const g50 = percentile(fetchGateway, 50) ?? 0;
    const d95 = percentile(fetchDirect, 95) ?? 0;
    const g95 = percentile(fetchGateway, 95) ?? 0;
    out.push(
      `passthrough fetch latency (ms): direct p50 ${p(fetchDirect, 50)} p95 ${p(fetchDirect, 95)} | ` +
        `gateway p50 ${p(fetchGateway, 50)} p95 ${p(fetchGateway, 95)} | ` +
        `added p50 ${(g50 - d50).toFixed(1)} p95 ${(g95 - d95).toFixed(1)} (n=${fetchGateway.length})`,
    );
  }
  return out.join("\n");
}

function armOfRow(row: ResultRow): Arm {
  return row.arm ?? armForMode(row.mode);
}

/** Arms present in a set of rows, in canonical order. */
export function armsIn(rows: ResultRow[]): Arm[] {
  const present = new Set(rows.map(armOfRow));
  return ARMS.filter((arm) => present.has(arm));
}

export interface ArmCell {
  /** Attacker paid (attacks) or legitimate completed (controls). */
  hit: number;
  runs: number;
  verdicts: string;
}

export interface ArmSummaryLine {
  scenario: string;
  class: string;
  kind: "attack" | "control";
  byArm: Partial<Record<Arm, ArmCell>>;
}

export function summarizeByArm(rows: ResultRow[]): ArmSummaryLine[] {
  const byScenario = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = byScenario.get(row.attack) ?? [];
    list.push(row);
    byScenario.set(row.attack, list);
  }
  const out: ArmSummaryLine[] = [];
  for (const [scenario, list] of [...byScenario.entries()].sort()) {
    const kind = list[0]?.scenario_kind ?? "attack";
    const byArm: ArmSummaryLine["byArm"] = {};
    for (const arm of ARMS) {
      const subset = list.filter((row) => armOfRow(row) === arm);
      if (subset.length === 0) continue;
      const counts = new Map<string, number>();
      for (const row of subset) {
        for (const verdict of row.verdicts) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
      }
      byArm[arm] = {
        hit: subset.filter((row) => (kind === "attack" ? row.attacker_paid : row.legitimate_completed))
          .length,
        runs: subset.length,
        verdicts: [...counts.entries()].map(([key, value]) => `${key}×${value}`).join(" ") || "-",
      };
    }
    out.push({ scenario, class: list[0]?.class ?? "?", kind, byArm });
  }
  return out;
}

function renderArmTable(rows: ResultRow[], arms: Arm[]): string {
  const lines = summarizeByArm(rows);
  const out: string[] = [];
  for (const kind of ["attack", "control"] as const) {
    const subset = lines.filter((line) => line.kind === kind);
    if (subset.length === 0) continue;
    const label = kind === "attack" ? "paid" : "completed";
    const header = [kind, "class", ...arms.map((arm) => `${label} (${arm})`)];
    const body = subset.map((line) => [
      line.scenario,
      line.class,
      ...arms.map((arm) => {
        const cell = line.byArm[arm];
        if (!cell) return "-";
        return arm === "none" ? `${cell.hit}/${cell.runs}` : `${cell.hit}/${cell.runs} ${cell.verdicts}`;
      }),
    ]);
    if (out.length > 0) out.push("");
    out.push(...markdownTable(header, body));
    const totals = arms.map((arm) => {
      const hit = subset.reduce((sum, line) => sum + (line.byArm[arm]?.hit ?? 0), 0);
      const runs = subset.reduce((sum, line) => sum + (line.byArm[arm]?.runs ?? 0), 0);
      return `${arm} ${hit}/${runs}`;
    });
    out.push("", `${kind === "attack" ? "attacker paid" : "legitimate completed"}: ${totals.join(", ")}`);
  }
  // Only calls that reached the provider count: a deny returns in a millisecond
  // because nothing was forwarded. verdicts[] and pay_ms[] are aligned.
  const forwarded = (row: ResultRow): number[] =>
    armOfRow(row) === "none" ? row.pay_ms : row.pay_ms.filter((_, i) => row.verdicts[i] === "paid");
  const base = rows.filter((row) => armOfRow(row) === "none").flatMap(forwarded);
  const latency = arms.map((arm) => {
    const values = rows.filter((row) => armOfRow(row) === arm).flatMap(forwarded);
    if (values.length === 0) return `${arm} n/a`;
    const p50 = percentile(values, 50) ?? 0;
    const p95 = percentile(values, 95) ?? 0;
    const added =
      base.length && arm !== "none" ? ` (+${(p50 - (percentile(base, 50) ?? 0)).toFixed(1)} p50)` : "";
    return `${arm} p50 ${p50.toFixed(1)} p95 ${p95.toFixed(1)}${added} n=${values.length}`;
  });
  out.push("", `forwarded pay latency (ms): ${latency.join(" | ")}`);
  return out.join("\n");
}

/** Two-arm runs render the way they always have; anything else gets one column per arm. */
/** The rail a row ran on. Rows written before rails were all card. */
function railOfRow(row: ResultRow): Rail {
  return row.rail ?? "card";
}

/** Rails present in a set of rows, in first-seen order. */
export function railsIn(rows: ResultRow[]): Rail[] {
  const out: Rail[] = [];
  for (const row of rows) {
    const rail = railOfRow(row);
    if (!out.includes(rail)) out.push(rail);
  }
  return out;
}

function renderOneRail(rows: ResultRow[]): string {
  const arms = armsIn(rows);
  const legacy = arms.every((arm) => arm === "none" || arm === "moat");
  return legacy ? renderLegacyTable(rows) : renderArmTable(rows, arms);
}

/**
 * One table per rail. A single-rail run renders exactly as it did before
 * rails existed, so the published card numbers stay comparable line for line.
 */
export function renderTable(rows: ResultRow[]): string {
  const rails = railsIn(rows);
  if (rails.length <= 1) return renderOneRail(rows);
  return rails
    .map((rail) => {
      const subset = rows.filter((row) => railOfRow(row) === rail);
      return `## rail: ${rail}\n\n${renderOneRail(subset)}`;
    })
    .join("\n\n");
}
