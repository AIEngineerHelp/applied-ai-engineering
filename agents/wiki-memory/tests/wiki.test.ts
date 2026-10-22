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

test("tracked changes: a superseded claim becomes one struck block, edits become word-level changes", async () => {
  const { trackedBlocks, wordDiff } = await import("../client/doc.ts");
  const step = run.steps[2];
  const billing = step.changes.find((c) => c.slug === "billing-api")!;
  const blocks = trackedBlocks(billing.diff);
  const strike = blocks.filter((b) => b.change === "strike");
  assert.equal(strike.length, 1);
  assert.match(strike[0].html, /100 requests per second per client/);
  assert.ok(blocks.some((b) => b.change === "ins" && /50 requests per second/.test(b.html)));
  // Front matter is never shown as a change.
  assert.ok(!blocks.some((b) => /^sources:|^updated:/.test(b.html)));
  assert.equal(wordDiff("kept for 30 days", "kept for 90 days"), "kept for <del>30</del><ins>90</ins> days");
});

test("source links: every quote is verbatim in the step's raw source, and every anchor finds an edit", async () => {
  const { trackedBlocks } = await import("../client/doc.ts");
  const sources = new Map(loadSources().map((s) => [s.file, s.text]));
  let count = 0;
  for (const step of run.steps) {
    for (const link of step.links ?? []) {
      const raw = sources.get(step.source ?? "");
      assert.ok(raw, `step ${step.n} has links but no source`);
      for (const q of link.quotes) {
        assert.ok(raw!.split("\n").some((line) => line.includes(q)), `step ${step.n}: quote not found verbatim on one line of raw/${step.source}: "${q}"`);
        count++;
      }
      const change = step.changes.find((c) => c.slug === link.page);
      assert.ok(change, `step ${step.n}: ${link.page} is not changed in this step`);
      const blocks = trackedBlocks(change!.diff).filter((b) => b.change !== "same");
      for (const a of link.anchors) assert.ok(blocks.some((b) => b.raw.includes(a)), `step ${step.n}: anchor "${a}" matches no edit on ${link.page}`);
    }
  }
  assert.ok(count >= 10);
  // Every ingest step explains its focus page's edits.
  for (const step of run.steps.filter((s) => s.kind === "ingest")) assert.ok((step.links ?? []).some((l) => l.page === step.focus), `step ${step.n} has no links for ${step.focus}`);
});

test("an answered open question is struck through with a note, not deleted", async () => {
  const { trackedBlocks } = await import("../client/doc.ts");
  const billing = run.steps[1].changes.find((c) => c.slug === "billing-api")!;
  const blocks = trackedBlocks(billing.diff);
  const q = blocks.find((b) => b.raw.includes("What request rate may Ledger Export use?"))!;
  assert.equal(q.change, "strike");
  assert.match(q.html, /Answered by/);
  assert.ok(!blocks.some((b) => b.change === "del" && b.raw.includes("What request rate")));
});

test("scene clock: one speed multiplier scales every scheduled time and keeps position on change", async () => {
  const { SceneClock, parseSpeed } = await import("../client/clock.ts");
  let wall = 1000;
  const now = () => wall;
  // An edit scheduled at script time 2300 ms (for example "highlight at 1800, edit 500 ms later").
  const editAt = 2300;
  const normal = new SceneClock(now, 1);
  const slow = new SceneClock(now, 0.5);
  assert.equal(normal.wallUntil(editAt), 2300);
  assert.equal(slow.wallUntil(editAt), 4600);
  // The highlight-to-edit gap (500 ms of script time) also doubles.
  assert.equal(slow.wallUntil(editAt) - slow.wallUntil(1800), 2 * (normal.wallUntil(editAt) - normal.wallUntil(1800)));

  // Mid-scene change: no jump in position, then the new rate applies.
  const c = new SceneClock(now, 1);
  wall += 1200;
  assert.equal(c.time(), 1200);
  c.setSpeed(0.5);
  assert.equal(c.time(), 1200);
  wall += 1000;
  assert.equal(c.time(), 1700);
  c.setSpeed(1.5);
  wall += 200;
  assert.equal(c.time(), 2000);
  c.restart();
  assert.equal(c.time(), 0);

  assert.equal(parseSpeed("0.75"), 0.75);
  assert.equal(parseSpeed("2"), null);
  assert.equal(parseSpeed(null), null);
});

test("walkthrough text: key sentences are verbatim, every step says what the agent did, and shows a changed page", () => {
  const sources = new Map(loadSources().map((s) => [s.file, s.text]));
  for (const step of run.steps) {
    assert.ok(step.lede.length > 20, `step ${step.n} has no lede`);
    assert.ok(step.did.length >= 1 && step.did.length <= 3, `step ${step.n}: 1 to 3 bullets`);
    assert.ok(step.changes.some((c) => c.slug === step.show), `step ${step.n}: ${step.show} is not changed in this step`);
    if (step.kind === "ingest") {
      assert.ok(step.key.length >= 1 && step.key.length <= 3, `step ${step.n}: 1 to 3 key sentences`);
      for (const q of step.key) assert.ok(sources.get(step.source!)!.split("\n").some((l) => l.includes(q)), `step ${step.n}: "${q}" is not verbatim in raw/${step.source}`);
    }
  }
});

