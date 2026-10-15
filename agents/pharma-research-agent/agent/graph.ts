// A research run as a LangGraph graph:
//
//   START → input guard ─┬─ refused ─→ END
//                        └─ planner ─┬─ Send × 2–4 ─→ researcher (parallel) ─→ writer → output guard → checker → END
//                                    └─ follow-up answered from earlier turns ──→ writer
//
// The guards apply the risk catalogue (guardrails/risks.ts): the input guard
// screens the question before anything runs, the output guard checks the
// report before it is final. Retrieved content is screened inside each researcher.
//
// The planner's conditional edge fans out with `Send`: one researcher per
// subtask, all running at once, and the writer starts when they have all
// finished. Each researcher runs a graph of its own (subgraphs/researcher-loop.ts).
//
// Storage comes in from outside: a RunStore for the run's events, files and
// results, and a LangGraph checkpointer. With a checkpointer, LangGraph saves
// the state after every step and the writes of each finished task, so
// `runResearchGraph` can resume a run that died without redoing finished work.

import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { isBlocked } from "./guardrails/input.ts";
import { checkerNode } from "./nodes/checker.ts";
import { inputGuardNode } from "./nodes/input-guard.ts";
import { outputGuardNode } from "./nodes/output-guard.ts";
import { plannerNode } from "./nodes/planner.ts";
import { researcherNode } from "./nodes/researcher.ts";
import { writerNode } from "./nodes/writer.ts";
import { RunStateAnnotation, type RunState } from "./state.ts";
import type { RunStore } from "./store.ts";

/** The planner's edge: one researcher per subtask, in parallel, or straight to the writer. */
function fanOut(s: RunState): Send[] | "writer" {
  if (!s.plan || s.plan.mode === "answer" || !s.plan.subtasks.length) return "writer";
  return s.plan.subtasks.map((task) => new Send("researcher", { reportId: s.reportId, task }));
}

/** The input guard's edge: a refused question ends the run. */
const afterScreen = (s: RunState) => (s.screen && isBlocked(s.screen) ? END : "planner");

/** A failed model call is retried once by the node before the run gives up. */
const retry = { retryPolicy: { maxAttempts: 2 } };

export function buildResearchGraph(store: RunStore) {
  return new StateGraph(RunStateAnnotation)
    .addNode("input_guard", inputGuardNode(store), retry)
    .addNode("planner", plannerNode(store), retry)
    .addNode("researcher", researcherNode(store))
    .addNode("writer", writerNode(store), retry)
    .addNode("output_guard", outputGuardNode(store), retry)
    .addNode("checker", checkerNode(store), retry)
    .addEdge(START, "input_guard")
    .addConditionalEdges("input_guard", afterScreen, ["planner", END])
    .addConditionalEdges("planner", fanOut, ["researcher", "writer"])
    .addEdge("researcher", "writer")
    .addEdge("writer", "output_guard")
    .addEdge("output_guard", "checker")
    .addEdge("checker", END);
}

/**
 * Runs a report's research graph, or resumes it. The report id is the thread
 * id, so a second call after a crash picks up from the last checkpoint.
 */
export async function runResearchGraph(reportId: string, deps: { store: RunStore; checkpointer: BaseCheckpointSaver }): Promise<RunState> {
  const graph = buildResearchGraph(deps.store).compile({ checkpointer: deps.checkpointer, name: "research" });
  // Run name, tags and the report id show up in LangSmith when tracing is on (LANGSMITH_TRACING=true).
  const config = { configurable: { thread_id: reportId }, recursionLimit: 25, runName: "research", tags: ["pharma-research-agent"], metadata: { report_id: reportId } };
  if (!(await deps.checkpointer.getTuple(config))) return graph.invoke({ reportId }, config);
  const saved = await graph.getState(config);
  // Steps left to run: resume from the checkpoint. None: the graph already finished.
  if (saved.next.length) return graph.invoke(null, config);
  return saved.values as RunState;
}
