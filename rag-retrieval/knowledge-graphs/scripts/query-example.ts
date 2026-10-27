// Records one "Ask your own question" run for the "Who writes the query?" section:
// the question goes through the same textToCypher and graphAnswer as the recorded
// runs, and the result (query, rows, answer, tokens, cost) is written to
// results/query-example.json. A dry run unless --live (paid: 2 or 3 Gemini calls; needs Neo4j).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "../src/load-corpus.ts";
import type { Graph } from "../src/graph.ts";
import { graphAnswer, textToCypher } from "../src/pipeline/ask.ts";
import { closeDb } from "../src/pipeline/neo4j.ts";

const QUESTION = "Who manages the Pellham Labs account?";
if (!process.argv.includes("--live")) {
  console.log(`Dry run: would send "${QUESTION}" through text-to-Cypher and the answer step (2 or 3 Gemini calls, under $0.01). Add --live.`);
  process.exit(0);
}
process.loadEnvFile(join(ROOT, ".env"));
const ledger = join(ROOT, "runs", "ledger.jsonl");
const before = existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0;
const graph = readJson<Graph>("results/graph.json");
const attempts = await textToCypher(QUESTION, graph, "query-example");
const answer = await graphAnswer("query-example", QUESTION, attempts[attempts.length - 1]);
await closeDb();
const calls = readFileSync(ledger, "utf8").split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l) as { step: string; input: number; output: number; thought: number; cost: number; model: string });
const out = {
  question: QUESTION,
  at: new Date().toISOString(),
  model: calls[0]?.model,
  attempts: attempts.map((a) => ({ cypher: a.cypher, explanation: a.explanation, ok: a.run.ok, error: a.run.error, rows: a.run.rows, ms: a.run.ms })),
  answer,
  calls: calls.map((c) => ({ step: c.step, input: c.input, output: c.output, thought: c.thought, cost: c.cost })),
  cost: Math.round(calls.reduce((s, c) => s + c.cost, 0) * 1e6) / 1e6,
};
writeFileSync(join(ROOT, "results", "query-example.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));