test("resolver: rank wins, newer wins within a rank, scopes are separate, ties are disputed", async () => {
  const { resolveScope, resolveAll } = await import("../src/resolve.ts");
  const ranking = [
    { rank: 3, types: ["policy"], note: "" },
    { rank: 2, types: ["design doc", "runbook"], note: "" },
    { rank: 1, types: ["draft"], note: "" },
  ];
  const f = (value: string, sourceType: string, date: string, scope = "all", source = `${sourceType}-${date}`) => ({ key: "k", value, scope, source, sourceType, date, quote: "" });
  // Ranking order beats recency.
  let r = resolveScope([f("7", "draft", "2026-05-05"), f("30", "policy", "2026-01-01")], ranking, "k", "all");
  assert.equal(r.status, "current");
  assert.equal(r.current!.value, "30");
  assert.equal(r.lost[0].kind, "outranked");
  // Newer beats older at the same rank.
  r = resolveScope([f("100", "design doc", "2026-03-16"), f("50", "runbook", "2026-04-07")], ranking, "k", "all");
  assert.equal(r.current!.value, "50");
  assert.equal(r.lost[0].kind, "older");
  // Scope separation: a scoped fact doesn't touch other scopes; an "all" fact touches every scope.
  const scoped = [f("90", "policy", "2026-04-20", "enterprise"), f("30", "policy", "2026-04-20", "standard"), f("7", "draft", "2026-05-05")];
  const all = resolveAll(scoped, ranking, { k: { scopes: ["enterprise", "standard"] } });
  assert.deepEqual(all.map((x) => [x.scope, x.current?.value]), [["enterprise", "90"], ["standard", "30"]]);
  // Same rank, same date, different values: disputed, never picked silently.
  r = resolveScope([f("24", "runbook", "2026-05-12", "all", "a"), f("12", "design doc", "2026-05-12", "all", "b"), f("24", "draft", "2026-05-05")], ranking, "k", "all");
  assert.equal(r.status, "disputed");
  assert.deepEqual(r.contenders.map((c) => c.value), ["24", "12"]);
  assert.equal(r.current, null);
  // Same rank, same date, same value: not a dispute.
  r = resolveScope([f("24", "runbook", "2026-05-12", "all", "a"), f("24", "runbook", "2026-05-12", "all", "b")], ranking, "k", "all");
  assert.equal(r.status, "current");
  assert.throws(() => resolveScope([f("1", "tweet", "2026-01-01")], ranking, "k", "all"), /Unknown source type/);
});

test("resolver on the corpus: retention resolves by scope and authority; the max range is disputed", async () => {
  const { renderConflictsHtml } = await import("../client/conflicts.ts");
  const c = run.conflicts;
  const byScope = Object.fromEntries(c.results.map((x) => [`${x.key}/${x.scope}`, x]));
  assert.equal(byScope["export.retention/enterprise"].current!.value, "90 days");
  assert.equal(byScope["export.retention/standard"].current!.value, "30 days");
  for (const s of ["enterprise", "standard"]) {
    const draft = byScope[`export.retention/${s}`].lost.find((l) => l.fact.sourceType === "draft")!;
    assert.equal(draft.kind, "outranked");
  }
  const range = byScope["export.max-range/all"];
  assert.equal(range.status, "disputed");
  assert.deepEqual(range.contenders.map((x) => x.value).sort(), ["12 months", "24 months"]);
  // Every quoted sentence exists verbatim in its source (raw/ or review/).
  const texts = new Map<string, string>([...loadSources().map((s) => [`raw/${s.file}`, s.text] as const), ...c.reviewSources.map((s) => [`review/${s.file}`, s.text] as const)]);
  for (const f of c.facts) assert.ok(texts.get(f.source)?.split("\n").some((l) => l.includes(f.quote)), `quote not verbatim in ${f.source}: ${f.quote}`);
  // What the app displays agrees with the resolver.
  const html = renderConflictsHtml(c);
  assert.match(html, /90 days/);
  assert.match(html, /Needs a person/);
  assert.match(html, /12 months/);
  assert.equal((html.match(/data-status="disputed"/g) ?? []).length, 1);
  assert.equal((html.match(/data-status="current"/g) ?? []).length, 2);
});

test("production section covers all eight areas, and every in-page link resolves", async () => {
  const { PRODUCTION, renderProductionHtml } = await import("../client/production.ts");
  const { renderConflictsHtml } = await import("../client/conflicts.ts");
  const areas = ["Big documents", "A wiki too big to read", "Conflicting facts", "Mistakes and drift", "Many documents at once", "Cost", "Deleted documents and permissions", "Combining with RAG and knowledge graphs"];
  assert.deepEqual(PRODUCTION.map((r) => r.problem), areas);
  for (const r of PRODUCTION) assert.ok(r.wrong.length > 20 && r.handle.length > 40, r.problem);
  // Every #anchor in the page and in generated sections points to an id that exists in the page.
  const page = readFileSync(join(ROOT, "site", "index.html"), "utf8");
  const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const html = page + renderProductionHtml() + renderConflictsHtml(run.conflicts);
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.includes("production") && anchors.includes("conflicts"));
  for (const a of anchors) assert.ok(ids.has(a), `#${a} has no target`);
  // The article page renders the README with heading ids for the anchors it links to.
  const { renderArticle } = await import("../scripts/article.ts");
  const article = renderArticle(readFileSync(join(ROOT, "README.md"), "utf8"));
  const articleIds = new Set([...article.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of article.matchAll(/href="#([^"]+)"/g)) assert.ok(articleIds.has(m[1]), `article #${m[1]} has no target`);
  assert.ok(articleIds.has("taking-it-to-production"));
});
