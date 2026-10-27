// Offline: print the measured tables from results/answers.json (the README's tables come from here).
import { readJson } from "../src/load-corpus.ts";
import { METHODS, summarize } from "../src/summary.ts";
import type { Question } from "../src/score.ts";
import type { QuestionResult } from "../src/pipeline/ask.ts";
const qs = readJson<Question[]>("data/questions.json");
const a = readJson<{ results: QuestionResult[] }>("results/answers.json");
const s = summarize(qs, a.results);
const cell = (c: { found: number; of: number; wrong: number; countRight: boolean | null; judged: boolean } | null) => (c ? `${c.found}/${c.of}${c.wrong ? " ⚠" + c.wrong : ""}${c.countRight ? " (count ✓)" : ""}${c.judged ? " (judge)" : ""}` : "–");
console.log(`| Question | Kind | ${METHODS.join(" | ")} |`);
for (const r of s.rows) console.log(`| ${r.id} | ${r.kind} | ${METHODS.map((m) => cell(r.cells[m])).join(" | ")} |`);
console.log("\nTotals:");
for (const t of s.totals) console.log(`  ${t.name}: facts ${t.found}/${t.of}, complete ${t.complete}/${t.questions}, wrong ${t.wrong}; answers ${t.answerFound ?? "-"}/${t.answerOf ?? "-"} wrong ${t.answerWrong ?? "-"}`);
