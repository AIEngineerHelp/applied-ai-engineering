import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEvidence, compress, defaults, mergeSpans, segmentsFor, splitUnits, terms, type Options } from "../src/compress.ts";
import { countTokens } from "../src/tokens.ts";
import { formatPassages, retrieve, scenarios } from "../src/fixtures.ts";
const opts = (patch: Partial<Options> = {}): Options => ({ ...defaults, query: "refund annual export", threshold: 0, ...patch });

test("source segments exactly reconstruct original Unicode and whitespace", () => {
  const source = "## Policy 🧭\n\nAnnual refund within 30 days. No refund after export.\n\n## Other\n\nCafé prices: ₹99.\n";
  const result = compress(source, opts({ remove: 50 }));
  assert.equal(result.segments.map((s) => s.text).join(""), source);
  for (const segment of result.segments) assert.equal(segment.text, source.slice(segment.start, segment.end));
  assert.equal(result.compressedTokens, countTokens(result.text));
  assert.ok(result.compressedTokens <= result.budget);
});

test("merge does not mutate dependencies and handles overlaps and adjacent spans", () => {
  const spans = [{ start: 5, end: 10 }, { start: 0, end: 5 }, { start: 2, end: 3 }, { start: 14, end: 18 }];
  assert.deepEqual(mergeSpans(spans), [{ start: 0, end: 10 }, { start: 14, end: 18 }]);
  assert.equal(spans[0].start, 5);
  assert.equal(segmentsFor("01234567890123456789", mergeSpans(spans)).map((s) => s.text).join(""), "01234567890123456789");
});

test("paragraph and sentence units retain nested heading dependencies", () => {
  const source = "# Guide\n\n## Refunds\n\nAnnual refunds are allowed. Exports are excluded.\n\n## Elsewhere\n\nUnrelated detail.";
  const paragraphs = splitUnits(source, "paragraph");
  const sentences = splitUnits(source, "sentence");
  assert.equal(paragraphs.length, 2);
  assert.equal(sentences.length, 3);
  assert.deepEqual(sentences[1].headings.map((h) => source.slice(h.start, h.end)), ["# Guide\n", "## Refunds\n"]);
  assert.deepEqual(sentences[2].headings.map((h) => source.slice(h.start, h.end)), ["# Guide\n", "## Elsewhere\n"]);
});

test("code fences remain atomic even with blank lines and heading-like code", () => {
  const source = "# Example\n\n```python\n# This is a comment.\n\nprint('One. Two.')\n```\n\nSome prose. More prose.";
  const units = splitUnits(source, "sentence");
  assert.equal(units.length, 3);
  assert.ok(units[0].text.startsWith("```python"));
  assert.ok(units[0].text.endsWith("```\n"));
  assert.equal(units[1].headings.length, 1);
});

test("no whole unit fits: do not exceed budget for the first selection or its heading", () => {
  const result = compress("# A very long heading containing refund policy\n\nAnnual refunds have complex requirements.", opts({ remove: 95 }));
  assert.equal(result.text, "");
  assert.equal(result.selected.length, 0);
  assert.match(result.reason, /No eligible whole unit fits/);
});

test("small inputs and zero removal pass through byte-for-byte", () => {
  const source = "Tiny source.\n\n";
  const small = compress(source, opts({ threshold: 80, remove: 95 }));
  assert.equal(small.status, "small-input");
  assert.equal(small.text, source);
  assert.equal(small.removed, 0);
  assert.equal(compress(source, opts({ remove: 0 })).text, source);
  assert.equal(compress("", opts()).status, "empty");
});

test("threshold is strictly below, not at, the boundary", () => {
  const source = "Annual refund.";
  assert.equal(compress(source, opts({ threshold: countTokens(source) })).status, "compressed");
  assert.equal(compress(source, opts({ threshold: countTokens(source) + 1 })).status, "small-input");
});

test("query and read-specific focus change selection on the same input", () => {
  const source = "## Notes\n\nPricing complaints mention expensive seats.\n\nLaunch date changed to November.\n\nGardening notes mention roses and soil.";
  const a = compress(source, opts({ query: "team", focus: "pricing complaints", remove: 60 }));
  const b = compress(source, opts({ query: "team", focus: "launch date", remove: 60 }));
  assert.match(a.text, /Pricing/); assert.doesNotMatch(a.text, /Launch/);
  assert.match(b.text, /Launch/); assert.doesNotMatch(b.text, /Pricing/);
  const noFocus = compress(source, opts({ query: "team", focus: "pricing complaints", useFocus: false, remove: 60 }));
  assert.equal(noFocus.text, "");
});

test("query-agnostic mode ignores both question and focus", () => {
  const source = formatPassages(scenarios[0].passages);
  assert.equal(compress(source, opts({ queryAware: false, query: "refund" })).text,
    compress(source, opts({ queryAware: false, query: "storage", focus: "anything" })).text);
});

