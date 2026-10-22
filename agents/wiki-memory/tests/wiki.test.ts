import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildRun, loadSources, loadSteps, playSteps, ROOT } from "../src/build.ts";
import { diffStats, lineDiff } from "../src/diff.ts";
import { forceLayout } from "../src/layout.ts";
import { keysOverlap, lint } from "../src/lint.ts";
import { bm25, chunkSources, checkFacts, tokenize } from "../src/retrieve.ts";
import { applyEdits, buildGraph, buildIndex, currentLines, parsePage, type Wiki } from "../src/wiki.ts";
import { diffHtml, mdLine } from "../client/render.ts";

const page = (slug: string, type: string, body: string, extra = "") =>
  `---\ntype: ${type}\nsummary: ${slug} summary.\nsources: [src-a]\nupdated: 2026-01-01\n${extra}---\n# ${slug}\n\n${body}\n`;

test("parsePage reads front matter, links and claims", () => {
  const p = parsePage(
    "billing-api",
    page(
      "billing-api",
      "entity",
      "Owned by [[payments-team]]; see [[payments-team]] and [[billing-api]].\n\n## Claims\n- ~~`api.limit`: 100 rps (as of 2026-03-16, [[src-a]])~~ superseded by [[src-b]]\n- `api.limit`: 50 rps (as of 2026-04-03, [[src-b]])\n- ~~`api.owner`: X (as of 2026-05-05, [[src-c]])~~ disputed: a draft",
    ),
  );
  assert.equal(p.type, "entity");
  assert.equal(p.path, "entities/billing-api.md");
  assert.deepEqual(p.sources, ["src-a"]);
  // Self-links and duplicates are dropped; links inside claims count.
  assert.deepEqual(p.links, ["payments-team", "src-a", "src-b", "src-c"]);
  assert.deepEqual(
    p.claims.map((c) => [c.key, c.value, c.status]),
    [
      ["api.limit", "100 rps", "superseded"],
      ["api.limit", "50 rps", "current"],
      ["api.owner", "X", "disputed"],
    ],
  );
});

test("parsePage rejects malformed claims and unknown types", () => {
  assert.throws(() => parsePage("x", page("x", "entity", "## Claims\n- api.limit is 50")), /malformed claim/);
  assert.throws(() => parsePage("x", page("x", "widget", "")), /unknown page type/);
});

test("applyEdits does not change the previous wiki", () => {
  const empty: Wiki = new Map();
  const one = applyEdits(empty, [{ slug: "a", text: page("a", "concept", "Text") }]);
  assert.equal(empty.size, 0);
  assert.equal(one.size, 1);
});

test("lineDiff finds the smallest set of changed lines", () => {
  const diff = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n");
  assert.deepEqual(
    diff.map((d) => `${d.op}:${d.text}`),
    ["same:a", "del:b", "add:B", "same:c", "add:d"],
  );
  assert.deepEqual(diffStats(diff), { added: 2, removed: 1 });
  assert.deepEqual(diffStats(lineDiff("", "x\ny")), { added: 2, removed: 0 });
});

test("keysOverlap treats a parent key as describing its children", () => {
  assert.ok(keysOverlap("export.retention", "export.retention.standard"));
  assert.ok(keysOverlap("a.b", "a.b"));
  assert.ok(!keysOverlap("export.retention", "export.retention-days"));
  assert.ok(!keysOverlap("export.retention.standard", "export.retention.enterprise"));
});

test("lint finds contradictions, missing pages, orphans and uncited claims", () => {
  const wiki = applyEdits(new Map(), [
    { slug: "src-a", text: page("src-a", "source", "Mentions [[topic]] and [[ghost]].") },
    { slug: "topic", text: page("topic", "concept", "## Claims\n- `x.y`: 1 (as of 2026-01-01, [[src-a]])\n- `x`: 2 (as of 2026-02-01, [[src-a]])\n- `z`: 3 (as of 2026-02-01, [[src-missing]])") },
    { slug: "lonely", text: page("lonely", "entity", "No one links here.") },
  ]);
  const result = lint(wiki);
  const kinds = result.findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["contradiction", "missing-page", "missing-page", "orphan", "uncited-claim"].sort());
  const contradiction = result.findings.find((f) => f.kind === "contradiction")!;
  assert.equal(contradiction.claims.length, 2);
});

