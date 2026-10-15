// Persistence for research runs: every event an agent emits is written to
// Postgres, in order, without blocking the agent. Each event has a stable key,
// so a step that is retried overwrites its own events instead of adding more.

import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { RunEvent, Source } from "./types";
import type { VfsFile } from "./vfs";

const { reports, reportEvents, reportSources, reportFiles } = schema;

/** The key an event is stored under; same key → same row. */
export function eventKey(e: RunEvent): string {
  switch (e.type) {
    case "span":
      return `span:${e.span.id}`;
    case "file":
      return `file:${e.path}`;
    case "sources":
      return `sources:${e.subtask}`;
    case "finding":
      return `finding:${e.finding.subtask}`;
    default:
      return e.type;
  }
}

/** Collects events from synchronous emitters and writes them in order. */
export class EventSink {
  private chain: Promise<void> = Promise.resolve();
  private failed: unknown;

  constructor(private reportId: string) {}

  emit = (e: RunEvent) => {
    this.chain = this.chain.then(() => this.write(e)).catch((err) => {
      this.failed ??= err;
    });
  };

  /** Waits for every write so far; throws if any failed, so the step retries. */
  async flush(): Promise<void> {
    await this.chain;
    if (this.failed) throw this.failed;
  }

  private async write(e: RunEvent) {
    const d = await db();
    // File contents live in their own table; the event only says a file was written.
    if (e.type === "file") {
      await d
        .insert(reportFiles)
        .values({ reportId: this.reportId, path: e.path, content: e.content, writtenBy: e.by })
        .onConflictDoUpdate({ target: [reportFiles.reportId, reportFiles.path], set: { content: e.content, writtenBy: e.by, at: sql`now()` } });
      return this.event(e.type, eventKey(e), { type: "file", path: e.path, bytes: e.bytes, by: e.by });
    }
    if (e.type === "sources") {
      await upsertSources(this.reportId, e.subtask, e.sources);
      return this.event(e.type, eventKey(e), { type: "sources", subtask: e.subtask, ids: e.sources.map((s) => s.id) });
    }
    if (e.type === "usage") return; // totals are kept on the report row
    return this.event(e.type, eventKey(e), e);
  }

  private async event(type: string, key: string, data: unknown) {
    const d = await db();
    await d
      .insert(reportEvents)
      .values({ reportId: this.reportId, key, type, data })
      .onConflictDoUpdate({
        target: [reportEvents.reportId, reportEvents.key],
        set: { data, seq: sql`nextval('report_event_seq')`, at: sql`now()` },
      });
  }
}

export async function upsertSources(reportId: string, subtask: string, sources: Source[]) {
  if (!sources.length) return;
  const d = await db();
  await d
    .insert(reportSources)
    .values(sources.map((s, i) => ({ reportId, sourceId: s.id, kind: s.kind, title: s.title, url: s.url, text: s.text, meta: s.meta, subtask, position: i })))
    .onConflictDoNothing();
}

export async function loadSources(reportId: string): Promise<Source[]> {
  const d = await db();
  const rows = await d.select().from(reportSources).where(eq(reportSources.reportId, reportId)).orderBy(asc(reportSources.subtask), asc(reportSources.position));
  return rows.map((r) => ({ id: r.sourceId, kind: r.kind as Source["kind"], title: r.title, url: r.url, text: r.text, meta: r.meta }));
}

export async function loadFiles(reportId: string): Promise<VfsFile[]> {
  const d = await db();
  const rows = await d.select().from(reportFiles).where(eq(reportFiles.reportId, reportId)).orderBy(asc(reportFiles.path));
  return rows.map((r) => ({ path: r.path, content: r.content, by: r.writtenBy, at: r.at.getTime() }));
}

export async function loadEvents(reportId: string, afterSeq = 0) {
  const d = await db();
  return d
    .select({ seq: reportEvents.seq, data: reportEvents.data })
    .from(reportEvents)
    .where(and(eq(reportEvents.reportId, reportId), gt(reportEvents.seq, afterSeq)))
    .orderBy(asc(reportEvents.seq));
}

/** Adds one step's usage to the report's running totals. */
export async function addUsage(reportId: string, u: { input: number; output: number; thinking: number; cost?: number; calls: number; toolCalls: number; priced: boolean }) {
  const d = await db();
  await d
    .update(reports)
    .set({
      tokensIn: sql`${reports.tokensIn} + ${u.input}`,
      tokensOut: sql`${reports.tokensOut} + ${u.output + u.thinking}`,
      modelCalls: sql`${reports.modelCalls} + ${u.calls}`,
      toolCalls: sql`${reports.toolCalls} + ${u.toolCalls}`,
      // Cost stays null (unknown) as soon as one call is unpriced.
      ...(u.priced && u.cost !== undefined ? { costUsd: sql`coalesce(${reports.costUsd}, 0) + ${u.cost}` } : {}),
    })
    .where(eq(reports.id, reportId));
}
