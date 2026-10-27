import { test } from "node:test";
import assert from "node:assert/strict";

import { loadCorpus, readJson } from "../src/load-corpus.ts";
import { parseDoc } from "../src/corpus.ts";
import { extractionJsonSchema, quoteInText, validateExtraction, ENTITY_TYPES, RELATION_TYPES } from "../src/schema.ts";
import { clusterByRules, sameByRule } from "../src/resolve.ts";
import { guardCypher, MAX_DEPTH } from "../src/cypher-guard.ts";
import { scoreEither, scorePassages, scoreText, type Question } from "../src/score.ts";
import { evaluate, mentionsOf, type Resolution } from "../src/pipeline/resolve-run.ts";
import type { ExtractionRun } from "../src/pipeline/extract.ts";
import { buildGraph, edgeProperties, type Graph } from "../src/graph.ts";
import { variation } from "../src/pipeline/variation.ts";
import { summarize } from "../src/summary.ts";
import type { QuestionResult } from "../src/pipeline/ask.ts";
import { communities, entitiesIn } from "../src/pipeline/ask.ts";
import { handleAsk, rateLimit, resetRateLimits, type AskDeps } from "../src/ask-endpoint.ts";
import { layoutGraph } from "../src/layout.ts";
import { placeLabels, overlaps, textWidth } from "../src/diagram.ts";
import { goldOf } from "../src/gold.ts";

const docs = loadCorpus();
const doc = (id: string) => docs.find((d) => d.id === id)!;
const questions = readJson<Question[]>("data/questions.json");
const runs = [1, 2, 3].map((r) => readJson<ExtractionRun>(`results/extraction/run-${r}.json`));
const graph = readJson<Graph>("results/graph.json");
const resolution = readJson<Resolution & { reviewed: { clusters: Resolution["clusters"]; evaluation: Resolution["evaluation"] } }>("results/resolution.json");
const answers = readJson<{ results: QuestionResult[] }>("results/answers.json");

// ---------------------------------------------------------------- corpus and gold

test("the corpus has 25 documents with front matter, and parsing rejects a document without it", () => {
  assert.equal(docs.length, 25);
  for (const d of docs) assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => parseDoc("no front matter"));
});

test("every gold support quote is verbatim in its document", () => {
  for (const q of questions) for (const it of q.items) for (const s of it.support) assert.ok(quoteInText(s.quote, doc(s.doc).text), `${q.id}: ${s.quote}`);
});

test("gold aliases map back to their entity, and the type must agree", () => {
  assert.equal(goldOf("Varnell Semi", "Company")?.name, "Varnell Semiconductor");
  assert.equal(goldOf("A3", "Product")?.name, "Atlas-3");
  assert.equal(goldOf("Varnell", "Customer"), null);
});

// ---------------------------------------------------------------- schema and quotes

test("the structured-output schema lists exactly the schema's types", () => {
  const s = extractionJsonSchema() as { properties: { entities: { items: { properties: { type: { enum: string[] } } } }; relations: { items: { properties: { relation: { enum: string[] } } } } } };
  assert.deepEqual(s.properties.entities.items.properties.type.enum, ENTITY_TYPES);
  assert.deepEqual(s.properties.relations.items.properties.relation.enum, RELATION_TYPES);
});

