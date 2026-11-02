import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, defaults } from "../src/compress.ts";
import { explainCut } from "../src/explain.ts";

test("cuts distinguish actual no-overlap and budget rejections", () => {
  const source = "Refunds are allowed.\n\nRefunds require a receipt and an annual subscription within thirty days.\n\nGardening advice.";
  const options = { ...defaults, query: "refunds", threshold: 0, remove: 70, granularity: "paragraph" as const };
  const result = compress(source, options);
  const explanations = result.segments.filter((s) => !s.kept).map((s) => explainCut(s, result, options));
  const reasons = explanations.flatMap((e) => e.reasons.map((r) => r.reason)).join("\n");
  assert.match(reasons, /nonpositive score/);
  assert.match(reasons, /adding it at its turn would produce \d+ tokens/);
  assert.match(reasons, /matched terms: refund/);
  assert.ok(result.decisions?.some((d) => d.outcome === "over-budget" && d.candidateTokens! > result.budget));
});

test("truncation explains a cutoff rather than claiming low relevance", () => {
  const options = { ...defaults, method: "truncate" as const, threshold: 0, remove: 70 };
  const result = compress("Important refunds after archive export. Extra text follows here.", options);
  const cut = result.segments.find((s) => !s.kept)!;
  const explanation = explainCut(cut, result, options);
  assert.match(explanation.how, /relevance was not considered/);
  assert.deepEqual(explanation.reasons, []);
});

test("unselected headings explain dependencies and MMR labels base scores", () => {
  const options = { ...defaults, method: "mmr" as const, query: "refund", threshold: 0, remove: 90 };
  const result = compress("## Gardening\n\nPlant flowers in spring.", options);
  const explanation = explainCut({ start: 0, end: 13 }, result, options);
  assert.match(explanation.how, /not MMR priority/);
  assert.match(explanation.reasons[0].reason, /dependencies/);
});
