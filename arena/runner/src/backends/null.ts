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
    let connClosed = false;
    try {
      for (const page of scenario.pages) {
        const url = pageUrl(page, scenario.rail);
        const { ms } = await conn.tools.fetch(url);
        trace.fetches.push({ url, ms });
      }
      const paymentArgsFor = (args: (typeof calls)[number]) => {
        if (!paymentMetadata) return args;
        const unboundInvoice =
          scenario.kind === "attack" && scenario.authorization.invoice_id === null;
        return {
          ...args,
          authorization_id: paymentMetadata.authorization_id,
          invoice_id:
            unboundInvoice || scenario.authorization.repeat_payments
              ? args.invoice_id ?? paymentMetadata.invoice_id
              : paymentMetadata.invoice_id,
        };
      };
      const pay = async (tools: typeof conn.tools, args: (typeof calls)[number]) => {
        const paymentArgs = paymentArgsFor(args);
        const outcome = await tools.pay(paymentArgs);
        return { args: paymentArgs, outcome };
      };
      // Partway through, somebody may go and check with the provider.
      // That is what clears a hold, and a scenario about a lost reply is
      // not finished without it.
      const reconcile = scenario.kind === "control" ? scenario.reconcile : undefined;
      if (scenario.call_mode === "parallel") {
        trace.pays.push(...(await Promise.all(calls.map((args) => pay(conn.tools, args)))));
      } else {
        for (const [index, args] of calls.entries()) {
          trace.pays.push(await pay(conn.tools, args));
          if (reconcile && reconcile.after_call === index + 1) {
            await ctx.reconcileOpenOutcomes(reconcile.status);
          }
        }
      }
      if (scenario.kind === "attack") {
        if (scenario.additional_sessions.length > 0) {
          // Each gateway process binds its own intent API address. Close the
          // first session before opening the next process, then reuse the
          // durable authorization that session registered.
          await conn.close();
          connClosed = true;
        }
        for (const [index, group] of scenario.additional_sessions.entries()) {
          const session = await ctx.connectSession(`${ctx.session}-extra-${index + 1}`);
          try {
            for (const args of group.calls) trace.pays.push(await pay(session.tools, args));
          } finally {
            await session.close();
          }
        }
      }
      trace.final = `null agent: executed ${trace.pays.length} scripted call(s)`;
    } finally {
      if (!connClosed) await conn.close();
    }
    return trace;
  }
}
