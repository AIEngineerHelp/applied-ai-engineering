import assert from "node:assert/strict";
import test from "node:test";
import { compress } from "../src/compress.ts";
import {
  breakingCases,
  compareAll,
  lexicalWalkthrough,
  mmrWalkthrough,
  questionTerms,
  tourExample,
  tourOptions,
  truncationWalkthrough,
  wordWalkthrough,
} from "../src/tour.ts";

const kept = (facts: { kept: boolean }[]) => facts.map((f) => f.kept);

test("question terms drop filler words and shorten plurals", () => {
  const q = questionTerms("Can I get a refund for archives?");
  assert.deepEqual(q.terms, ["get", "refund", "archive"]);
  assert.equal(q.steps.find((s) => s.word === "can")?.term, null);
  assert.equal(q.steps.find((s) => s.word === "archives")?.term, "archive");
});

test("lexical walkthrough matches compress() and explains the top score", () => {
  const walk = lexicalWalkthrough();
  const direct = compress(tourExample.source, tourOptions("relevance"));
  assert.deepEqual(walk.result.selected, direct.selected);
  const top = walk.topCalculation!;
  const sum = top.contributions.reduce((s, c) => s + c.weight, 0);
  assert.ok(Math.abs(sum / Math.sqrt(top.uniqueTerms) - top.unit.score) < 1e-9);
  assert.equal(walk.pack.filter((p) => p.outcome === "kept").length, direct.selected.length);
  assert.deepEqual(kept(walk.facts), [true, true]);
});

test("the synonym question loses the general rule", () => {
  const walk = lexicalWalkthrough({ query: breakingCases.synonym });
  assert.deepEqual(kept(walk.facts), [false, true]);
});

test("MMR rounds replay compress() exactly", () => {
  for (const overrides of [{}, breakingCases.mmr, { diversity: 0, remove: 60 }]) {
    const walk = mmrWalkthrough(overrides);
    const roundKept = walk.rounds.filter((r) => r.outcome === "kept").map((r) => r.unit.id);
    assert.deepEqual(roundKept, walk.result.selected);
  }
});

test("a stronger MMR penalty at a tight budget drops the general rule", () => {
  assert.deepEqual(kept(lexicalWalkthrough({ remove: 85 }).facts), [true, true]);
  assert.deepEqual(kept(mmrWalkthrough(breakingCases.mmr).facts), [false, true]);
});

test("word deletion removes the negation inside the exception", () => {
  const walk = wordWalkthrough();
  assert.equal(walk.inQuote.find((w) => w.word === "not")?.kept, false);
  assert.ok(walk.result.compressedTokens < walk.result.budget / 2);
  assert.deepEqual(kept(walk.facts), [false, false]);
});

test("truncation keeps a prefix and never reaches the refund policy", () => {
  const walk = truncationWalkthrough();
  assert.equal(walk.sections[0].state, "kept");
  assert.equal(walk.sections.find((s) => s.title === "Refund policy")?.state, "dropped");
  assert.deepEqual(kept(walk.facts), [false, false]);
});

test("compareAll covers every sentence for each method", () => {
  const rows = compareAll(60);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok(row.coverage.every((c) => c.kept >= 0 && c.kept <= 1));
    assert.ok(row.result.compressedTokens <= row.result.budget);
  }
});
