// Run one research query from the command line, through the same LangGraph
// graph the app runs, against an in-memory database.
//   npm run research -- "your question"          offline dry run: scripted model, recorded sources, no network
//   npm run research -- --live "your question"   live: Gemini (paid) + PubMed, ClinicalTrials.gov, openFDA, web search
// Prints the plan, each agent as it finishes, the report and the evals, and
// saves the run's events to runs/<id>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const live = args.includes("--live");
const query = args.filter((a) => !a.startsWith("--")).join(" ").trim() || "What is the evidence on GLP-1 receptor agonists and acute pancreatitis risk?";

if (live && !process.env.GEMINI_API_KEY) {
  console.error("--live needs GEMINI_API_KEY in .env");
  process.exit(1);
}
async function main() {
  // Set before the app's modules read them.
  process.env.PGLITE_DIR = "memory";
  delete process.env.DATABASE_URL;
  if (!live) process.env.RESEARCH_OFFLINE = "1";

  const { asc, eq } = await import("drizzle-orm");
  const { db, schema } = await import("../lib/db/index.ts");
  const { runResearchGraph } = await import("../agent/graph.ts");
  const { renderReport } = await import("../agent/report-format.ts");
  const { modelName } = await import("../agent/config.ts");
  const { DrizzleSaver } = await import("../lib/storage/checkpointer.ts");
  const { postgresRunStore } = await import("../lib/storage/run-store.ts");
  const { reports, reportEvents } = schema;

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z") + "-" + Math.random().toString(36).slice(2, 6);
  const d = await db();
  await d.insert(reports).values({ id, threadId: id, workspaceId: "cli", query, model: modelName() });
  console.log(`${live ? "LIVE" : "DRY RUN (offline)"} · ${modelName()}\n${query}\n`);

  const state = await runResearchGraph(id, { store: postgresRunStore, checkpointer: new DrizzleSaver() });
  for (const t of state.plan?.subtasks ?? []) console.log(`  plan  ${t.id} [${t.source}] ${t.question}`);
  for (const f of state.findings) console.log(`  found ${f.subtask}: ${f.claims.length} claims`);
  if (state.report) console.log(`\n${renderReport(state.report)}\n`);
  for (const e of state.evals ?? []) console.log(`  ${e.name.padEnd(20)} ${(e.score * 100).toFixed(0).padStart(3)}%  ${e.detail}`);
  const [row] = await d.select().from(reports).where(eq(reports.id, id));
  console.log(`\n  ${row.modelCalls} model calls, ${row.toolCalls} tool calls, ${row.tokensIn} in / ${row.tokensOut} out tokens${row.costUsd !== null ? `, $${Number(row.costUsd).toFixed(4)}` : ""}`);

  const events = await d.select({ data: reportEvents.data }).from(reportEvents).where(eq(reportEvents.reportId, id)).orderBy(asc(reportEvents.seq));
  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const file = join(ROOT, "runs", `${id}.json`);
  writeFileSync(file, JSON.stringify({ id, query, events: events.map((e) => e.data) }));
  console.log(`\nSaved ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
