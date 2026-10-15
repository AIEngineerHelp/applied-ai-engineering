// A research run as a LangGraph graph:
//
//   START → planner ─┬─ Send × 2–4 ─→ researcher (in parallel) ─→ writer → checker → END
//                    └─ follow-up answered from earlier turns ──→ writer
//
// The planner's conditional edge fans out with `Send`: one researcher per
// subtask, all running at once, and the writer starts when they have all
// finished. Each researcher is a graph of its own (agents/researcher.ts).
//
// With a checkpointer, LangGraph saves the state after every step and the
// writes of each finished task, so `runResearchGraph` can resume a run that
// died: finished researchers are not run again.
//
// Nodes keep the app's own event stream: each writes spans, thoughts, files
// and sources to Postgres as it works, which is what the browser follows.

import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { Annotation, END, Send, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { and, asc, eq, lt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { plan as makePlan } from "./agents/orchestrator.ts";
import { research } from "./agents/researcher.ts";
import { draftForDisplay, renderReport, synthesize } from "./agents/synthesis.ts";
import { DrizzleSaver } from "./checkpointer.ts";
import { checks, groundedness } from "./evals.ts";
import { chatModel } from "./model.ts";
import { EventSink, addUsage, loadFiles, loadSources } from "./persist.ts";
import { getToolsets, isOffline, modelName } from "./runtime.ts";
import { loadSkills } from "./skills.ts";
import { throttle } from "./throttle.ts";
import { Tracer } from "./trace.ts";
import type { EvalResult, Finding, Plan, Report, Source, Subtask } from "./types.ts";
import { VirtualFS } from "./vfs.ts";

const { reports } = schema;
const MAX_SUBTASKS = 4;

/** The graph's state. Parallel researchers each add one finding; the reducer collects them. */
export const RunState = Annotation.Root({
  reportId: Annotation<string>(),
  /** Set only on a researcher's input, by the Send that started it. */
  task: Annotation<Subtask | undefined>(),
  plan: Annotation<Plan | undefined>(),
  findings: Annotation<Finding[]>({ reducer: (all, more) => all.concat(more), default: () => [] }),
  report: Annotation<Report | undefined>(),
  evals: Annotation<EvalResult[] | undefined>(),
});
type Run = typeof RunState.State;

async function getReport(id: string) {
  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, id));
  if (!row) throw new Error(`Report ${id} not found`);
  return row;
}

/**
 * Earlier turns of this report's conversation, condensed, so a follow-up is
 * understood in context ("what about in women?"). Citations are stripped: the
 * new turn must find and cite its own sources.
 */
async function threadContext(row: { threadId: string; position: number }): Promise<string | undefined> {
  if (row.position === 0) return undefined;
  const d = await db();
  const prior = await d
    .select({ query: reports.query, report: reports.report })
    .from(reports)
    .where(and(eq(reports.threadId, row.threadId), lt(reports.position, row.position), eq(reports.status, "completed")))
    .orderBy(asc(reports.position));
  if (!prior.length) return undefined;
  const strip = (t: string) => t.replace(/\s*\[[^\]]+\]/g, "");
  return [
    "Earlier in this conversation:",
    ...prior.map((p, i) => `Q${i + 1}: ${p.query}\nA${i + 1}: ${strip(p.report?.answer ?? "").slice(0, 900)}${p.report?.sections.length ? `\n(Sections: ${p.report.sections.map((x) => x.heading).join("; ")})` : ""}`),
  ].join("\n");
}

/**
 * For a follow-up answered without new research: the earlier answers in full,
 * citations kept, and every source they could cite.
 */
async function earlierTurns(row: { threadId: string; position: number }): Promise<{ text: string; sources: Source[] }> {
  const d = await db();
  const prior = await d
    .select({ id: reports.id, query: reports.query, report: reports.report })
    .from(reports)
    .where(and(eq(reports.threadId, row.threadId), lt(reports.position, row.position), eq(reports.status, "completed")))
    .orderBy(asc(reports.position));
  const sources = new Map<string, Source>();
  for (const p of prior) for (const s of await loadSources(p.id)) sources.set(s.id, s);
  const text = prior.filter((p) => p.report).map((p, i) => `## Turn ${i + 1}\n\nQuestion: ${p.query}\n\n${renderReport(p.report!)}`).join("\n\n");
  return { text, sources: [...sources.values()] };
}

