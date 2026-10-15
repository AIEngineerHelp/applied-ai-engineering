// The Postgres RunStore: how the agent's runs are saved in this app. A run is
// a row in `reports`; its events, sources and files have tables of their own.

import { and, asc, eq, lt } from "drizzle-orm";
import type { PriorTurn, RunInfo, RunStore } from "../../agent/store.ts";
import { db, schema } from "../db/index.ts";
import { EventSink, addUsage, loadFiles, loadSources } from "./events.ts";

const { reports } = schema;

async function row(runId: string) {
  const d = await db();
  const [r] = await d.select().from(reports).where(eq(reports.id, runId));
  if (!r) throw new Error(`Report ${runId} not found`);
  return r;
}

const spent = (r: Awaited<ReturnType<typeof row>>) => ({ cost: r.costUsd === null ? (r.modelCalls ? null : 0) : Number(r.costUsd), calls: r.modelCalls });
const info = (r: Awaited<ReturnType<typeof row>>): RunInfo => ({ id: r.id, query: r.query, startedAt: r.startedAt ?? r.createdAt, spent: spent(r) });

export const postgresRunStore: RunStore = {
  async start(runId) {
    const r = await row(runId);
    const startedAt = r.startedAt ?? new Date();
    const d = await db();
    await d.update(reports).set({ status: "running", startedAt }).where(eq(reports.id, runId));
    return { id: r.id, query: r.query, startedAt, spent: spent(r) };
  },

  async get(runId) {
    return info(await row(runId));
  },

  events(runId) {
    return new EventSink(runId);
  },

  addUsage(runId, usage) {
    return addUsage(runId, usage);
  },

  async save(runId, { plan, report, evals }) {
    const d = await db();
    await d
      .update(reports)
      .set({ ...(plan ? { plan } : {}), ...(report ? { report, title: report.title, confidence: report.confidence } : {}), ...(evals ? { evals } : {}) })
      .where(eq(reports.id, runId));
  },

  files: loadFiles,
  sources: loadSources,

  async earlierTurns(runId, opts = {}) {
    const r = await row(runId);
    if (r.position === 0) return [];
    const d = await db();
    const prior = await d
      .select({ id: reports.id, query: reports.query, report: reports.report })
      .from(reports)
      .where(and(eq(reports.threadId, r.threadId), lt(reports.position, r.position), eq(reports.status, "completed")))
      .orderBy(asc(reports.position));
    const turns: PriorTurn[] = [];
    for (const p of prior) turns.push({ query: p.query, report: p.report ?? undefined, sources: opts.withSources ? await loadSources(p.id) : [] });
    return turns;
  },
};
