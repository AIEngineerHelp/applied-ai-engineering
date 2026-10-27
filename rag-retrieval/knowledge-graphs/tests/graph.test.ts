import { test } from "node:test";
import assert from "node:assert/strict";

import { DOCUMENTS, EXTRACTIONS, QUESTIONS } from "../src/data.ts";
import { validateExtraction, type Extraction } from "../src/schema.ts";
import { resolve, sameEntity } from "../src/resolve.ts";
import { buildGraph, findByName, followPattern, linkEntities, neighbourhood, shortestPath } from "../src/graph.ts";
import { chunkDocuments, docText, stem, terms, TfIdfIndex } from "../src/retrieve.ts";
import { compare, expectedIds } from "../src/compare.ts";
import { mentionSpans, pieces } from "../src/spans.ts";
import LAYOUT from "../data/layout.json" with { type: "json" };

const graph = buildGraph(EXTRACTIONS);
const index = new TfIdfIndex(chunkDocuments(DOCUMENTS));
const id = (name: string) => findByName(graph, name)!.id;

// --- fixtures -------------------------------------------------------------

test("every document has an extraction, and every extraction follows the schema", () => {
  assert.deepEqual(EXTRACTIONS.map((x) => x.document).sort(), DOCUMENTS.map((d) => d.id).sort());
  for (const x of EXTRACTIONS) {
    const doc = DOCUMENTS.find((d) => d.id === x.document)!;
    assert.deepEqual(validateExtraction(x, docText(doc)), [], x.document);
  }
});

test("validation rejects schema violations and invented evidence", () => {
  const bad: Extraction = {
    document: "t",
    source: "fixture",
    entities: [
      { name: "Ada", type: "Person" },
      { name: "Atlas-3", type: "Product" },
    ],
    relations: [{ source: "Ada", type: "SUPPLIES", target: "Atlas-3", evidence: "Ada makes it." }],
  };
  const problems = validateExtraction(bad, "Ada works on the Atlas-3.");
  assert.ok(problems.some((p) => p.includes("SUPPLIES cannot start at a Person")));
  assert.ok(problems.some((p) => p.includes("cannot end at a Product")));
  assert.ok(problems.some((p) => p.includes("evidence")));
});

// --- entity resolution ----------------------------------------------------

test("names merge on normalization, abbreviation and initials, but not on different numbers", () => {
  assert.equal(sameEntity("Atlas 3", "Atlas-3"), "same name after normalizing");
  assert.equal(sameEntity("Varnell Semi", "Varnell Semiconductor"), "abbreviation or initial");
  assert.equal(sameEntity("T. Berg", "Tomas Berg"), "abbreviation or initial");
  assert.equal(sameEntity("PM-1", "PM-2 power module"), null);
  assert.equal(sameEntity("Berg", "Tomas Berg"), null); // words must line up from the start
});

test("the corpus resolves to one node per real-world entity", () => {
  assert.equal(graph.nodes.size, 18);
  assert.deepEqual(findByName(graph, "Varnell Semi")!.name, "Varnell Semiconductor");
  assert.deepEqual(findByName(graph, "Varnell")!.name, "Varnell Semiconductor");
  assert.deepEqual(findByName(graph, "QX-7")!.name, "QX-7 radio chip");
  assert.deepEqual(findByName(graph, "T. Berg")!.name, "Tomas Berg");
  assert.deepEqual(findByName(graph, "Atlas 3")!.name, "Atlas-3");
  assert.notEqual(id("PM-1"), id("PM-2 power module"));
  assert.deepEqual(graph.resolution.ambiguous, []);
});

test("an alias that matches two entities is reported, not guessed", () => {
  const x: Extraction = {
    document: "t",
    source: "fixture",
    entities: [
      { name: "Anna Berg", type: "Person" },
      { name: "Arvid Berg", type: "Person" },
      { name: "A. Berg", type: "Person" },
    ],
    relations: [],
  };
  const r = resolve([x]);
  assert.equal(r.entities.length, 3);
  assert.deepEqual(r.ambiguous, [{ name: "A. Berg", type: "Person", candidates: ["Arvid Berg", "Anna Berg"] }]);
});

test("resolution does not depend on document order", () => {
  const reversed = buildGraph([...EXTRACTIONS].reverse());
  assert.deepEqual([...reversed.nodes.keys()].sort(), [...graph.nodes.keys()].sort());
  assert.deepEqual(reversed.edges.map((e) => e.id).sort(), graph.edges.map((e) => e.id).sort());
});

test("a relation stated in two documents becomes one edge with two pieces of evidence", () => {
  const owns = graph.edges.find((e) => e.id === `${id("Hardware team")}|OWNS|${id("Borealis controller")}`)!;
  assert.deepEqual(owns.evidence.map((e) => e.document).sort(), ["borealis", "teams"]);
  const leads = graph.edges.find((e) => e.id === `${id("Tomas Berg")}|LEADS|${id("Hardware team")}`)!;
  assert.equal(leads.evidence.length, 2); // "Tomas Berg" in one document, "T. Berg" in the other
});

// --- traversal --------------------------------------------------------------

test("a pattern follows relations in their direction", () => {
  const { ends, paths } = followPattern(graph, id("QX-7 radio chip"), [
    { rel: "PART_OF", dir: "out" },
    { rel: "USES", dir: "in" },
  ]);
  assert.deepEqual(ends.sort(), [id("Calder Grain Co-op"), id("Osterby Water Utility")].sort());
  assert.ok(paths.every((p) => p.length === 2));
  // The wrong direction finds nothing.
  assert.deepEqual(followPattern(graph, id("QX-7 radio chip"), [{ rel: "PART_OF", dir: "in" }]).ends, []);
});

