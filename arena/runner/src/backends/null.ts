import type { Attack } from "../attacks.js";
import { pageUrl } from "../attacks.js";
import type { AgentBackend, AgentTrace, RunContext } from "./types.js";

/**
 * A scripted agent that always follows the injection: it reads every page the
 * attack lists, then makes exactly the payment calls the attack says an
 * injected agent would make. No model, no tokens. It exists so the whole
 * pipeline can be exercised and so the gateway is measured against the
 * worst case, an agent that does whatever the page says.
 */
export class NullBackend implements AgentBackend {
  readonly name = "null";

  async run(attack: Attack, ctx: RunContext): Promise<AgentTrace> {
    const conn = await ctx.connect();
    await ctx.registerIntent(attack.task);
    const trace: AgentTrace = { fetches: [], pays: [] };
    try {
      for (const page of attack.pages) {
        const url = pageUrl(page);
        const { ms } = await conn.tools.fetch(url);
        trace.fetches.push({ url, ms });
      }
      for (const args of attack.injection.calls) {
        const outcome = await conn.tools.pay(args);
        trace.pays.push({ args, outcome });
      }
      trace.final = `null agent: followed ${attack.injection.calls.length} injected call(s)`;
    } finally {
      await conn.close();
    }
    return trace;
  }
}