/** Streams thought summaries for many concurrent model calls, a few writes a second each. */
function thoughtStream(sink: EventSink, agent: string) {
  const streams = new Map<string, ReturnType<typeof throttle<{ text: string; done: boolean }>>>();
  return (key: string, text: string, done: boolean) => {
    let t = streams.get(key);
    if (!t) {
      t = throttle((v) => sink.emit({ type: "thought", key, agent, text: v.text, done: v.done }));
      streams.set(key, t);
    }
    t.push({ text, done });
    if (done) t.flush();
  };
}

/** A tracer and file system for one node, writing through to the database. */
async function nodeContext(reportId: string, prefix: string) {
  const row = await getReport(reportId);
  const t0 = (row.startedAt ?? row.createdAt).getTime();
  const sink = new EventSink(reportId);
  const tracer = new Tracer(sink.emit, { t0, prefix });
  const vfs = new VirtualFS((f) => sink.emit({ type: "file", path: f.path, bytes: f.content.length, by: f.by, content: f.content }));
  const done = async () => {
    await sink.flush();
    await addUsage(reportId, { ...tracer.usage, calls: tracer.calls, toolCalls: tracer.toolCalls, priced: tracer.priced });
  };
  return { row, sink, tracer, vfs, done };
}

async function planner(s: Run): Promise<Partial<Run>> {
  const d = await db();
  const first = await getReport(s.reportId);
  const startedAt = first.startedAt ?? new Date();
  await d.update(reports).set({ status: "running", startedAt }).where(eq(reports.id, s.reportId));
  const { row, sink, tracer, vfs, done } = await nodeContext(s.reportId, "plan");
  const skills = loadSkills();

  sink.emit({ type: "run", id: s.reportId, query: row.query, model: modelName(), mode: isOffline() ? "offline" : "live", at: startedAt.toISOString() });
  sink.emit({ type: "skills", available: skills.map((x) => ({ name: x.name, description: x.description })) });
  sink.emit({ type: "span", span: { id: "run", kind: "run", name: "research run", start: 0, status: "running", attrs: {} } });

  const context = await threadContext(row);
  const thought = thoughtStream(sink, "orchestrator");
  const plan = await tracer.wrap("agent", "orchestrator", "run", async (span) =>
    tracer.wrap("llm", "plan subtasks", span.id, async (sp) => {
      const p = await makePlan(chatModel(), row.query, skills, MAX_SUBTASKS, { context, onThought: (t) => thought("plan", t, false), onUsage: (u) => tracer.addUsage(u) });
      tracer.close(sp, { subtasks: p.subtasks.length, input: tracer.usage.input, output: tracer.usage.output, cost: tracer.usage.cost });
      return p;
    }),
  );
  thought("plan", "", true);
  vfs.write("/plan.md", ["# Plan", "", plan.focus, "", ...(plan.mode === "answer" ? [`No new research: ${plan.reason ?? "answered from the earlier turns."}`] : []), ...plan.subtasks.map((t) => `- **${t.id}** (${t.source}; skills: ${t.skills.join(", ") || "none"}): ${t.question}`)].join("\n"), "orchestrator");
  sink.emit({ type: "plan", plan, loaded: [...new Set(plan.subtasks.flatMap((t) => t.skills))] });
  await done();
  await d.update(reports).set({ plan }).where(eq(reports.id, s.reportId));
  return { plan };
}

/** The planner's edge: one researcher per subtask, in parallel, or straight to the writer. */
function fanOut(s: Run): Send[] | "writer" {
  if (!s.plan || s.plan.mode === "answer" || !s.plan.subtasks.length) return "writer";
  return s.plan.subtasks.map((task) => new Send("researcher", { reportId: s.reportId, task }));
}

/** One research sub-agent. Never throws: a failed knowledge base becomes an honest empty finding. */
async function researcher(s: Run, config: LangGraphRunnableConfig): Promise<Partial<Run>> {
  const task = s.task!;
  const { sink, tracer, vfs, done } = await nodeContext(s.reportId, task.id);
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
}

