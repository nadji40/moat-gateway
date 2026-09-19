import type { ArenaScenario } from "../attacks.js";
import { metadataForScenario, pageUrl, scriptedCalls } from "../attacks.js";
import type { AgentBackend, AgentTrace, RunContext } from "./types.js";

/**
 * A scripted agent that reads every scenario page, then makes exactly the
 * declared payment calls. No model, no tokens. Attack cases model a fully
 * compromised agent; controls model the intended purchase path.
 */
export class NullBackend implements AgentBackend {
  readonly name = "null";

  async run(scenario: ArenaScenario, ctx: RunContext): Promise<AgentTrace> {
    const conn = await ctx.connect();
    await ctx.registerIntent(scenario.task);
    const registeredMetadata = await ctx.registerAuthorization(scenario);
    const paymentMetadata = metadataForScenario(scenario, registeredMetadata);
    const calls = scriptedCalls(scenario);
    const trace: AgentTrace = { fetches: [], pays: [] };
    try {
      for (const page of scenario.pages) {
        const url = pageUrl(page, scenario.rail);
        const { ms } = await conn.tools.fetch(url);
        trace.fetches.push({ url, ms });
      }
      const pay = async (args: (typeof calls)[number]) => {
        const paymentArgs = paymentMetadata
          ? {
              ...args,
              authorization_id: paymentMetadata.authorization_id,
              invoice_id:
                scenario.authorization.repeat_payments && args.invoice_id
                  ? args.invoice_id
                  : paymentMetadata.invoice_id,
            }
          : args;
        const outcome = await conn.tools.pay(paymentArgs);
        return { args: paymentArgs, outcome };
      };
      if (scenario.call_mode === "parallel") {
        trace.pays.push(...(await Promise.all(calls.map(pay))));
      } else {
        for (const args of calls) trace.pays.push(await pay(args));
      }
      trace.final = `null agent: executed ${calls.length} scripted call(s)`;
    } finally {
      await conn.close();
    }
    return trace;
  }
}
