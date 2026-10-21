import type { ArenaScenario, PayCall } from "../attacks.js";
import type { Connected, Endpoints } from "../mcp.js";
import type { Rail } from "../rails.js";
import type { Defense } from "../defenses.js";
import type { Arm } from "../results.js";

/** What a `pay` call came back as. */
export type PayOutcome =
  | { kind: "paid"; receipt: string; ms: number }
  | { kind: "step_up"; evidenceId: string; prompt: string; ms: number }
  | { kind: "deny"; evidenceId: string; reasons: string[]; ms: number }
  | { kind: "error"; message: string; ms: number };

/** The two tools every backend gets, already routed to the right server. */
export interface Tools {
  fetch(url: string): Promise<{ text: string; ms: number }>;
  pay(args: PayCall): Promise<PayOutcome>;
  descriptors(): Promise<ToolDescriptor[]>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PaymentMetadata {
  authorization_id: string;
  invoice_id: string;
}

export interface AgentTrace {
  /** Every fetch the agent made, in order. */
  fetches: { url: string; ms: number }[];
  /** Every pay the agent attempted, in order. */
  pays: { args: PayCall; outcome: PayOutcome }[];
  /** The agent's final text, if any. */
  final?: string;
  /** Tokens spent, if the backend knows. */
  tokens?: { input: number; output: number; requests: number };
  /** Model actually used, if the backend knows. */
  model?: string;
}

/**
 * What the runner hands a backend. A backend either uses `connect()` to get
 * the two tools ready-made, or builds its own MCP client from `endpoints` —
 * an agent SDK does the latter, because the point is to prove the SDK talks
 * to the gateway unmodified.
 *
 * Whoever opens the connection must call `registerIntent()` afterwards: in
 * gateway mode the intent API only exists once the gateway process is up.
 */
export interface RunContext {
  readonly mode: "gateway" | "direct";
  /** Which evaluation arm this run is; `mode` is derived from it. */
  readonly arm: Arm;
  /**
   * The published prompt-injection defense in front of the agent, on the arms
   * that have one. Absent everywhere else, including `moat`: Moat is not a
   * prompt defense and running it as one would be the wrong comparison.
   */
  readonly defense?: Defense;
  /** Which settlement rail the money would leave on. */
  readonly rail: Rail;
  readonly session: string;
  readonly endpoints: Endpoints;
  /** Open the runner's own MCP clients and get the two tools. */
  connect(): Promise<Connected>;
  /** Open another independent payment session for cross-session scenarios. */
  connectSession(session: string): Promise<Connected>;
  /** Tell Moat what the human asked for. No-op in direct mode. */
  registerIntent(text: string): Promise<void>;
  /**
   * Report to Moat what the provider actually did with whatever it is
   * still holding, as an operator would after checking. A no-op on the
   * arms that hold nothing.
   */
  reconcileOpenOutcomes(status: string): Promise<number>;
  /** Register trusted payment authority and return the ids a payment call must carry. */
  registerAuthorization(scenario: ArenaScenario): Promise<PaymentMetadata | undefined>;
}

/** An agent that can be driven through one attack or legitimate control task. */
export interface AgentBackend {
  readonly name: string;
  run(scenario: ArenaScenario, ctx: RunContext): Promise<AgentTrace>;
}
