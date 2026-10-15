// The durable pipeline end to end, against an in-memory Postgres (PGlite) and
// the offline model. Without the Workflow compiler, "use step" is a no-op, so
// the steps run as plain functions — the same code the workflow runs.
process.env.PGLITE_DIR = "memory";
process.env.RESEARCH_OFFLINE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db/index.ts";
import { evalStep, finalizeStep, planStep, researchStep, synthesisStep } from "../workflows/steps.ts";

const { reports, reportEvents, reportSources, reportFiles } = schema;

async function newReport(id: string, query = "What is the evidence on GLP-1 receptor agonists and pancreatitis?") {
  const d = await db();
  await d.insert(reports).values({ id, workspaceId: "a".repeat(32), query, model: "offline (scripted)" });
}

test("a run goes queued → completed, and every stage is persisted", async () => {
  await newReport("t1");
  const { plan, t0 } = await planStep("t1");
  const findings = await Promise.all(plan.subtasks.map((t) => researchStep("t1", t, t0)));
  const report = await synthesisStep("t1", plan, t0);
  await evalStep("t1", plan, findings, report, t0);
  await finalizeStep("t1", "completed");

  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, "t1"));
  assert.equal(row.status, "completed");
  assert.ok(row.report && row.evals && row.plan);
  assert.ok(row.modelCalls >= 5 && row.toolCalls >= 3 && row.tokensIn > 0);
  assert.ok(row.durationMs !== null && row.completedAt);

  const events = await d.select().from(reportEvents).where(eq(reportEvents.reportId, "t1"));
  const types = new Set(events.map((e) => e.type));
  for (const t of ["run", "skills", "plan", "span", "file", "sources", "finding", "report", "evals", "done"]) assert.ok(types.has(t), t);
  // Source events store ids, not copies of the documents.
  const src = events.find((e) => e.type === "sources")!.data as { ids?: string[]; sources?: unknown };
  assert.ok(Array.isArray(src.ids) && !src.sources);

  const sources = await d.select().from(reportSources).where(eq(reportSources.reportId, "t1"));
  const files = await d.select().from(reportFiles).where(eq(reportFiles.reportId, "t1"));
  assert.ok(sources.length >= 10);
  for (const p of ["/plan.md", "/findings/agent-1.md", "/sources/CATALOGUE.md", "/report.md", "/evals/groundedness.md"]) assert.ok(files.some((f) => f.path === p), p);
});

test("a retried step overwrites its own output instead of duplicating it", async () => {
  await newReport("t2");
  const { plan, t0 } = await planStep("t2");
  const task = plan.subtasks[0];
  await researchStep("t2", task, t0);
  const d = await db();
  const count = async () => ({
    events: (await d.select().from(reportEvents).where(eq(reportEvents.reportId, "t2"))).length,
    sources: (await d.select().from(reportSources).where(eq(reportSources.reportId, "t2"))).length,
    files: (await d.select().from(reportFiles).where(eq(reportFiles.reportId, "t2"))).length,
  });
  const before = await count();
  const seqBefore = Math.max(...(await d.select().from(reportEvents).where(eq(reportEvents.reportId, "t2"))).map((e) => e.seq));
  await researchStep("t2", task, t0); // as if the step were retried
  assert.deepEqual(await count(), before);
  // Rewritten events get new sequence numbers, so live clients see the update.
  const seqAfter = Math.max(...(await d.select().from(reportEvents).where(eq(reportEvents.reportId, "t2"))).map((e) => e.seq));
  assert.ok(seqAfter > seqBefore);
});

test("a failed run is marked failed with its reason", async () => {
  await newReport("t3");
  await finalizeStep("t3", "failed", "The model provider was unavailable.");
  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, "t3"));
  assert.equal(row.status, "failed");
  assert.equal(row.error, "The model provider was unavailable.");
});