test("shortest path ignores direction and returns hops in order", () => {
  const hops = shortestPath(graph, id("Pellham Labs"), id("Varnell Semiconductor"))!;
  assert.deepEqual(
    [hops[0].from, ...hops.map((h) => h.to)],
    [id("Pellham Labs"), id("Borealis controller"), id("PM-2 power module"), id("Varnell Semiconductor")],
  );
  assert.equal(shortestPath(graph, id("Ines Okafor"), id("Pellham Labs")), null); // a separate component
});

test("neighbourhood returns each touching edge once", () => {
  const hops = neighbourhood(graph, [id("QX-7 radio chip")], 1);
  assert.deepEqual(hops.map((h) => h.edge.type).sort(), ["DELAYED", "PART_OF", "SUPPLIES"]);
  assert.equal(neighbourhood(graph, [id("QX-7 radio chip")], 2).length > hops.length, true);
});

test("entity linking finds aliases in questions, longest match first", () => {
  assert.deepEqual(linkEntities(graph, "Did Varnell Semi delay the QX-7?"), [id("Varnell Semiconductor"), id("QX-7 radio chip")]);
  assert.deepEqual(linkEntities(graph, "Where is Atlas 3 used?"), [id("Atlas-3")]);
  assert.deepEqual(linkEntities(graph, "Is the Borealisian theory true?"), []); // whole words only
});

// --- chunk retrieval --------------------------------------------------------

test("tokenizing drops stop words and strips simple suffixes", () => {
  assert.equal(stem("readings"), "reading");
  assert.equal(stem("supplies"), "supply");
  assert.equal(stem("uploading"), "upload");
  assert.deepEqual(terms("Who leads the Firmware team?"), ["lead", "firmware", "team"]);
});

test("one chunk per paragraph, and the most similar chunk ranks first", () => {
  assert.equal(index.chunks.length, DOCUMENTS.reduce((n, d) => n + d.paragraphs.length, 0));
  assert.equal(index.search("Who leads the Firmware team?", 1)[0].chunk.id, "teams#1");
  const hits = index.search("battery life", 17);
  assert.ok(hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));
});

// --- the comparison -------------------------------------------------------

test("every question links to the entities its strategy starts from", () => {
  for (const q of QUESTIONS) {
    const s = q.strategy;
    const anchors = s.type === "pattern" ? [s.start] : s.type === "path" ? [s.from, s.to] : [s.around];
    const linked = linkEntities(graph, q.question);
    for (const a of anchors) assert.ok(linked.includes(id(a)), `${q.id}: ${a}`);
  }
});

test("every fact's evidence is in exactly one chunk, and its triple is an edge", () => {
  for (const q of QUESTIONS) {
    for (const f of compare(graph, index, q).facts) {
      assert.ok(f.chunk, `${q.id}: ${f.label}`);
      assert.equal(index.chunks.filter((c) => c.text.includes(f.evidence)).length, 1);
      if (f.triple) assert.ok(f.edge, `${q.id}: no edge for ${f.triple.join(" ")}`);
    }
  }
});

test("graph traversal returns the expected answer entities", () => {
  for (const q of QUESTIONS) {
    if (!q.expected.length) continue;
    const r = compare(graph, index, q);
    assert.deepEqual([...r.answerIds].sort(), expectedIds(graph, q).sort(), q.id);
  }
});

test("computed outcomes: the graph wins multi-hop, both win single facts, chunks win prose detail", () => {
  const outcome = Object.fromEntries(QUESTIONS.map((q) => [q.id, compare(graph, index, q, 3)]));
  assert.equal(outcome["upload-ticket"].verdict.winner, "graph");
  assert.equal(outcome["qx7-customers"].verdict.winner, "graph");
  assert.equal(outcome["varnell-exposure"].verdict.winner, "graph");
  assert.equal(outcome["pellham-varnell"].verdict.winner, "graph");
  assert.equal(outcome["who-leads-firmware"].verdict.winner, "both");
  assert.equal(outcome["incident-actions"].verdict.winner, "chunks");
  for (const r of Object.values(outcome)) assert.equal(r.outcome.hybrid, "complete", r.question.id);
});

test("verdicts state the real rank of a missed passage", () => {
  const r = compare(graph, index, QUESTIONS.find((q) => q.id === "upload-ticket")!, 3);
  const missed = r.facts.find((f) => !f.byChunks)!;
  assert.ok(missed.rank! > 3);
  assert.match(r.verdict.detail, new RegExp(`ranked ${missed.rank}th of 17`));
});

// --- highlighting and layout ----------------------------------------------

test("mentions are found as whole words and pieces rebuild the text", () => {
  for (const x of EXTRACTIONS) {
    const text = docText(DOCUMENTS.find((d) => d.id === x.document)!);
    assert.equal(pieces(text, x).map((p) => p.text).join(""), text);
    const found = new Set(mentionSpans(text, x).map((s) => s.name));
    for (const e of x.entities) assert.ok(found.has(e.name), `${x.document}: ${e.name}`);
  }
});

test("every entity has a position in the graph layout", () => {
  const layout = LAYOUT as Record<string, number[]>;
  for (const e of graph.nodes.values()) assert.ok(layout[e.name], e.name);
});
