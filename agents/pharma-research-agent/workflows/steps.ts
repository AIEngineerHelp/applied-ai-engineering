// The workflow's two steps. `graphStep` runs the LangGraph research graph; a
// retry resumes it from its last checkpoint in Postgres, so finished nodes and
// finished parallel researchers are not run again. `finalizeStep` records how
// the run ended.

import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { db, schema } from "@/lib/db";
import { runResearchGraph } from "@/lib/research/graph";
import { EventSink } from "@/lib/research/persist";

const { reports } = schema;

export async function graphStep(reportId: string): Promise<void> {
  "use step";
  await runResearchGraph(reportId);
}
graphStep.maxRetries = 2;

export async function finalizeStep(reportId: string, status: "completed" | "failed", error?: string): Promise<void> {
  "use step";
  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.id, reportId));
  if (!row) throw new FatalError(`Report ${reportId} not found`);
  const t0 = (row.startedAt ?? row.createdAt).getTime();
  const sink = new EventSink(reportId);
  const ms = Date.now() - t0;
  sink.emit({ type: "span", span: { id: "run", kind: "run", name: "research run", start: 0, end: ms, status: status === "completed" ? "ok" : "error", attrs: error ? { error } : {} } });
  if (error) sink.emit({ type: "error", message: error });
  sink.emit({ type: "done", ms });
  await sink.flush();
  await d.update(reports).set({ status, error: error ?? null, durationMs: ms, completedAt: new Date() }).where(eq(reports.id, reportId));
}
