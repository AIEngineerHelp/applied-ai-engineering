// The researcher node: one per subtask, started by the planner's Send. It runs
// a sub-agent's own graph (subgraphs/researcher-loop.ts) and never throws: a
// failed knowledge base becomes an honest empty finding.

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { getToolsets } from "../config.ts";
import { chatModel } from "../model.ts";
import { loadSkills } from "../skills/index.ts";
import type { RunState } from "../state.ts";
import type { RunStore } from "../store.ts";
import { research } from "../subgraphs/researcher-loop.ts";
import type { Finding, Source } from "../types.ts";
import { nodeContext, thoughtStream } from "./context.ts";

export const researcherNode = (store: RunStore) => async (s: RunState, config: LangGraphRunnableConfig): Promise<Partial<RunState>> => {
  const task = s.task!;
  const { sink, tracer, vfs, done } = await nodeContext(store, s.reportId, task.id);
  const registry = new Map<string, Source>();
  let finding: Finding;
  try {
    finding = await research(
      { model: chatModel(), tracer, vfs, registry, onSources: (subtask, sources) => sink.emit({ type: "sources", subtask, sources }), onThought: thoughtStream(sink, task.id) },
      task,
      getToolsets()[task.source],
      loadSkills(),
      "run",
      config,
    );
  } catch (err) {
    finding = { subtask: task.id, summary: `This sub-agent failed: ${(err as Error).message}`, claims: [], gaps: [task.question] };
  }
  sink.emit({ type: "finding", finding });
  await done();
  return { findings: [finding] };
};
