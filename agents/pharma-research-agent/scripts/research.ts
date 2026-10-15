// Run one research query from the command line.
//   npm run research -- "your question"          offline dry run: scripted model, recorded sources, no network
//   npm run research -- --live "your question"   live: Gemini (paid) + PubMed, ClinicalTrials.gov, openFDA, web search
// Saves the run to runs/<id>.json (replay it in the app) and prints the report and evals.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGemini } from "../src/gemini.ts";
import { fixtureToolsets, offlineLLM } from "../src/offline.ts";
import { runResearch } from "../src/run.ts";
import { createToolsets } from "../src/sources/index.ts";
import { renderReport } from "../src/agents/synthesis.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const live = args.includes("--live");
const query = args.filter((a) => !a.startsWith("--")).join(" ").trim() || "What is the evidence on GLP-1 receptor agonists and acute pancreatitis risk?";

if (live && !process.env.GEMINI_API_KEY) {
  console.error("--live needs GEMINI_API_KEY in .env");
  process.exit(1);
}
const llm = live ? createGemini() : offlineLLM();
const toolsets = live ? createToolsets({ llm }) : fixtureToolsets();
console.log(`${live ? "LIVE" : "DRY RUN (offline)"} · ${llm.model}\n${query}\n`);

const result = await runResearch(query, {
  llm,
  toolsets,
  emit: (e) => {
    if (e.type === "plan") for (const t of e.plan.subtasks) console.log(`  plan  ${t.id} [${t.source}] ${t.question}`);
    if (e.type === "span" && e.span.end !== undefined && (e.span.kind === "tool" || e.span.kind === "agent")) console.log(`  ${e.span.kind.padEnd(5)} ${e.span.name} (${e.span.end - e.span.start} ms)${e.span.status === "error" ? ` ERROR ${e.span.attrs.error}` : ""}`);
    if (e.type === "error") console.error(`  error ${e.message}`);
  },
});

mkdirSync(join(ROOT, "runs"), { recursive: true });
const file = join(ROOT, "runs", `${result.id}.json`);
writeFileSync(file, JSON.stringify({ id: result.id, events: result.events }));
if (result.report) console.log(`\n${renderReport(result.report)}\n`);
for (const e of result.evals) console.log(`  ${e.name.padEnd(20)} ${(e.score * 100).toFixed(0).padStart(3)}%  ${e.detail}`);
const usage = result.events.findLast((e) => e.type === "usage");
if (usage?.type === "usage") console.log(`\n  ${usage.calls} model calls, ${usage.toolCalls} tool calls, ${usage.usage.input} in / ${usage.usage.output + usage.usage.thinking} out tokens${usage.usage.cost !== undefined ? `, $${usage.usage.cost.toFixed(4)}` : ""}`);
console.log(`\nSaved ${file}`);