test("dependencies, separators, and source order are counted inside every fixed budget", () => {
  for (const scenario of scenarios) {
    const source = formatPassages(scenario.passages);
    for (const granularity of ["paragraph", "sentence"] as const) {
      for (const remove of [0, 25, 50, 75, 90, 100]) {
        const result = compress(source, opts({ query: scenario.questions[0].text, focus: scenario.questions[0].focus, granularity, remove }));
        assert.ok(result.compressedTokens <= result.budget, `${scenario.id}/${granularity}/${remove}`);
        assert.equal(result.segments.map((s) => s.text).join(""), source);
        for (let i = 1; i < result.spans.length; i++) assert.ok(result.spans[i].start >= result.spans[i - 1].end);
        assert.ok(Number.isFinite(result.removed));
      }
    }
  }
});

test("dynamic budgets respect multiplier bounds, selection never overflows", () => {
  const source = formatPassages(scenarios[0].passages);
  for (const [minFactor, maxFactor] of [[1, 1], [2, 4], [3, 8]]) {
    const result = compress(source, opts({ dynamic: true, minFactor, maxFactor }));
    assert.ok(result.budget >= Math.ceil(result.originalTokens / maxFactor));
    assert.ok(result.budget <= Math.floor(result.originalTokens / minFactor));
    assert.ok(result.compressedTokens <= result.budget);
    assert.match(result.reason, /not Latte/);
  }
});

test("prefix baseline preserves an original prefix without broken Unicode", () => {
  const source = "Emoji 🧭 中文 café 🪴. ".repeat(8);
  for (const remove of [20, 50, 90, 100]) {
    const result = compress(source, opts({ method: "truncate", remove }));
    assert.ok(source.startsWith(result.text));
    assert.ok(result.compressedTokens <= result.budget);
    assert.equal(result.text.includes("\uFFFD"), false);
  }
});

test("annotated facts distinguish retrieval loss, compression loss, and retained spans", () => {
  const source = "Refund within 30 days. Except after export.";
  const facts = checkEvidence(source, [{ start: 0, end: "Refund within 30 days.".length }], [
    { label: "rule", quote: "Refund within 30 days." }, { label: "exception", quote: "Except after export." }, { label: "missing", quote: "No such fact." },
  ]);
  assert.deepEqual(facts.map(({ present, kept }) => [present, kept]), [[true, true], [true, false], [false, false]]);
});

test("all fixture evidence quotes exist in their source", () => {
  for (const scenario of scenarios) for (const question of scenario.questions) {
    const facts = checkEvidence(formatPassages(scenario.passages), [{ start: 0, end: formatPassages(scenario.passages).length }], question.evidence);
    assert.ok(facts.every((f) => f.present && f.kept), `${scenario.id}/${question.id}`);
  }
});

test("retrieval is bounded and deterministic, and can miss required evidence", () => {
  const scenario = scenarios[1];
  assert.deepEqual(retrieve(scenario.passages, "", 2).map((r) => r.passage.id), ["incident", "runbook"]);
  assert.equal(retrieve(scenario.passages, "outage", 0).length, 0);
  assert.equal(retrieve(scenario.passages, "outage", 100).length, scenario.passages.length);
  const source = formatPassages(retrieve(scenario.passages, scenario.questions[1].text, 1).map((r) => r.passage));
  assert.ok(source.includes("migration lock"));
});

test("invalid settings fail explicitly, without returning a misleading result", () => {
  for (const patch of [{ remove: NaN }, { remove: -1 }, { remove: 101 }, { threshold: -1 }, { minFactor: 0 }, { minFactor: 4, maxFactor: 2 }, { maxFactor: Infinity }, { method: "truncate" as const, dynamic: true }]) {
    assert.throws(() => compress("Hello", opts(patch)));
  }
});

test("literal special-token strings and HTML are handled as source text", () => {
  const source = '<|endoftext|> <script>alert("refund")</script>';
  assert.ok(countTokens(source) > 0);
  assert.equal(compress(source, opts({ remove: 0 })).text, source);
  assert.deepEqual(terms("Refunds REFUND refund"), ["refund"]);
});


test("two-source RAG question exposes retrieval loss before compression", () => {
  const scenario = scenarios[1];
  const question = scenario.questions.find((q) => q.id === "cross-source")!;
  const source = formatPassages(retrieve(scenario.passages, question.text, 1).map((r) => r.passage));
  const result = compress(source, opts({ query: question.text, remove: 0 }));
  const facts = checkEvidence(source, result.spans, question.evidence);
  assert.equal(facts.filter((f) => f.present).length, 1);
  assert.equal(facts.filter((f) => f.kept).length, 1);
});
