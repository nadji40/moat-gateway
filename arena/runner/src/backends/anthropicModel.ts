// A Claude Model for the OpenAI Agents SDK.
//
// The arena's real-model runs go through the Agents SDK so that the agent
// loop, the MCP connection to the gateway and the trace extraction are the
// same code for every model. This adapter is the only Claude-specific part:
// it turns the SDK's request into a Messages API call and the reply back
// into the SDK's output items. The model sees the same instructions, the
// same tools and the same pages as the GPT runs, and is told nothing about
// Moat.
//
// Thinking cannot be turned off on Claude Opus 5.5, and the API requires
// every earlier assistant turn, thinking blocks included, to come back
// exactly as it was sent. The SDK keeps only its own item shapes, so each
// assistant turn's raw content rides on the first item of that turn as
// providerData and is replayed verbatim; the items the SDK reads (messages,
// function calls) are derived from it and never rebuilt into the request.

import Anthropic from "@anthropic-ai/sdk";
import { Usage } from "@openai/agents";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** What one assistant turn leaves on its items for the next request. */
interface TurnData {
  turn: string;
  /** The turn's content blocks exactly as the API returned them; on the first item only. */
  content?: Anthropic.ContentBlock[];
}

type Item = Record<string, unknown> & { providerData?: { anthropic?: TurnData } };

export class ClaudeModel implements Model {
  private readonly client = new Anthropic();

  constructor(
    readonly name: string = DEFAULT_CLAUDE_MODEL,
    private readonly maxTokens = 16000,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const { system, messages } = toMessages(request);
    const tools = toTools(request);
    const response = await this.client.messages.create(
      {
        model: this.name,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        messages,
        ...(tools.length ? { tools } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );
    return {
      usage: new Usage({
        requests: 1,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      }),
      output: toOutput(response),
      responseId: response.id,
    } as unknown as ModelResponse;
  }

  // The runner never streams; this satisfies the interface.
  getStreamedResponse(): AsyncIterable<never> {
    return {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error("ClaudeModel does not stream");
      },
    };
  }
}

function toTools(request: ModelRequest): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const t of request.tools ?? []) {
    const tool = t as { type?: string; name?: string; description?: string; parameters?: unknown };
    if (tool.type !== "function" || !tool.name) continue;
    tools.push({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: (tool.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
    });
  }
  return tools;
}

/** A tool result or a user message as plain text, whatever shape the SDK gave it. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") {
    const v = value as { text?: unknown; type?: string };
    if (typeof v.text === "string") return v.text;
    return JSON.stringify(value);
  }
  return value === undefined || value === null ? "" : String(value);
}

function parseInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/**
 * The SDK's history as Messages API turns. Consecutive blocks of the same
 * role are merged, because the API wants turns to alternate and every
 * tool result for a turn in the one user message that follows it.
 */
function toMessages(request: ModelRequest): { system: string; messages: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  if (request.systemInstructions) systemParts.push(request.systemInstructions);
  const messages: Anthropic.MessageParam[] = [];

  const push = (role: "user" | "assistant", blocks: Anthropic.ContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
    } else {
      messages.push({ role, content: [...blocks] });
    }
  };

  const items: Item[] =
    typeof request.input === "string"
      ? [{ role: "user", content: request.input }]
      : (request.input as unknown as Item[]);

  const replayed = new Set<string>();
  for (const item of items) {
    const turn = item.providerData?.anthropic;
    if (turn) {
      // An assistant turn this adapter produced: send it back exactly as the
      // API returned it, once, and skip the items derived from it.
      if (replayed.has(turn.turn)) continue;
      replayed.add(turn.turn);
      if (turn.content) {
        push("assistant", turn.content as unknown as Anthropic.ContentBlockParam[]);
        continue;
      }
    }

    const type = item["type"];
    const role = item["role"];
    if (type === "function_call_result") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: String(item["callId"] ?? ""),
          content: textOf(item["output"]) || "(no output)",
        },
      ]);
    } else if (type === "function_call") {
      push("assistant", [
        {
          type: "tool_use",
          id: String(item["callId"] ?? ""),
          name: String(item["name"] ?? ""),
          input: parseInput(item["arguments"]),
        },
      ]);
    } else if (role === "system" || role === "developer") {
      systemParts.push(textOf(item["content"]));
    } else if (role === "user") {
      const text = textOf(item["content"]);
      if (text) push("user", [{ type: "text", text }]);
    } else if (role === "assistant") {
      const text = textOf(item["content"]);
      if (text) push("assistant", [{ type: "text", text }]);
    }
    // Reasoning and other item types are never produced by this adapter.
  }

  return { system: systemParts.join("\n\n"), messages };
}

/** The reply as the SDK's output items: text as one message, each tool use as a function call. */
function toOutput(response: Anthropic.Message): Item[] {
  const turn = response.id;
  const items: Item[] = [];
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  for (const block of response.content) {
    if (block.type !== "tool_use") continue;
    items.push({
      type: "function_call",
      id: block.id,
      callId: block.id,
      name: block.name,
      status: "completed",
      arguments: JSON.stringify(block.input ?? {}),
    });
  }
  // A turn that calls no tool ends the run, so it must carry a message even
  // when the model said nothing, or refused.
  if (text || items.length === 0) {
    // A refusal is a safety classifier stopping the turn, not the model
    // declining to pay; its category goes into the trace so the two are
    // never counted as the same thing.
    const refusal = response.stop_reason === "refusal";
    const category = refusal ? (response.stop_details?.category ?? "unknown") : null;
    const said =
      text || (refusal ? `(classifier refusal: ${category})` : `(no text, stop ${response.stop_reason})`);
    items.unshift({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: said }],
    });
  }

  items.forEach((item, i) => {
    item.providerData = { anthropic: i === 0 ? { turn, content: response.content } : { turn } };
  });
  return items;
}