test("validation rejects schema violations, invented quotes, unknown entities and bad properties", () => {
  const text = "Ada Lund leads the Firmware team. Since 2026-01-02 Kerrin supplies the QX-7.";
  const v = validateExtraction(
    {
      entities: [
        { name: "Ada Lund", type: "Person" },
        { name: "Firmware team", type: "Team" },
        { name: "Kerrin", type: "Company" },
        { name: "QX-7", type: "Component" },
        { name: "X", type: "Planet" },
      ],
      relations: [
        { source: "Ada Lund", source_type: "Person", relation: "LEADS", target: "Firmware team", target_type: "Team", quote: "Ada Lund leads the Firmware team." },
        { source: "Ada Lund", source_type: "Person", relation: "SUPPLIES", target: "QX-7", target_type: "Component", quote: "Ada Lund leads" },
        { source: "Kerrin", source_type: "Company", relation: "SUPPLIES", target: "QX-7", target_type: "Component", quote: "Kerrin makes the QX-7" },
        { source: "Nobody", source_type: "Company", relation: "SUPPLIES", target: "QX-7", target_type: "Component", quote: "Kerrin supplies the QX-7" },
        { source: "Kerrin", source_type: "Company", relation: "SUPPLIES", target: "QX-7", target_type: "Component", quote: "Kerrin supplies the QX-7", properties: [{ key: "since", value: "January" }] },
        { source: "Kerrin", source_type: "Company", relation: "SUPPLIES", target: "QX-7", target_type: "Component", quote: "Kerrin  supplies\nthe QX-7", properties: [{ key: "since", value: "2026-01-02" }] },
      ],
    },
    text,
  );
  assert.equal(v.triples.length, 2);
  assert.deepEqual(v.triples[1].properties, { since: "2026-01-02" });
  const reasons = v.rejects.map((r) => r.reason).join(" | ");
  assert.match(reasons, /unknown entity type Planet/);
  assert.match(reasons, /SUPPLIES cannot connect a Person/);
  assert.match(reasons, /quote is not verbatim/);
  assert.match(reasons, /not in the entity list/);
  assert.match(reasons, /not an ISO date/);
});

test("every recorded triple's quote is verbatim in its document, in all three runs", () => {
  for (const r of runs) for (const d of r.docs) for (const t of d.triples) assert.ok(quoteInText(t.quote, doc(d.doc).text), `run ${r.run} ${d.doc}: ${t.quote}`);
});

test("every graph edge keeps its provenance, and its quotes are verbatim in the cited documents", () => {
  for (const e of graph.edges) {
    assert.ok(e.mentions.length >= 1);
    for (const m of e.mentions) assert.ok(quoteInText(m.quote, doc(m.doc).text), `${e.id}: ${m.quote}`);
    const p = edgeProperties(e, graph.run);
    assert.equal((p.quotes as string[]).length, e.mentions.length);
    assert.ok((p.first_seen as string) <= (p.last_seen as string));
  }
});

test("a value stated twice keeps both, with the latest as the current value", () => {
  const osterby = graph.edges.find((e) => e.type === "USES" && e.source.includes("osterby"))!;
  const p = edgeProperties(osterby, "test");
  assert.deepEqual(p.units_values, [420, 510]);
  assert.equal(p.units, 510);
});

// ---------------------------------------------------------------- resolution

test("resolution rules: normalisation, abbreviations and initials merge; numbers and other words don't", () => {
  assert.equal(sameByRule("Atlas 3", "Atlas-3"), "rule: same name after normalizing");
  assert.equal(sameByRule("Varnell Semi", "Varnell Semiconductor"), "rule: abbreviation or initial");
  assert.equal(sameByRule("T. Berg", "Tomas Berg"), "rule: abbreviation or initial");
  assert.equal(sameByRule("PM-1", "PM-2 power module"), null);
  assert.equal(sameByRule("A3", "Atlas-3"), null);
});

test("the rules only merge within a type, and refuse a name that fits two entities", () => {
  const m = (name: string, type: string) => ({ name, type, docs: ["d"] });
  const typed = clusterByRules([m("Varnell Semiconductor", "Company"), m("Varnell Bay Marina", "Customer"), m("Varnell", "Company")]);
  assert.equal(typed.clusters.find((c) => c.type === "Company")!.members.length, 2);
  const untyped = clusterByRules([m("Varnell Semiconductor", "Any"), m("Varnell Bay Marina", "Any"), m("Varnell", "Any")]);
  assert.deepEqual(untyped.ambiguous.map((a) => a.name), ["Varnell"]);
});

test("the recorded resolution re-evaluates to the same numbers", () => {
  const e = evaluate(resolution.reviewed.clusters, runs[0]);
  assert.deepEqual(e, resolution.reviewed.evaluation);
  assert.equal(e.falseMerges.length, 0);
  assert.equal(e.falseSplits.length, 0);
  assert.equal(resolution.evaluation.falseSplits.length, 2, "before the person's review, Support and A3 were split off");
  assert.ok(resolution.clusters.length > resolution.reviewed.clusters.length);
});

