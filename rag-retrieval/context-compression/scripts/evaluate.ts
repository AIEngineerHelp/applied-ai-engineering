import { checkEvidence, compress, defaults } from "../src/compress.ts";
import { formatPassages, retrieve, scenarios } from "../src/fixtures.ts";

const rows = [];
for (const scenario of scenarios)
  for (const question of scenario.questions) {
    const passages =
      scenario.id === "rag"
        ? retrieve(scenario.passages, question.text, 3).map((r) => r.passage)
        : scenario.passages;
    const source = formatPassages(passages);
    for (const method of ["relevance", "mmr", "words", "truncate"] as const)
      for (const remove of [0, 25, 50, 75, 90]) {
        const result = compress(source, {
          ...defaults,
          query: question.text,
          focus: question.focus,
          remove,
          method,
        });
        const facts = checkEvidence(source, result.spans, question.evidence);
        rows.push({
          scenario: scenario.id,
          question: question.id,
          method,
          targetRemoval: remove,
          originalTokens: result.originalTokens,
          keptTokens: result.compressedTokens,
          actualRemoval: Math.round(result.removed * 100),
          evidencePresent: facts.filter((f) => f.present).length,
          evidenceKept: facts.filter((f) => f.kept).length,
          evidenceTotal: facts.length,
        });
      }
  }
if (process.argv.includes("--json"))
  console.log(
    JSON.stringify(
      {
        encoding: "cl100k_base",
        disclaimer: "Synthetic fixtures; evidence retention, not answer accuracy. No LLM calls.",
        rows,
      },
      null,
      2,
    ),
  );
else {
  console.log("Offline fixture sweep. Evidence retention is NOT answer accuracy. No LLM calls.\n");
  console.table(rows);
}
