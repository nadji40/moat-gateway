import type { Attack, PayCall } from "../attacks.js";

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
  /** Raw MCP tool descriptors, for backends that hand tools to a model. */
  descriptors(): Promise<ToolDescriptor[]>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentTrace {
  /** Every fetch the agent made, in order. */
  fetches: { url: string; ms: number }[];
  /** Every pay the agent attempted, in order. */
  pays: { args: PayCall; outcome: PayOutcome }[];
  /** The agent's final text, if any. */
  final?: string;
  /** Tokens spent, if the backend knows. */
  tokens?: { input: number; output: number };
}

/** An agent that can be driven through one attack task. */
export interface AgentBackend {
  readonly name: string;
  run(attack: Attack, tools: Tools): Promise<AgentTrace>;
}
