// The steps of a research run. Each is retried on failure (up to 3 times by
// default), and each writes only keyed rows, so a retry overwrites its own
// output instead of duplicating it.

import { and, asc, eq, lt } from "drizzle-orm";
import { FatalError } from "workflow";
import { db, schema } from "@/lib/db";
import { plan as makePlan } from "@/lib/research/agents/orchestrator";
import { research } from "@/lib/research/agents/researcher";
import { draftForDisplay, renderReport, synthesize } from "@/lib/research/agents/synthesis";
import { checks, groundedness } from "@/lib/research/evals";
import type { LLM } from "@/lib/research/llm";
import { EventSink, addUsage, loadFiles, loadSources } from "@/lib/research/persist";
import { getRuntime } from "@/lib/research/runtime";
import { loadSkills } from "@/lib/research/skills";
import { throttle } from "@/lib/research/throttle";
import { Tracer } from "@/lib/research/trace";
import type { Finding, Plan, Report, Source, Subtask } from "@/lib/research/types";
import { VirtualFS } from "@/lib/research/vfs";

const { reports } = schema;
const MAX_SUBTASKS = 4;

async function getReport(id: string) {
  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, id));
  if (!row) throw new FatalError(`Report ${id} not found`);
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

/** A tracer and file system for one step, writing through to the database. */
function stepContext(reportId: string, t0: number, prefix: string) {
  const sink = new EventSink(reportId);
  const tracer = new Tracer(sink.emit, { t0, prefix });
  const vfs = new VirtualFS((f) => sink.emit({ type: "file", path: f.path, bytes: f.content.length, by: f.by, content: f.content }));
  const done = async () => {
    await sink.flush();
    await addUsage(reportId, { ...tracer.usage, calls: tracer.calls, toolCalls: tracer.toolCalls, priced: tracer.priced });
  };
  return { sink, tracer, vfs, done };
}

/** Counts a call's usage on the tracer, for calls made outside a tracer span helper. */
function counted(llm: LLM, tracer: Tracer): LLM {
  return { model: llm.model, mode: llm.mode, generate: async (req) => { const r = await llm.generate(req); tracer.addUsage(r.usage); return r; } };
}

export async function planStep(reportId: string): Promise<{ plan: Plan; t0: number }> {
  "use step";
  const row = await getReport(reportId);
  const d = await db();
  const startedAt = row.startedAt ?? new Date();
  await d.update(reports).set({ status: "running", startedAt }).where(eq(reports.id, reportId));
  const t0 = startedAt.getTime();
  const { sink, tracer, vfs, done } = stepContext(reportId, t0, "plan");
  const { llm } = getRuntime();
  const skills = loadSkills();

  sink.emit({ type: "run", id: reportId, query: row.query, model: llm.model, mode: llm.mode, at: startedAt.toISOString() });
  sink.emit({ type: "skills", available: skills.map((s) => ({ name: s.name, description: s.description })) });
  sink.emit({ type: "span", span: { id: "run", kind: "run", name: "research run", start: 0, status: "running", attrs: {} } });

  const context = await threadContext(row);
  const thought = thoughtStream(sink, "orchestrator");
  const plan = await tracer.wrap("agent", "orchestrator", "run", async (span) =>
    tracer.wrap("llm", "plan subtasks", span.id, async (s) => {
      const p = await makePlan(counted(llm, tracer), row.query, skills, MAX_SUBTASKS, { context, onThought: (t) => thought("plan", t, false) });
      tracer.close(s, { subtasks: p.subtasks.length, input: tracer.usage.input, output: tracer.usage.output, cost: tracer.usage.cost });
      return p;
    }),
  );
  thought("plan", "", true);
  vfs.write("/plan.md", ["# Plan", "", plan.focus, "", ...(plan.mode === "answer" ? [`No new research: ${plan.reason ?? "answered from the earlier turns."}`] : []), ...plan.subtasks.map((t) => `- **${t.id}** (${t.source}; skills: ${t.skills.join(", ") || "none"}): ${t.question}`)].join("\n"), "orchestrator");
  sink.emit({ type: "plan", plan, loaded: [...new Set(plan.subtasks.flatMap((t) => t.skills))] });
  await done();
  await d.update(reports).set({ plan }).where(eq(reports.id, reportId));
  return { plan, t0 };
}

