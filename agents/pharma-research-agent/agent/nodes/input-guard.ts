// The input guard node: the first node of every run. It records personal data
// the API route redacted, then screens the question (guardrails/input.ts).
// A refused question ends the run here; personal advice continues as its
// general question. If the screen itself cannot run, the node fails and the run
// fails with it: an unscreened question is never researched.

import { MESSAGES, isBlocked, screenQuestion } from "../guardrails/input.ts";
import { redactedKinds } from "../guardrails/pii.ts";
import { isOffline, modelName } from "../config.ts";
import { guardModel } from "../model.ts";
import type { RunState } from "../state.ts";
import type { RunBudget } from "../limits.ts";
import type { RunStore } from "../store.ts";
import type { GuardDecision } from "../types.ts";
import { conversationContext, nodeContext } from "./context.ts";

export const inputGuardNode = (store: RunStore, budget?: RunBudget) => async (s: RunState): Promise<Partial<RunState>> => {
  const started = await store.start(s.reportId);
  const { sink, tracer, done } = await nodeContext(store, s.reportId, "guard-in", budget);
  const decide = (d: GuardDecision) => sink.emit({ type: "guardrail", decision: d });

  sink.emit({ type: "run", id: s.reportId, query: started.query, model: modelName(), mode: isOffline() ? "offline" : "live", at: started.startedAt.toISOString() });
  sink.emit({ type: "span", span: { id: "run", kind: "run", name: "research run", start: 0, status: "running", attrs: {} } });

  // Personal data never reached the database: the API route redacted it. Record what was removed.
  const kinds = redactedKinds(started.query);
  decide({ stage: "input", check: "personal-data", outcome: kinds.length ? "redact" : "pass", detail: kinds.length ? `Removed from the question before it was stored or sent to a model: ${kinds.join(", ")}.` : "No personal data found.", risks: kinds.length ? ["personal-data"] : undefined });

  const context = conversationContext(await store.earlierTurns(s.reportId));
  const result = await tracer.wrap("agent", "input guard", "run", async (span) =>
    tracer.wrap("llm", "screen question", span.id, async (sp) => {
      const r = await screenQuestion(guardModel(budget), started.query, context);
      if (r.usage) tracer.addUsage(r.usage);
      tracer.close(sp, { verdict: r.screen.verdict, by: r.by, ...(r.usage ? { input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost } : {}) });
      return r;
    }),
  );
  const { screen } = result;
  decide({
    stage: "input",
    check: "screen",
    outcome: screen.verdict === "research" ? "pass" : isBlocked(screen) ? "block" : "redirect",
    detail: screen.verdict === "research" ? `On topic. ${result.reason}`.trim() : (screen.message ?? MESSAGES.off_topic),
    risks: result.risks.length ? result.risks : undefined,
  });
  await done();
  return { screen };
};
