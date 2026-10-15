// The LangGraph research graph end to end, against an in-memory Postgres
// (PGlite) and the scripted model: a full run, a follow-up answered from the
// earlier turn, and a run that crashes and resumes from its checkpoint.
process.env.PGLITE_DIR = "memory";
process.env.RESEARCH_OFFLINE = "1";

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db/index.ts";
import { runResearchGraph } from "../lib/research/graph.ts";
import { ScriptedChatModel, type Agent } from "../lib/research/offline.ts";
import { finalizeStep } from "../workflows/steps.ts";

const { reports, reportEvents, reportSources, reportFiles, graphCheckpoints } = schema;

afterEach(() => {
  ScriptedChatModel.script = undefined;
});

async function newReport(id: string, query = "What is the evidence on GLP-1 receptor agonists and pancreatitis?", thread?: { id: string; position: number }) {
  const d = await db();
  await d.insert(reports).values({ id, threadId: thread?.id ?? id, position: thread?.position ?? 0, workspaceId: "a".repeat(32), query, model: "offline (scripted)" });
}

/** Counts model calls by agent, without changing the script. */
function countCalls() {
  const calls: Record<string, number> = {};
  ScriptedChatModel.script = (agent: Agent) => {
    calls[agent] = (calls[agent] ?? 0) + 1;
    return undefined;
  };
  return calls;
}

test("a run goes through planner, parallel researchers, writer and checker, and every stage is persisted", async () => {
  await newReport("t1");
  const state = await runResearchGraph("t1");
  await finalizeStep("t1", "completed");
  assert.equal(state.findings.length, 3);
  assert.ok(state.report && state.evals);

  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, "t1"));
  assert.equal(row.status, "completed");
  assert.ok(row.report && row.evals && row.plan);
  assert.ok(row.modelCalls >= 5 && row.toolCalls >= 3 && row.tokensIn > 0);

  const events = await d.select().from(reportEvents).where(eq(reportEvents.reportId, "t1"));
  const types = new Set(events.map((e) => e.type));
  for (const t of ["run", "skills", "plan", "span", "file", "sources", "finding", "report", "evals", "done"]) assert.ok(types.has(t), t);
  // Source events store ids, not copies of the documents.
  const src = events.find((e) => e.type === "sources")!.data as { ids?: string[]; sources?: unknown };
  assert.ok(Array.isArray(src.ids) && !src.sources);
  // The researchers ran in parallel: their agent spans overlap in time.
  const spans = events.filter((e) => e.type === "span").map((e) => (e.data as { span: { name: string; start: number; end?: number } }).span);
  const a = spans.find((s) => s.name.startsWith("agent-1 ·") && s.end !== undefined)!;
  const b = spans.find((s) => s.name.startsWith("agent-2 ·") && s.end !== undefined)!;
  assert.ok(a.start < b.end! && b.start < a.end!, "agent-1 and agent-2 overlap");

  const sources = await d.select().from(reportSources).where(eq(reportSources.reportId, "t1"));
  const files = await d.select().from(reportFiles).where(eq(reportFiles.reportId, "t1"));
  assert.ok(sources.length >= 10);
  for (const p of ["/plan.md", "/findings/agent-1.md", "/sources/CATALOGUE.md", "/report.md", "/evals/groundedness.md"]) assert.ok(files.some((f) => f.path === p), p);
  // LangGraph checkpointed the run in the same database.
  const checkpoints = await d.select().from(graphCheckpoints).where(eq(graphCheckpoints.threadId, "t1"));
  assert.ok(checkpoints.length >= 4);
});

test("a crashed run resumes from its checkpoint: the planner and finished researchers do not run again", async () => {
  await newReport("t2");
  const calls: Record<string, number> = {};
  let failWriter = true;
  ScriptedChatModel.script = (agent: Agent) => {
    calls[agent] = (calls[agent] ?? 0) + 1;
    // The writer fails on both of its attempts in the first run, like a crash mid-run.
    if (agent === "synthesis" && failWriter) throw new Error("model provider unavailable");
    return undefined;
  };
  await assert.rejects(runResearchGraph("t2"), /model provider unavailable/);
  assert.equal(calls.orchestrator, 1);
  const researcherCalls = calls.researcher;
  assert.equal(calls.synthesis, 2, "the writer node retried once before the run failed");

  failWriter = false;
  const state = await runResearchGraph("t2");
  assert.ok(state.report && state.evals);
  assert.equal(calls.orchestrator, 1, "the planner did not run again");
  assert.equal(calls.researcher, researcherCalls, "the researchers did not run again");
  assert.equal(calls.synthesis, 3);
  assert.equal(state.findings.length, 3, "findings were not duplicated");
});

test("running a finished graph again returns its result without doing the work twice", async () => {
  await newReport("t3");
  await runResearchGraph("t3");
  const calls = countCalls();
  const state = await runResearchGraph("t3");
  assert.ok(state.report);
  assert.deepEqual(calls, {});
});

test("a follow-up asking for a rewrite goes straight from planner to writer, with no new searches", async () => {
  await newReport("f1");
  await runResearchGraph("f1");
  await finalizeStep("f1", "completed");
  await newReport("f2", "Simplify the answer", { id: "f1", position: 1 });
  const calls = countCalls();
  const state = await runResearchGraph("f2");
  await finalizeStep("f2", "completed");
  assert.equal(state.plan?.mode, "answer");
  assert.equal(state.findings.length, 0);
  assert.equal(calls.researcher, undefined);

  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, "f2"));
  assert.equal(row.toolCalls, 0);
  // The earlier turn's sources carry over, so every citation still resolves.
  const own = new Set((await d.select().from(reportSources).where(eq(reportSources.reportId, "f2"))).map((s) => s.sourceId));
  const earlier = new Set((await d.select().from(reportSources).where(eq(reportSources.reportId, "f1"))).map((s) => s.sourceId));
  assert.deepEqual(own, earlier);
  assert.equal(row.evals!.find((e) => e.name === "Citation validity")!.score, 1);
  assert.ok(!row.evals!.some((e) => e.name === "Subtasks answered"));
  const files = await d.select().from(reportFiles).where(eq(reportFiles.reportId, "f2"));
  assert.ok(files.some((f) => f.path === "/context/earlier.md" && f.content.includes("Question: What is the evidence")));
});

test("a failed run is marked failed with its reason", async () => {
  await newReport("t4");
  await finalizeStep("t4", "failed", "The model provider was unavailable.");
  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, "t4"));
  assert.equal(row.status, "failed");
  assert.equal(row.error, "The model provider was unavailable.");
});
