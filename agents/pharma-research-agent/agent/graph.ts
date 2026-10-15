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
import { LimitReached, RunBudget, isLimit, limitsFromEnv, type Limits } from "./limits.ts";
import type { RunStore } from "./store.ts";

/** The planner's edge: one researcher per subtask, in parallel, or straight to the writer. */
function fanOut(s: RunState): Send[] | "writer" {
  if (!s.plan || s.plan.mode === "answer" || !s.plan.subtasks.length) return "writer";
  return s.plan.subtasks.map((task) => new Send("researcher", { reportId: s.reportId, task }));
}

/** The input guard's edge: a refused question ends the run. */
const afterScreen = (s: RunState) => (s.screen && isBlocked(s.screen) ? END : "planner");

/** A failed model call is retried once by the node before the run gives up; a run limit is not retried. */
const retry = { retryPolicy: { maxAttempts: 2, retryOn: (e: unknown) => !isLimit(e) && !["AbortError", "TimeoutError"].includes((e as Error | undefined)?.name ?? "") } };

export function buildResearchGraph(store: RunStore, budget?: RunBudget) {
  return new StateGraph(RunStateAnnotation)
    .addNode("input_guard", inputGuardNode(store, budget), retry)
    .addNode("planner", plannerNode(store, budget), retry)
    .addNode("researcher", researcherNode(store, budget))
    .addNode("writer", writerNode(store, budget), retry)
    .addNode("output_guard", outputGuardNode(store, budget), retry)
    .addNode("checker", checkerNode(store, budget), retry)
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
 *
 * Limits (limits.ts): every model call checks the run's budget, which counts
 * what earlier attempts spent. The run has a total deadline from its start, and
 * each attempt stops early enough to resume from its checkpoint rather than be
 * killed by the platform's function time limit.
 */
export async function runResearchGraph(reportId: string, deps: { store: RunStore; checkpointer: BaseCheckpointSaver; limits?: Limits }): Promise<RunState> {
  const limits = deps.limits ?? limitsFromEnv();
  const run = await deps.store.get(reportId);
  const remaining = limits.maxSeconds * 1000 - (Date.now() - run.startedAt.getTime());
  if (remaining <= 0) throw new LimitReached(`This research stopped because it ran longer than ${Math.round(limits.maxSeconds / 60)} minutes.`);
  const budget = new RunBudget(limits, run.spent);
  const graph = buildResearchGraph(deps.store, budget).compile({ checkpointer: deps.checkpointer, name: "research" });
  const attempt = Math.min(remaining, limits.attemptSeconds * 1000);
  // Run name, tags and the report id show up in LangSmith when tracing is on (LANGSMITH_TRACING=true).
  const config = { configurable: { thread_id: reportId }, recursionLimit: 25, runName: "research", tags: ["pharma-research-agent"], metadata: { report_id: reportId }, signal: AbortSignal.timeout(attempt) };
  try {
    if (!(await deps.checkpointer.getTuple(config))) return await graph.invoke({ reportId }, config);
    const saved = await graph.getState(config);
    // Steps left to run: resume from the checkpoint. None: the graph already finished.
    if (saved.next.length) return await graph.invoke(null, config);
    return saved.values as RunState;
  } catch (err) {
    if (config.signal.aborted) {
      // Out of time for the whole run: stop. Out of time for this attempt only: a retry resumes from the checkpoint.
      if (attempt >= remaining) throw new LimitReached(`This research stopped because it ran longer than ${Math.round(limits.maxSeconds / 60)} minutes.`);
      throw new Error(`This attempt reached its ${limits.attemptSeconds}s time limit; the run resumes from its last checkpoint.`);
    }
    throw err;
  }
}
