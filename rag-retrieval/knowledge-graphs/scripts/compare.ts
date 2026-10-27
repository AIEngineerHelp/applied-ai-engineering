// Print the computed comparison for every sample question: the table in the
// README is copied from this output. `--k 5` changes the chunk budget.
import { buildGraph } from "../src/graph.ts";
import { chunkDocuments, TfIdfIndex } from "../src/retrieve.ts";
import { compare } from "../src/compare.ts";
import { DOCUMENTS, EXTRACTIONS, QUESTIONS } from "../src/data.ts";

const kArg = process.argv.indexOf("--k");
const k = kArg > 0 ? Number(process.argv[kArg + 1]) : 3;
const graph = buildGraph(EXTRACTIONS);
const index = new TfIdfIndex(chunkDocuments(DOCUMENTS));

console.log(`Graph: ${graph.nodes.size} entities, ${graph.edges.length} relations, from ${EXTRACTIONS.length} documents and ${index.chunks.length} chunks.`);
for (const e of graph.nodes.values()) if (e.merges.length) console.log(`  merged into ${e.name}: ${e.merges.map((m) => `"${m.alias}" (${m.reason})`).join(", ")}`);
for (const a of graph.resolution.ambiguous) console.log(`  ambiguous: "${a.name}" could be ${a.candidates.join(" or ")}`);
console.log(`\nChunk search: TF-IDF, top ${k}.\n`);
console.log("| Question | Type | Chunk search | Graph | Hybrid |");
console.log("| --- | --- | --- | --- | --- |");
for (const q of QUESTIONS) {
  const r = compare(graph, index, q, k);
  const n = r.facts.length;
  const cell = (key: "byChunks" | "byGraph" | "byHybrid") => `${r.facts.filter((f) => f[key]).length} of ${n}`;
  console.log(`| ${q.question} | ${q.kind} | ${cell("byChunks")} | ${cell("byGraph")} | ${cell("byHybrid")} |`);
}
console.log("");
for (const q of QUESTIONS) {
  const r = compare(graph, index, q, k);
  console.log(`${q.id}: chunks ${r.hits.map((h) => `${h.chunk.id} (${h.score})`).join(", ")}`);
  console.log(`  graph: ${r.hops.map((h) => `${h.from} -${h.edge.type}- ${h.to}`).join("; ")}`);
  console.log(`  answer: ${r.answerIds.join(", ")}; linked: ${r.linked.join(", ")}`);
  console.log(`  verdict: ${r.verdict.headline}. ${r.verdict.detail}`);
}
