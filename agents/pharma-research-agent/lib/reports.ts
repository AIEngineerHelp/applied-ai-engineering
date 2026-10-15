// The data access layer for reports. Every page and API route goes through
// here, so access rules live in one place: a report is visible to the
// workspace that created it, or to anyone holding its share link.
import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, schema } from "./db";
import { loadEvents, loadFiles, loadSources } from "./research/persist";
import type { RunEvent, Source } from "./research/types";

const { reports, reportSources } = schema;
const ids = customAlphabet("0123456789abcdefghijkmnpqrstuvwxyz", 12);
const shareIds = customAlphabet("0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz", 22);

export type ReportRow = typeof reports.$inferSelect;
export type ReportSummary = Pick<ReportRow, "id" | "query" | "title" | "status" | "createdAt" | "confidence">;
export type Access = { workspaceId: string } | { shareId: string };

export const QUERY_MIN = 12;
export const QUERY_MAX = 500;

export async function listReports(workspaceId: string, limit = 100): Promise<ReportSummary[]> {
  const d = await db();
  return d
    .select({ id: reports.id, query: reports.query, title: reports.title, status: reports.status, createdAt: reports.createdAt, confidence: reports.confidence })
    .from(reports)
    .where(eq(reports.workspaceId, workspaceId))
    .orderBy(desc(reports.createdAt))
    .limit(limit);
}

export async function getReport(id: string, access: Access): Promise<ReportRow | null> {
  const d = await db();
  const cond = "workspaceId" in access ? and(eq(reports.id, id), eq(reports.workspaceId, access.workspaceId)) : and(eq(reports.id, id), eq(reports.shareId, access.shareId));
  const [row] = await d.select().from(reports).where(cond);
  return row ?? null;
}

export async function getSharedReport(shareId: string): Promise<ReportRow | null> {
  const d = await db();
  const [row] = await d.select().from(reports).where(eq(reports.shareId, shareId));
  return row ?? null;
}

export async function createReport(workspaceId: string, query: string, model: string): Promise<ReportRow> {
  const d = await db();
  const [row] = await d.insert(reports).values({ id: ids(), workspaceId, query, model }).returning();
  return row;
}

export async function setWorkflowRun(id: string, runId: string) {
  const d = await db();
  await d.update(reports).set({ workflowRunId: runId }).where(eq(reports.id, id));
}

export async function markFailed(id: string, error: string) {
  const d = await db();
  await d.update(reports).set({ status: "failed", error, completedAt: new Date() }).where(eq(reports.id, id));
}

export async function deleteReport(id: string, workspaceId: string): Promise<boolean> {
  const d = await db();
  const rows = await d.delete(reports).where(and(eq(reports.id, id), eq(reports.workspaceId, workspaceId))).returning();
  return rows.length > 0;
}

/** Turns sharing on (returns the share id) or off (returns null). */
export async function setSharing(id: string, workspaceId: string, on: boolean): Promise<string | null> {
  const d = await db();
  const [row] = await d.select({ shareId: reports.shareId }).from(reports).where(and(eq(reports.id, id), eq(reports.workspaceId, workspaceId)));
  if (!row) throw new Error("Not found");
  const shareId = on ? (row.shareId ?? shareIds()) : null;
  await d.update(reports).set({ shareId }).where(eq(reports.id, id));
  return shareId;
}

/** Everything needed to draw a report: the row, its sources and its event stream. */
export async function reportSnapshot(row: ReportRow) {
  const [sources, events] = await Promise.all([loadSources(row.id), loadEvents(row.id)]);
  return {
    report: serializeRow(row),
    sources,
    events: events.map((e) => e.data as RunEvent),
    lastSeq: events.at(-1)?.seq ?? 0,
  };
}

export async function sourcesByIds(reportId: string, idList: string[]): Promise<Source[]> {
  if (!idList.length) return [];
  const d = await db();
  const rows = await d.select().from(reportSources).where(and(eq(reportSources.reportId, reportId), inArray(reportSources.sourceId, idList)));
  return rows.map((r) => ({ id: r.sourceId, kind: r.kind as Source["kind"], title: r.title, url: r.url, text: r.text, meta: r.meta }));
}

export { loadEvents, loadFiles, loadSources };

/** Research runs started across all workspaces since midnight UTC (for the optional daily cap). */
export async function runsToday(): Promise<number> {
  const d = await db();
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const [row] = await d.select({ n: sql<number>`count(*)::int` }).from(reports).where(gte(reports.createdAt, midnight));
  return row?.n ?? 0;
}

export type SerializedReport = ReturnType<typeof serializeRow>;
export function serializeRow(r: ReportRow) {
  return {
    id: r.id,
    query: r.query,
    title: r.title,
    status: r.status,
    plan: r.plan,
    report: r.report,
    evals: r.evals,
    confidence: r.confidence,
    model: r.model,
    error: r.error,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    modelCalls: r.modelCalls,
    toolCalls: r.toolCalls,
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
    durationMs: r.durationMs,
    shared: !!r.shareId,
    shareId: r.shareId,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}
