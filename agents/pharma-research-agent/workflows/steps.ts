// The workflow's two steps. `graphStep` runs the LangGraph research graph
// (agent/graph.ts) with this app's Postgres storage; a
// retry resumes it from its last checkpoint in Postgres, so finished nodes and
// finished parallel researchers are not run again. `finalizeStep` records how
// the run ended.

import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { db, schema } from "@/lib/db";
import { runResearchGraph } from "@/agent/graph";
import { isLimit } from "@/agent/limits";
import { DrizzleSaver } from "@/lib/storage/checkpointer";
import { EventSink } from "@/lib/storage/events";
import { postgresRunStore } from "@/lib/storage/run-store";

const { reports } = schema;

export async function graphStep(reportId: string): Promise<void> {
  "use step";
  try {
    await runResearchGraph(reportId, { store: postgresRunStore, checkpointer: new DrizzleSaver() });
  } catch (err) {
    // A run limit (budget or deadline) is final: retrying would only hit it again.
    if (isLimit(err)) throw new FatalError(err.message);
    throw err;
  }
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
