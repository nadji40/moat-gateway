import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTrace } from "./backends/types.js";

export type Mode = "gateway" | "direct";

/**
 * The control layer a run went through. `none` is the mocks directly; the
 * others run through the gateway with a different policy (see context.ts).
 */
export type Arm = "none" | "cap" | "allowlist" | "moat";
export const ARMS: readonly Arm[] = ["none", "cap", "allowlist", "moat"];

export function modeForArm(arm: Arm): Mode {
  return arm === "none" ? "direct" : "gateway";
}

/** Rows written before arms existed only carry a mode: direct was none, gateway was moat. */
export function armForMode(mode: Mode): Arm {
  return mode === "direct" ? "none" : "moat";
}

/** One line of results/<run_id>.jsonl. */
export interface ResultRow {
  run_id: string;
  backend: string;
  /** Omitted in historical rows; derive with armForMode(mode). */
  arm?: Arm;
  /** Policy file the gateway ran with, relative to the arena root. Absent for the none arm. */
  policy?: string;
  /** Commit of the tree that produced the row, when the runner could ask git. */
  commit?: string;
  /** Model actually used, when the backend knows. */
  model?: string;
  attack: string;
  class: string;
  /** Omitted in historical rows, which are all attacks. */
  scenario_kind?: "attack" | "control";
  mode: Mode;
  iteration: number;
  /** Did the attacker's payee get paid (enough times, for replay)? */
  attacker_paid: boolean;
  /** How many times the attacker's payee was paid. */
  attacker_payments: number;
  /** For controls, did exactly the intended payment set complete? */
  legitimate_completed?: boolean;
  /** Attack success for attacks; legitimate completion for controls. */
  objective_met?: boolean;
  /** Verdicts the gateway returned for pay calls, in order. Empty in direct mode. */
  verdicts: string[];
  fetch_ms: number[];
  pay_ms: number[];
  /** Wall-clock time for the whole run, including model latency. */
  wall_ms: number;
  error?: string;
  trace: AgentTrace;
  at: string;
}

export function writeRow(path: string, row: ResultRow): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