test("the graph is rebuilt exactly from run 1 and the reviewed entities", () => {
  const dateOf = new Map(docs.map((d) => [d.id, d.date]));
  const rebuilt = buildGraph(runs[0].runId, resolution.reviewed.clusters, runs[0].docs.map((d) => ({ doc: d.doc, date: dateOf.get(d.doc)!, triples: d.triples })));
  assert.deepEqual(rebuilt, graph);
  assert.equal(mentionsOf(runs[0]).length, runs[0].docs.reduce((s, d) => s + d.entities.length, 0));
});

test("the recorded variation matches the three runs", () => {
  const v = variation(runs);
  assert.deepEqual(v, readJson("results/variation.json"));
  assert.ok(v.pairs.every((p) => p.jaccard > 0.8 && p.jaccard <= 1));
});

// ---------------------------------------------------------------- the Cypher guard

test("the guard allows bounded read queries and adds a row limit", () => {
  const ok = guardCypher("MATCH (a)-[*..3]-(b) RETURN a.name");
  assert.ok(ok.ok && ok.cypher.endsWith("LIMIT 100"));
  assert.ok(guardCypher("MATCH (n) WHERE n.name = 'DELETE me' RETURN n LIMIT 5").ok, "keywords inside strings are fine");
  assert.ok(guardCypher("MATCH (n) RETURN n {.name}, count(*) * 2").ok);
});

test("the guard blocks writes, procedures, several statements and unbounded paths", () => {
  for (const q of [
    "MATCH (n) DETACH DELETE n",
    "MERGE (n:Person {name: 'x'}) RETURN n",
    "MATCH (n) SET n.x = 1 RETURN n",
    "CALL db.labels()",
    "MATCH (n) RETURN n; MATCH (m) DELETE m",
    "MATCH (a)-[*]-(b) RETURN a",
    `MATCH (a)-[*..${MAX_DEPTH + 1}]-(b) RETURN a`,
    "MATCH (a)-[:R]->{1,9}(b) RETURN b",
    "MATCH (a)-[:R]->+(b) RETURN b",
    "MATCH (n) RETURN n LIMIT 5000",
    "LOAD CSV FROM 'x' AS r RETURN r",
    "RETURN apoc.version()",
  ])
    assert.equal(guardCypher(q).ok, false, q);
});

test("every recorded query that ran passed the guard", () => {
  for (const r of answers.results)
    for (const m of r.methods) for (const a of m.attempts ?? []) if (!a.run.blocked) assert.ok(guardCypher(a.cypher).ok, `${r.id} ${m.method}`);
});

// ---------------------------------------------------------------- scoring

test("passages find a fact only with its whole chain of supporting sentences", () => {
  const q = questions.find((x) => x.id === "qx7-customers")!;
  const brief = { doc: "atlas-3-brief", text: doc("atlas-3-brief").paragraphs[1] };
  const accounts = { doc: "key-accounts", text: doc("key-accounts").paragraphs[0] };
  assert.equal(scorePassages(q, [accounts]).found, 0, "naming Osterby without the chain proves nothing");
  assert.equal(scorePassages(q, [brief, accounts]).items[0].found, true);
});

test("text scoring finds answer strings, flags outdated values, and recognises a correct count", () => {
  const units = questions.find((x) => x.id === "osterby-units")!;
  assert.deepEqual(scoreText(units, "They run 420 units.").wrong, ["420 units (February, out of date)"]);
  assert.equal(scoreText(units, "510 units").found, 1);
  const count = questions.find((x) => x.id === "varnell-customers")!;
  assert.equal(scoreText(count, '[{"customers":6}]').countRight, true);
  assert.equal(scoreText(count, '[{"customers":16}]').countRight, false);
  assert.equal(scoreEither(scoreText(units, "nothing"), scoreText(units, "510")).found, 1);
});

