// The database: reports and everything a research run produces.
// A report belongs to an anonymous workspace (a browser cookie) until
// accounts exist; `workspaceId` is the column a user id would replace.

import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, numeric, pgSequence, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { Plan, Report, EvalResult } from "../research/types";

export const eventSeq = pgSequence("report_event_seq");

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** The conversation this report is a turn of; the first turn's id. */
    threadId: text("thread_id").notNull(),
    /** Turn number within the thread, from 0. */
    position: integer("position").notNull().default(0),
    query: text("query").notNull(),
    title: text("title"),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled"] }).notNull().default("queued"),
    plan: jsonb("plan").$type<Plan>(),
    report: jsonb("report").$type<Report>(),
    evals: jsonb("evals").$type<EvalResult[]>(),
    confidence: text("confidence"),
    model: text("model").notNull(),
    error: text("error"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    modelCalls: integer("model_calls").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
    durationMs: integer("duration_ms"),
    shareId: text("share_id"),
    workflowRunId: text("workflow_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("reports_workspace_idx").on(t.workspaceId, t.createdAt), index("reports_thread_idx").on(t.threadId, t.position), uniqueIndex("reports_share_idx").on(t.shareId)],
);

/**
 * The run's event stream: plan, spans, files, sources, findings, evals.
 * Keyed so that a retried step overwrites its own events instead of
 * duplicating them; `seq` is reassigned on every write so clients that
 * follow the stream see updates as well as inserts.
 */
export const reportEvents = pgTable(
  "report_events",
  {
    reportId: text("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull().default(sql`nextval('report_event_seq')`),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.key] }), index("report_events_seq_idx").on(t.reportId, t.seq)],
);

/** Every document a sub-agent retrieved, citable by id. */
export const reportSources = pgTable(
  "report_sources",
  {
    reportId: text("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    text: text("text").notNull(),
    meta: jsonb("meta").notNull().$type<Record<string, string | number | boolean | undefined>>(),
    subtask: text("subtask").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.sourceId] })],
);

/** The virtual file system: what agents wrote, by path. */
export const reportFiles = pgTable(
  "report_files",
  {
    reportId: text("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    writtenBy: text("written_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.path] })],
);
