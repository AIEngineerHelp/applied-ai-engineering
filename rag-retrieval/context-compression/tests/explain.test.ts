import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, defaults } from "../src/compress.ts";
import { explainCut } from "../src/explain.ts";

test("cuts distinguish actual no-overlap and budget rejections", () => {
  const source =
    "Refunds are allowed.\n\nRefunds require a receipt and an annual subscription within thirty days.\n\nGardening advice.";
  const options = {
    ...defaults,
    query: "refunds",
    threshold: 0,
    remove: 70,
    granularity: "paragraph" as const,
  };
  const result = compress(source, options);
  const explanations = result.segments
    .filter((s) => !s.kept)
    .map((s) => explainCut(s, result, options));
  const reasons = explanations.flatMap((e) => e.reasons.map((r) => r.reason)).join("\n");
  assert.match(reasons, /nonpositive score/);
  assert.match(reasons, /adding it at its turn would produce \d+ tokens/);
  assert.match(reasons, /matched terms: refund/);
  assert.ok(
    result.decisions?.some(
      (d) => d.outcome === "over-budget" && d.candidateTokens! > result.budget,
    ),
  );
});

test("truncation explains a cutoff rather than claiming low relevance", () => {
  const options = { ...defaults, method: "truncate" as const, threshold: 0, remove: 70 };
  const result = compress(
    "Important refunds after archive export. Extra text follows here.",
    options,
  );
  const cut = result.segments.find((s) => !s.kept)!;
  const explanation = explainCut(cut, result, options);
  assert.match(explanation.how, /relevance was not considered/);
  assert.deepEqual(explanation.reasons, []);
});

test("unselected headings explain dependencies and MMR labels base scores", () => {
  const options = {
    ...defaults,
    method: "mmr" as const,
    query: "refund",
    threshold: 0,
    remove: 90,
  };
  const result = compress("## Gardening\n\nPlant flowers in spring.", options);
  const explanation = explainCut({ start: 0, end: 13 }, result, options);
  assert.match(explanation.how, /not MMR priority/);
  assert.match(explanation.reasons[0].reason, /dependencies/);
});

test("zero-score explanation walks from normalized terms to the actual arithmetic", () => {
  const options = {
    ...defaults,
    query: "Can I get a refund after exporting?",
    threshold: 0,
    remove: 60,
  };
  const result = compress("Prices exclude local taxes.", options);
  const explanation = explainCut({ start: 0, end: 26 }, result, options);
  assert.ok(explanation.queryTerms?.includes("refund"));
  const steps = explanation.reasons[0].calculation!.join("\n");
  assert.match(steps, /Terms: price, exclude, local, taxe/);
  assert.match(steps, /no terms match/);
  assert.match(steps, /0.000 \/ √4 = 0.000/);
  assert.match(steps, /not a probability/);
});

test("positive-score arithmetic includes heading matches and the selected read focus", () => {
  const options = {
    ...defaults,
    query: "billing",
    focus: "taxes",
    useFocus: true,
    threshold: 0,
    remove: 90,
  };
  const source = "## Billing\n\nPrices exclude local taxes.";
  const result = compress(source, options);
  const explanation = explainCut({ start: 12, end: source.length }, result, options);
  assert.deepEqual(explanation.queryTerms, ["billing", "taxe"]);
  const steps = explanation.reasons[0].calculation!.join("\n");
  assert.match(steps, /plus its required headings/);
  assert.match(steps, /billing: df=1, weight=0.693/);
  assert.match(steps, /taxe: df=1, weight=0.693/);
  assert.match(steps, /1.386 \/ √5 = 0.620/);
});
