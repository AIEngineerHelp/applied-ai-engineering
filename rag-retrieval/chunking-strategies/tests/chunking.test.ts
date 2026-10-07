import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { chunkDocument, recursiveRanges, fixedRanges } from "../src/chunkers.ts";
import { parseUnits, detectFormat } from "../src/structure.ts";
import { mergeRanges } from "../src/text.ts";
import { estimateTokens } from "../src/tokens.ts";
import type { Doc, Range } from "../src/types.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const corpus: Doc[] = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")).map(
  (m: Omit<Doc, "images"> & { file: string; images?: string }) => ({
    ...m,
    text: readFileSync(join(DIR, m.file), "utf8"),
    images: m.images ? JSON.parse(readFileSync(join(DIR, m.images), "utf8")) : undefined,
  }),
);
const slice = (text: string, [s, e]: Range) => text.slice(s, e);

test("fixed windows cut at exact sizes", () => {
  assert.deepEqual(fixedRanges("x".repeat(1000), 400), [[0, 400], [400, 800], [800, 1000]]);
});

test("recursive splitting respects the limit and prefers paragraph breaks", () => {
  const para = (n: number) => `Sentence ${n} is here. `.repeat(14).trim();
  const text = [para(1), para(2), para(3)].join("\n\n");
  const ranges = recursiveRanges(text, [0, text.length], 400);
  for (const [s, e] of ranges) assert.ok(e - s <= 400);
  assert.equal(ranges.length, 3);
  assert.equal(slice(text, ranges[1]), para(2));
});

test("markdown sections keep their heading path; empty headings join the next section", () => {
  const text = "# Guide\n\nIntro text.\n\n## Billing\n\n### Refunds\n\nRefunds take 5 days.\n\n### Invoices\n\nMonthly.";
  const units = parseUnits(text, "markdown");
  assert.equal(units.length, 3);
  assert.ok(slice(text, units[1].range).startsWith("## Billing\n\n### Refunds"));
  assert.deepEqual(units[2].ancestors.map((a) => slice(text, a)), ["# Guide", "## Billing"]);
});

test("code splits into functions and per-method units under their class", () => {
  const text = ["RATE = 3", "", "def a():", "    return RATE", "", "class C:", '    """Doc."""', "", "    def m(self):", "        return 1"].join("\n");
  const units = parseUnits(text, "code");
  assert.deepEqual(units.map((u) => slice(text, u.range).split("\n")[0]), ["RATE = 3", "def a():", "class C:", "def m(self):"]);
  assert.deepEqual(units[3].ancestors.map((a) => slice(text, a)), ["class C:"]);
});

test("contract clauses sit under their article", () => {
  const text = '1. DEFINITIONS\n\n1.1 "Fees" means money.\n\n1.2 "Term" means time.\n\n2. PAYMENT\n\n2.1 Pay in 30 days.';
  const units = parseUnits(text, "contract");
  assert.equal(units.length, 3);
  assert.deepEqual(units[2].ancestors.map((a) => slice(text, a)), ["2. PAYMENT"]);
});

test("format detection", () => {
  assert.equal(detectFormat("a,b,c\n1,2,3\n4,5,6\n7,8,9\n1,1,1"), "table");
  assert.equal(detectFormat("[00:01:02] Ann: hi\n[00:01:09] Bo: hey\n[00:02:00] Ann: ok"), "transcript");
  assert.equal(detectFormat("x", "rate.py"), "code");
  assert.equal(detectFormat("# A\n\ntext\n\n## B\n\nmore"), "markdown");
});

test("both methods cover every document and respect the size limit", () => {
  for (const d of corpus) {
    for (const m of ["structure", "fixed"] as const) {
      const chunks = chunkDocument(d, m);
      const spans = mergeRanges(chunks.flatMap((c) => c.spans));
      const covered = spans.reduce((n, r) => n + slice(d.text, r).replace(/\s/g, "").length, 0);
      assert.equal(covered, d.text.replace(/\s/g, "").length, `${m} on ${d.id} drops text`);
      // The chunk's own text stays within the limit; context comes on top.
      for (const c of chunks) assert.ok(estimateTokens(slice(d.text, c.spans[c.spans.length - 1])) <= 400, `${m} on ${d.id}`);
    }
  }
});

