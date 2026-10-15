// The data access layer for reports. Every page and API route goes through
// here, so access rules live in one place: a report is visible to the
// workspace that created it, or to anyone holding its share link.
import "server-only";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, schema } from "./db";
import { loadEvents, loadFiles, loadSources } from "./research/persist";
import type { RunEvent, Source } from "./research/types";

const { reports, reportSources } = schema;
const ids = customAlphabet("0123456789abcdefghijkmnpqrstuvwxyz", 12);
const shareIds = customAlphabet("0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz", 22);

export type ReportRow = typeof reports.$inferSelect;
/** One conversation in the sidebar: its first question, latest status and turn count. */
export type ReportSummary = Pick<ReportRow, "id" | "query" | "title" | "status" | "createdAt" | "confidence"> & { turns: number };
export type Access = { workspaceId: string } | { shareId: string };

export const QUERY_MIN = 12;
export const QUERY_MAX = 500;

export async function listReports(workspaceId: string, limit = 100): Promise<ReportSummary[]> {
  const d = await db();
  const rows = await d
    .select({ id: reports.id, threadId: reports.threadId, position: reports.position, query: reports.query, title: reports.title, status: reports.status, createdAt: reports.createdAt, confidence: reports.confidence })
    .from(reports)
    .where(eq(reports.workspaceId, workspaceId))
    .orderBy(desc(reports.createdAt))
    .limit(limit * 4);
  // One entry per conversation: titled by its first turn, dated and statused by its latest.
  const threads = new Map<string, ReportSummary>();
  for (const r of rows) {
    const t = threads.get(r.threadId);
    if (!t) threads.set(r.threadId, { id: r.threadId, query: r.query, title: r.title, status: r.status, createdAt: r.createdAt, confidence: r.confidence, turns: 1 });
    else {
      t.turns += 1;
      if (r.position === 0) Object.assign(t, { query: r.query, title: r.title ?? t.title });
    }
  }
  return [...threads.values()].slice(0, limit);
}

/** Resolves a share id to the thread it opens (share ids live on a thread's first turn). */
async function sharedThread(shareId: string): Promise<string | null> {
  const d = await db();
  const [row] = await d.select({ threadId: reports.threadId }).from(reports).where(eq(reports.shareId, shareId));
  return row?.threadId ?? null;
}

export async function getReport(id: string, access: Access): Promise<ReportRow | null> {
  const d = await db();
  if ("workspaceId" in access) {
    const [row] = await d.select().from(reports).where(and(eq(reports.id, id), eq(reports.workspaceId, access.workspaceId)));
    return row ?? null;
  }
  const threadId = await sharedThread(access.shareId);
  if (!threadId) return null;
  const [row] = await d.select().from(reports).where(and(eq(reports.id, id), eq(reports.threadId, threadId)));
  return row ?? null;
}

/** Every turn of a conversation, in order, if the caller may see it. */
export async function getThread(threadId: string, access: Access): Promise<ReportRow[]> {
  const d = await db();
  if ("workspaceId" in access) return d.select().from(reports).where(and(eq(reports.threadId, threadId), eq(reports.workspaceId, access.workspaceId))).orderBy(asc(reports.position));
  const shared = await sharedThread(access.shareId);
  if (shared !== threadId) return [];
  return d.select().from(reports).where(eq(reports.threadId, threadId)).orderBy(asc(reports.position));
}

export async function getSharedThread(shareId: string): Promise<ReportRow[]> {
  const threadId = await sharedThread(shareId);
  return threadId ? getThread(threadId, { shareId }) : [];
}

/** Starts a conversation, or adds a follow-up turn to one the workspace owns. */
export async function createReport(workspaceId: string, query: string, model: string, threadId?: string): Promise<ReportRow> {
  const d = await db();
  const id = ids();
  let position = 0;
  if (threadId) {
    const turns = await d.select({ position: reports.position }).from(reports).where(and(eq(reports.threadId, threadId), eq(reports.workspaceId, workspaceId)));
    if (!turns.length) throw new Error("Conversation not found");
    position = Math.max(...turns.map((t) => t.position)) + 1;
  }
  const [row] = await d.insert(reports).values({ id, workspaceId, query, model, threadId: threadId ?? id, position }).returning();
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

/** Deletes a whole conversation (all its turns). */
export async function deleteThread(threadId: string, workspaceId: string): Promise<boolean> {
  const d = await db();
  const rows = await d.delete(reports).where(and(eq(reports.threadId, threadId), eq(reports.workspaceId, workspaceId))).returning();
  return rows.length > 0;
}

/** Turns a conversation's public link on (returns the share id) or off (returns null). */
export async function setSharing(threadId: string, workspaceId: string, on: boolean): Promise<string | null> {
  const d = await db();
  const id = threadId; // share ids live on the first turn, whose id is the thread id
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
    threadId: r.threadId,
    position: r.position,
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
