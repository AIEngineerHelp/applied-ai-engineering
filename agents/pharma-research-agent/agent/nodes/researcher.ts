// The researcher node: one per subtask, started by the planner's Send. It runs
// a sub-agent's own graph (subgraphs/researcher-loop.ts) and never throws: a
// failed knowledge base becomes an honest empty finding.

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { getToolsets } from "../config.ts";
import { chatModel } from "../model.ts";
import { loadSkills } from "../skills/index.ts";
import type { RunState } from "../state.ts";
import { isLimit, type RunBudget } from "../limits.ts";
import type { RunStore } from "../store.ts";
import { research } from "../subgraphs/researcher-loop.ts";
import type { Finding, Source } from "../types.ts";
import { nodeContext, thoughtStream } from "./context.ts";

export const researcherNode = (store: RunStore, budget?: RunBudget) => async (s: RunState, config: LangGraphRunnableConfig): Promise<Partial<RunState>> => {
  const task = s.task!;
  const { sink, tracer, vfs, done } = await nodeContext(store, s.reportId, task.id, budget);
  const registry = new Map<string, Source>();
  let finding: Finding;
  try {
    finding = await research(
      { model: chatModel(budget), tracer, vfs, registry, onSources: (subtask, sources) => sink.emit({ type: "sources", subtask, sources }), onThought: thoughtStream(sink, task.id), onGuard: (decision) => sink.emit({ type: "guardrail", decision }) },
      task,
      getToolsets()[task.source],
      loadSkills(),
      "run",
      config,
    );
  } catch (err) {
    // A failed knowledge base is an empty finding; a run limit stops the run.
    if (isLimit(err)) throw err;
    finding = { subtask: task.id, summary: `This sub-agent failed: ${(err as Error).message}`, claims: [], gaps: [task.question] };
  }
  sink.emit({ type: "finding", finding });
  await done();
  return { findings: [finding] };
};