/** One research sub-agent. Never throws: a failed knowledge base becomes an honest empty finding. */
export async function researchStep(reportId: string, task: Subtask, t0: number): Promise<Finding> {
  "use step";
  const { sink, tracer, vfs, done } = stepContext(reportId, t0, task.id);
  const { llm, toolsets } = getRuntime();
  const registry = new Map<string, Source>();
  let finding: Finding;
  try {
    finding = await research(
      { llm, tracer, vfs, registry, onSources: (subtask, sources) => sink.emit({ type: "sources", subtask, sources }), onThought: thoughtStream(sink, task.id) },
      task,
      toolsets[task.source],
      loadSkills(),
      "run",
    );
  } catch (err) {
    finding = { subtask: task.id, summary: `This sub-agent failed: ${(err as Error).message}`, claims: [], gaps: [task.question] };
  }
  sink.emit({ type: "finding", finding });
  await done();
  return finding;
}

export async function synthesisStep(reportId: string, plan: Plan, t0: number): Promise<Report> {
  "use step";
  const row = await getReport(reportId);
  const { sink, tracer, vfs, done } = stepContext(reportId, t0, "synthesis");
  vfs.load(await loadFiles(reportId));
  // Answer mode: no sub-agents ran, so this turn takes over the earlier turns' sources.
  const earlier = plan.mode === "answer" ? await earlierTurns(row) : undefined;
  if (earlier?.sources.length) sink.emit({ type: "sources", subtask: "earlier", sources: earlier.sources });
  const registry = new Map([...(await loadSources(reportId)), ...(earlier?.sources ?? [])].map((s) => [s.id, s] as const));
  const { llm } = getRuntime();
  const skill = loadSkills().find((s) => s.source === "synthesis");
  const draft = throttle((text: string) => sink.emit({ type: "draft", text: draftForDisplay(text) }));
  const thought = thoughtStream(sink, "synthesis");
  const report = await synthesize(llm, tracer, vfs, row.query, plan, registry, skill, "run", {
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
  await d.update(reports).set({ report, title: report.title, confidence: report.confidence }).where(eq(reports.id, reportId));
  return report;
}
synthesisStep.maxRetries = 2;

export async function evalStep(reportId: string, plan: Plan, findings: Finding[], report: Report, t0: number): Promise<void> {
  "use step";
  const { sink, tracer, vfs, done } = stepContext(reportId, t0, "evals");
  const registry = new Map((await loadSources(reportId)).map((s) => [s.id, s] as const));
  const { llm } = getRuntime();
  const evals = await tracer.wrap("eval", "evals", "run", async (span) => {
    const list = checks(report, plan, findings, registry);
    try {
      const g = await groundedness(llm, tracer, report, registry, span.id);
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
  await d.update(reports).set({ evals }).where(eq(reports.id, reportId));
}

export async function finalizeStep(reportId: string, status: "completed" | "failed", error?: string): Promise<void> {
  "use step";
  const row = await getReport(reportId);
  const t0 = (row.startedAt ?? row.createdAt).getTime();
  const sink = new EventSink(reportId);
  const ms = Date.now() - t0;
  sink.emit({ type: "span", span: { id: "run", kind: "run", name: "research run", start: 0, end: ms, status: status === "completed" ? "ok" : "error", attrs: error ? { error } : {} } });
  if (error) sink.emit({ type: "error", message: error });
  sink.emit({ type: "done", ms });
  await sink.flush();
  const d = await db();
  await d.update(reports).set({ status, error: error ?? null, durationMs: ms, completedAt: new Date() }).where(eq(reports.id, reportId));
}