test("structure chunks end at unit boundaries, never mid-line", () => {
  for (const d of corpus) {
    for (const c of chunkDocument(d, "structure")) {
      const end = c.spans[c.spans.length - 1][1];
      assert.ok(end === d.text.trimEnd().length || /^[ \t]*\n/.test(d.text.slice(end)) || /[.!?]$/.test(d.text.slice(0, end)), `${d.id} cuts mid-line at ${end}`);
    }
  }
});

test("table chunks carry the header row; it is not a chunk of its own", () => {
  const d = corpus.find((x) => x.id === "service-catalog")!;
  const header = d.text.split("\n")[0];
  const chunks = chunkDocument(d, "structure");
  for (const c of chunks) {
    assert.ok(c.text.startsWith(`Document: ${d.title}\n${header}\n\n`));
    assert.equal(slice(d.text, c.spans[0]), header);
    assert.notEqual(slice(d.text, c.spans[c.spans.length - 1]), header);
  }
});

test("code methods carry their class line", () => {
  const d = corpus.find((x) => x.id === "rate-engine")!;
  const method = chunkDocument(d, "structure").find((c) => c.text.includes("def quote(self"))!;
  assert.match(method.label!, /^class RateCalculator/);
  assert.ok(method.text.includes("class RateCalculator"));
});

const withImages = (id: string): Doc => corpus.find((x) => x.id === id)!;

test("each figure is one chunk with its caption, description and citing sentences", () => {
  const d = withImages("network-report");
  const chunks = chunkDocument(d, "structure");
  const figs = chunks.filter((c) => c.image);
  assert.deepEqual(figs.map((c) => c.image!.number), [1, 2, 3, 4]);
  for (const c of figs) {
    const own = slice(d.text, c.spans[c.spans.length - 1]);
    assert.match(own, /^!\[/);
    assert.match(own, new RegExp(`\\*Figure ${c.image!.number}\\.`));
    assert.ok(c.text.includes("Image description: "), `Figure ${c.image!.number} has no description`);
  }
  // Figure 2 is discussed sections later; that sentence is attached and linked.
  const fig2 = figs[1];
  assert.ok(fig2.text.includes("As Figure 2 shows"));
  const far = chunks.findIndex((c) => slice(d.text, c.spans[c.spans.length - 1]).includes("As Figure 2 shows"));
  assert.ok(fig2.links!.includes(far) && chunks[far].links!.includes(chunks.indexOf(fig2)));
  // "The diagram below" links to Figure 3, and the citing sentence starts at "The diagram".
  assert.ok(figs[2].text.includes("- The diagram below"));
});

test("manual steps that use callout numbers link to the parts diagram and table", () => {
  const d = withImages("scanner-manual");
  const chunks = chunkDocument(d, "structure");
  const diagram = chunks.findIndex((c) => c.image?.number === 1);
  const step = chunks.findIndex((c) => !c.image && /\(\d\)/.test(slice(d.text, c.spans[c.spans.length - 1])) && /^\d+\.|Procedure/m.test(slice(d.text, c.spans[c.spans.length - 1])));
  const table = chunks.findIndex((c) => /^\|\s*Callout/m.test(slice(d.text, c.spans[c.spans.length - 1])));
  assert.ok(step >= 0 && table >= 0);
  assert.ok(chunks[step].links!.includes(diagram));
  assert.ok(chunks[diagram].links!.includes(table));
});

test("slides are one chunk each, image included; 'previous slide' links back", () => {
  const d = withImages("launch-deck");
  const chunks = chunkDocument(d, "structure");
  assert.equal(chunks.length, 8);
  assert.equal(chunks.filter((c) => c.image).length, 5);
  const s4 = chunks.findIndex((c) => slice(d.text, c.spans[c.spans.length - 1]).startsWith("## Slide 4"));
  assert.deepEqual(chunks[s4].links, [s4 - 1]);
});