test("retrieval: tokenizer, chunking and BM25 behave as documented", () => {
  assert.deepEqual(tokenize("How long are the Exports kept?"), ["long", "export", "kept"]);
  const chunks = chunkSources([{ file: "f.md", title: "T", date: "2026-01-01", text: "# T\n\n## Head\n\nPara one.\n\nPara two." }]);
  assert.deepEqual(chunks.map((c) => [c.heading, c.text]), [["Head", "Para one."], ["Head", "Para two."]]);
  const ranked = bm25(["the cat sat", "dogs bark loudly", "cat cat cat"], (s) => s, "cat");
  assert.equal(ranked[0].item, "cat cat cat");
  assert.equal(ranked[2].score, 0);
  const facts = checkFacts([{ kind: "wrong", label: "old", pattern: /allows 100/i }], [{ id: "a", text: "it\nallows   100 rps" }]);
  assert.deepEqual(facts[0].where, ["a"]);
});

test("the layout is deterministic, in bounds and spaced", () => {
  const states = playSteps(loadSteps());
  const graph = buildGraph(states[states.length - 1]);
  const a = forceLayout(graph);
  assert.deepEqual(forceLayout(graph), a);
  for (const { x, y } of Object.values(a)) {
    assert.ok(x >= 0.08 && x <= 0.92 && y >= 0.1 && y <= 0.9);
  }
});

// ---------------------------------------------------------------- the recorded run

const run = buildRun();

test("results/run.json is up to date with the corpus (run `npm run data` after editing corpus/ or src/)", () => {
  const committed = JSON.parse(readFileSync(join(ROOT, "results", "run.json"), "utf8"));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(run)));
});

test("every corpus page follows the schema", () => {
  const states = playSteps(loadSteps());
  for (const wiki of states) {
    for (const p of wiki.values()) {
      for (const c of p.claims) assert.ok(c.source.startsWith("src-"), `${p.slug}: claim cites ${c.source}`);
      if (p.type === "source") assert.equal(p.claims.length, 0, `${p.slug}: claims belong on topic pages`);
      assert.match(p.updated, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  assert.equal(loadSources().length, 5);
});

test("the run tells the story the article describes", () => {
  const ingests = run.steps.filter((s) => s.kind === "ingest");
  assert.equal(ingests.length, 5);
  // Every ingest writes a source page plus at least one other page.
  for (const s of ingests) {
    assert.ok(s.changes.some((c) => c.type === "source" && c.status === "created"));
    assert.ok(s.changes.length >= 4, `${s.title} touches ${s.changes.length} pages`);
  }
  // The incident report supersedes two claims.
  assert.equal(ingests[2].claims.superseded, 2);
  // Lint before the fix: two contradictions and one missing page; after: nothing.
  assert.deepEqual(
    run.lintBefore.checks.map((c) => c.count),
    [2, 1, 0, 0],
  );
  assert.equal(run.lintAfter.findings.length, 0);
  assert.ok(run.lintBefore.findings.some((f) => f.kind === "missing-page" && f.title.includes("jun-park")));
});

test("step 3: the wiki pages hold the current facts and no outdated statement", () => {
  for (const q of run.questions) {
    assert.ok(q.wikiFacts.filter((f) => f.kind === "needed").every((f) => f.found), `${q.id}: wiki misses a fact`);
    assert.ok(q.wikiFacts.filter((f) => f.kind === "wrong").every((f) => !f.found), `${q.id}: wiki states something outdated`);
  }
  const byId = Object.fromEntries(run.questions.map((q) => [q.id, q]));
  // Chunk RAG retrieves outdated statements for the two questions whose answer changed over time...
  assert.equal(byId.retention.ragFacts.filter((f) => f.kind === "wrong" && f.found).length, 2);
  assert.equal(byId.rate.ragFacts.filter((f) => f.kind === "wrong" && f.found).length, 2);
  // ...and does as well as the wiki when one source holds the whole answer.
  assert.ok(byId.incident.ragFacts.every((f) => f.found));
});

test("the index lists every page and the log has one entry per step", () => {
  const last = run.steps[run.steps.length - 1];
  for (const p of last.pages) assert.ok(last.index.includes(`[[${p.slug}]]`));
  const entries = last.log.split("\n").filter((l) => /^## \[\d{4}-\d{2}-\d{2}\] (ingest|lint|query) \| /.test(l));
  assert.equal(entries.length, run.steps.length);
  // The wiki-side retrieval never reads struck-through claims as current.
  const states = playSteps(loadSteps());
  const retention = states[states.length - 1].get("export-retention")!;
  assert.ok(!currentLines(retention).some((l) => l.includes("~~")));
  assert.equal(buildIndex(new Map()), "# Index\n");
});

test("render helpers escape HTML and fold long unchanged runs", () => {
  assert.equal(mdLine("<b>"), "&lt;b&gt;");
  assert.match(mdLine("see [[a-b]]"), /md-link/);
  const diff = lineDiff(Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"), [...Array.from({ length: 11 }, (_, i) => `l${i}`), "changed"].join("\n"));
  assert.match(diffHtml(diff), /unchanged lines/);
});
