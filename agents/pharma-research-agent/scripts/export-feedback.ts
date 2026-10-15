// Exports readers' feedback as an eval dataset: one JSON line per rated answer,
// with the question, the answer, its evals and guardrail decisions, the rating
// and the comment. Thumbs-down answers are the cases worth turning into tests.
//   npm run feedback:export                 → runs/feedback.jsonl (Git-ignored)
//   npm run feedback:export -- --down-only  → only answers rated thumbs down
// Reads the database in DATABASE_URL, or the local PGlite one (stop `npm run dev` first; PGlite allows one process).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const downOnly = process.argv.includes("--down-only");
  const { asc, eq } = await import("drizzle-orm");
  const { db, schema } = await import("../lib/db/index.ts");
  const { renderReport } = await import("../agent/report-format.ts");
  const { reports, reportFeedback, reportEvents } = schema;
  const d = await db();
  const rows = await d
    .select({ f: reportFeedback, r: reports })
    .from(reportFeedback)
    .innerJoin(reports, eq(reports.id, reportFeedback.reportId))
    .orderBy(asc(reportFeedback.at));
  const lines: string[] = [];
  for (const { f, r } of rows) {
    if (downOnly && f.rating !== "down") continue;
    const guards = await d.select({ data: reportEvents.data }).from(reportEvents).where(eq(reportEvents.reportId, r.id));
    lines.push(
      JSON.stringify({
        report_id: r.id,
        rated_at: f.at.toISOString(),
        rating: f.rating,
        comment: f.comment,
        query: r.query,
        plan_focus: r.plan?.focus,
        answer: r.report ? renderReport(r.report) : null,
        evals: r.evals?.map((e) => ({ name: e.name, score: e.score })) ?? [],
        guardrails: guards.map((g) => g.data as { type: string; decision?: unknown }).filter((g) => g.type === "guardrail").map((g) => g.decision),
        model: r.model,
      }),
    );
  }
  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const file = join(ROOT, "runs", "feedback.jsonl");
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
  console.log(`${lines.length} rated answer${lines.length === 1 ? "" : "s"} → ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
