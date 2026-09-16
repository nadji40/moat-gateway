import type { Attack } from "../attacks.js";
import type { AgentBackend, AgentTrace, Tools } from "./types.js";

/** OpenAI Agents SDK backend. Arrives with work order step 10. */
export class OpenAIBackend implements AgentBackend {
  readonly name = "openai";

  async run(_attack: Attack, _tools: Tools): Promise<AgentTrace> {
    throw new Error("the openai backend is not implemented yet (work order step 10)");
  }
}
