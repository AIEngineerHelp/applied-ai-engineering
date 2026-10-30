// Offline: run every question's hand-written gold Cypher on Neo4j and score the rows.
import { join } from "node:path";
import { ROOT, readJson } from "../src/load-corpus.ts";
import { closeDb, runReadOnly } from "../src/pipeline/neo4j.ts";
import { scoreText, type Question } from "../src/score.ts";
process.loadEnvFile(join(ROOT, ".env"));
const qs = readJson<Question[]>("data/questions.json");
for (const q of qs) {
  const r = await runReadOnly(q.cypher);
  const s = scoreText(q, JSON.stringify(r.rows));
  console.log(`${q.id}: ${r.ok ? `${r.rows.length} rows` : `ERROR ${r.error}`} → ${s.found}/${s.of}${s.wrong.length ? ` wrong: ${s.wrong.join("; ")}` : ""}`);
  if (s.found < s.of || s.wrong.length) console.log("   ", JSON.stringify(r.rows).slice(0, 400));
}
await closeDb();
