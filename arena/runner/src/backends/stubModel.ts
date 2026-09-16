// A scripted Model for testing the OpenAI backend without an API key.
//
// It implements the SDK's Model interface and emits a fixed sequence of tool
// calls, so the real agent loop runs — MCP connection to the gateway, tool
// discovery, tool execution, output items, trace extraction — with no network
// and no tokens. What it cannot test is whether a real model falls for an
// injection; that is what `--backend openai` with a key is for.

import { Usage } from "@openai/agents";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";

export interface ScriptedCall {
  /** Bare tool name; the stub resolves it against the tools actually offered. */
  tool: string;
  args: Record<string, unknown>;
}

export class ScriptedModel implements Model {
  private turn = 0;
  /** Tool names the server offered on the first request, for assertions. */
  offered: string[] = [];

  constructor(
    private readonly script: ScriptedCall[],
    private readonly finalText = "done",
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const tools = (request.tools ?? []) as { name?: string }[];
    if (this.turn === 0) {
      this.offered = tools.map((t) => String(t.name ?? "")).filter(Boolean);
    }
    const step = this.script[this.turn];
    this.turn += 1;

    if (!step) {
      return {
        usage: new Usage(),
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: this.finalText }],
          },
        ],
      } as unknown as ModelResponse;
    }

    // Match the offered name, which is namespaced when the gateway aggregates.
    const name =
      this.offered.find((n) => n === step.tool || n.endsWith(`__${step.tool}`)) ?? step.tool;

    return {
      usage: new Usage(),
      output: [
        {
          type: "function_call",
          id: `stub_${this.turn}`,
          callId: `stub_${this.turn}`,
          name,
          status: "completed",
          arguments: JSON.stringify(step.args),
        },
      ],
    } as unknown as ModelResponse;
  }

  // The runner never streams; this satisfies the interface.
  getStreamedResponse(request: ModelRequest): AsyncIterable<never> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        await self.getResponse(request);
        throw new Error("ScriptedModel does not stream");
      },
    };
  }
}