async function writer(s: Run): Promise<Partial<Run>> {
  const plan = s.plan!;
  const { row, sink, tracer, vfs, done } = await nodeContext(s.reportId, "synthesis");
  vfs.load(await loadFiles(s.reportId));
  // Answer mode: no sub-agents ran, so this turn takes over the earlier turns' sources.
  const earlier = plan.mode === "answer" ? await earlierTurns(row) : undefined;
  if (earlier?.sources.length) sink.emit({ type: "sources", subtask: "earlier", sources: earlier.sources });
  const registry = new Map([...(await loadSources(s.reportId)), ...(earlier?.sources ?? [])].map((x) => [x.id, x] as const));
  const skill = loadSkills().find((x) => x.source === "synthesis");
  const draft = throttle((text: string) => sink.emit({ type: "draft", text: draftForDisplay(text) }));
  const thought = thoughtStream(sink, "synthesis");
  const report = await synthesize(chatModel(), tracer, vfs, row.query, plan, registry, skill, "run", {
    context: earlier ? undefined : await threadContext(row),
    earlier: earlier?.text,
    onText: (t) => draft.push(t),
    onThought: (t) => thought("synthesis", t, false),
  });
  draft.flush();
  thought("synthesis", "", true);
  sink.emit({ type: "report", report, markdown: renderReport(report) });
  await done();
  const d = await db();
  await d.update(reports).set({ report, title: report.title, confidence: report.confidence }).where(eq(reports.id, s.reportId));
  return { report };
}

async function checker(s: Run): Promise<Partial<Run>> {
  const { sink, tracer, vfs, done } = await nodeContext(s.reportId, "evals");
  const registry = new Map((await loadSources(s.reportId)).map((x) => [x.id, x] as const));
  const evals = await tracer.wrap("eval", "evals", "run", async (span) => {
    const list = checks(s.report!, s.plan!, s.findings, registry);
    try {
      const g = await groundedness(chatModel(), tracer, s.report!, registry, span.id);
      vfs.write("/evals/groundedness.md", g.verdicts.map((v) => `- **${v.verdict}** — ${v.text}\n  ${v.reason}`).join("\n"), "judge");
      list.push({ name: g.name, score: g.score, detail: g.detail, method: g.method, items: g.verdicts });
    } catch (err) {
      // A failed judge should not lose the report; the checks still stand.
      list.push({ name: "Groundedness", score: 0, detail: `Not judged: ${(err as Error).message}`, method: "judge" });
    }
    return list;
  });
  sink.emit({ type: "evals", evals });
  await done();
  const d = await db();
  await d.update(reports).set({ evals }).where(eq(reports.id, s.reportId));
  return { evals };
}

/** A failed model call is retried once by the node before the run gives up. */
const retry = { retryPolicy: { maxAttempts: 2 } };

export function buildResearchGraph() {
  return new StateGraph(RunState)
    .addNode("planner", planner, retry)
    .addNode("researcher", researcher)
    .addNode("writer", writer, retry)
    .addNode("checker", checker, retry)
    .addEdge(START, "planner")
    .addConditionalEdges("planner", fanOut, ["researcher", "writer"])
    .addEdge("researcher", "writer")
    .addEdge("writer", "checker")
    .addEdge("checker", END);
}

/**
 * Runs a report's research graph, or resumes it. The report id is the thread
 * id, so a second call after a crash picks up from the last checkpoint.
 */
export async function runResearchGraph(reportId: string, checkpointer: BaseCheckpointSaver = new DrizzleSaver()): Promise<Run> {
  const graph = buildResearchGraph().compile({ checkpointer, name: "research" });
  const config = { configurable: { thread_id: reportId }, recursionLimit: 25 };
  if (!(await checkpointer.getTuple(config))) return graph.invoke({ reportId }, config);
  const saved = await graph.getState(config);
  // Steps left to run: resume from the checkpoint. None: the graph already finished.
  if (saved.next.length) return graph.invoke(null, config);
  return saved.values as Run;
}
