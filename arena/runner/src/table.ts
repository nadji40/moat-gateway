import { percentile, type ResultRow } from "./results.js";

export interface SummaryLine {
  attack: string;
  class: string;
  runs: number;
  paidDirect: number;
  paidGateway: number;
  verdicts: string;
}

export function summarize(rows: ResultRow[]): SummaryLine[] {
  const byAttack = new Map<string, ResultRow[]>();
  for (const r of rows) {
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

export function renderTable(rows: ResultRow[]): string {
  const lines = summarize(rows);
  const header = ["attack", "class", "runs", "paid (direct)", "paid (gateway)", "gateway verdicts"];
  const body = lines.map((l) => [
    l.attack,
    l.class,
    String(l.runs),
    `${l.paidDirect}/${l.runs}`,
    `${l.paidGateway}/${l.runs}`,
    l.verdicts,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]): string =>
    "| " + r.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  const out = [fmt(header), sep, ...body.map(fmt)];

  const totalDirect = lines.reduce((a, l) => a + l.paidDirect, 0);
  const totalGateway = lines.reduce((a, l) => a + l.paidGateway, 0);
  const totalRuns = lines.reduce((a, l) => a + l.runs, 0);
  out.push("", `attacker paid: direct ${totalDirect}/${totalRuns}, gateway ${totalGateway}/${totalRuns}`);

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