test("the summary the app and README use agrees with the recorded scores", () => {
  const s = summarize(questions, answers.results);
  assert.equal(s.rows.length, questions.length);
  const tfidf = s.totals.find((t) => t.method === "tfidf")!;
  const sum = answers.results.reduce((n, r) => n + r.methods.find((m) => m.method === "tfidf")!.context.found, 0);
  assert.equal(tfidf.found, sum);
  const qx7 = s.rows.find((r) => r.id === "qx7-customers")!;
  assert.equal(qx7.cells.vector!.found, 0);
  assert.equal(qx7.cells.gold!.found, 4);
});

// ---------------------------------------------------------------- retrieval helpers

test("hybrid entity linking finds entities named in passages", () => {
  const ids = entitiesIn([{ id: "x", doc: "x", title: "x", text: "Pellham Labs uses the Borealis controller", score: 1 }], graph);
  assert.ok(ids.some((id) => id.includes("pellham")) && ids.some((id) => id.includes("borealis")));
});

test("communities are deterministic and only keep groups of three or more", () => {
  const a = communities(graph);
  assert.deepEqual(a, communities(graph));
  assert.ok(a.every((g) => g.length >= 3));
});

// ---------------------------------------------------------------- the ask endpoint

function deps(over: Partial<AskDeps> = {}): AskDeps {
  return {
    graph: () => graph,
    configured: () => true,
    textToCypher: async () => [{ cypher: "MATCH (n) RETURN n.name LIMIT 1", explanation: "x", run: { ok: true, rows: [{ "n.name": "Atlas-3" }], error: null, blocked: false, cypher: "MATCH (n) RETURN n.name LIMIT 1", ms: 1 } }],
    answer: async () => "Atlas-3.",
    ...over,
  };
}
const post = (body: unknown, ip = "1.2.3.4") => new Request("http://x/api/ask", { method: "POST", headers: { "x-forwarded-for": ip, "content-type": "application/json" }, body: JSON.stringify(body) });

test("the ask endpoint validates input and explains when it isn't configured", async () => {
  resetRateLimits();
  assert.equal((await handleAsk(new Request("http://x/api/ask"), deps())).status, 405);
  assert.equal((await handleAsk(post({ question: "hi" }), deps())).status, 400);
  assert.equal((await handleAsk(post({ question: "Which customers use the Atlas-3?" }), deps({ configured: () => false }))).status, 503);
  const ok = await handleAsk(post({ question: "Which customers use the Atlas-3?" }), deps());
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { answer: string }).answer, "Atlas-3.");
});

test("the ask endpoint rate-limits per client and reports a blocked query without running it", async () => {
  resetRateLimits();
  for (let i = 0; i < 3; i++) assert.equal(rateLimit("k", 1000 + i, 3), null);
  assert.match(rateLimit("k", 2000, 3)!, /limit/);
  assert.equal(rateLimit("k", 1000 + 3600_001, 3), null, "the window slides");
  resetRateLimits();
  const blocked = await handleAsk(
    post({ question: "Delete everything in the graph please" }),
    deps({ textToCypher: async () => [{ cypher: "MATCH (n) DETACH DELETE n", explanation: "x", run: { ok: false, rows: [], error: '"DETACH" is not allowed', blocked: true, cypher: "MATCH (n) DETACH DELETE n", ms: 0 } }] }),
  );
  assert.match(((await blocked.json()) as { answer: string }).answer, /blocked by the read-only guard/);
});

// ---------------------------------------------------------------- drawing

test("the layout is deterministic and inside the drawing", () => {
  assert.deepEqual(layoutGraph(graph), readJson("results/layout.json"));
  for (const [x, y] of Object.values(layoutGraph(graph))) assert.ok(x >= 0 && x <= 1000 && y >= 0 && y <= 720);
});

test("labels placed for the whole graph overlap neither each other nor the nodes", () => {
  const layout = layoutGraph(graph);
  const ids = graph.nodes.map((n) => n.id);
  const placed = placeLabels({ pos: (id) => layout[id], names: new Map(graph.nodes.map((n) => [n.id, n.name])), nodes: ids, label: ids, edgePts: [], size: 12, r: 5, view: { x: 0, y: 0, w: 1000, h: 720 } });
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!overlaps(placed[i].box, placed[j].box), `${placed[i].id} / ${placed[j].id}`);
  assert.ok(textWidth("WWW", 10) > textWidth("iii", 10));
});
