// The page and the article: in-page anchors resolve, the article renders the README,
// and the numbers the page and the README show agree with the recorded results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "../src/load-corpus.ts";
import { renderArticle, REPO, slug } from "../scripts/article.ts";
import { productionRows } from "../client/sections.ts";
import { summarize } from "../src/summary.ts";
import type { Question } from "../src/score.ts";
import type { QuestionResult } from "../src/pipeline/ask.ts";

const html = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const clientSource = ["sections.ts", "walkthrough.ts", "app.ts", "explain.ts"].map((f) => readFileSync(join(ROOT, "client", f), "utf8")).join("\n");

test("every in-page anchor in the page and the rendered sections points at an element", () => {
  const hrefs = [...html.matchAll(/href="#([^"]*)"/g), ...clientSource.matchAll(/href[=:]\s*"#([^"$]+)"/g)].map((m) => m[1]);
  for (const r of productionRows()) if (r.demo) hrefs.push(r.demo.href.slice(1));
  assert.ok(hrefs.length >= 10);
  for (const h of hrefs) assert.ok(ids.has(h), `#${h} has no element`);
});

test("the page has its sections in order, and the nav links to the local article", () => {
  const order = [...html.matchAll(/<section[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["problem", "idea", "theatre", "payoff", "query", "loses", "extraction", "roles", "production", "recap", "about"]);
  assert.match(html, /<a class="nav" href="article">Article<\/a>/);
  assert.match(html, /Full article on GitHub/);
});

test("the article renders the README: heading ids, Mermaid as source, links to the repository", () => {
  const out = renderArticle(readme);
  const headingIds = new Set([...out.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of readme.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(headingIds.has(m[1]), `README anchor #${m[1]} has no heading`);
  assert.ok(headingIds.has(slug("Taking it to production")));
  assert.match(out, /Diagram \(Mermaid source\)/);
  assert.doesNotMatch(out, /class="mermaid"/);
  assert.match(out, new RegExp(`href="${REPO}/corpus/"`));
  assert.match(out, /Full article on GitHub/);
});

test("the README's results table agrees with the recorded scores", () => {
  const s = summarize(readJson<Question[]>("data/questions.json"), readJson<{ results: QuestionResult[] }>("results/answers.json").results);
  const row = readme.split("\n").find((l) => l.startsWith("| **All questions** |"))!;
  const cells = [...row.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)].map((m) => `${m[1]}/${m[2]}`);
  assert.deepEqual(cells, s.totals.map((t) => `${t.found}/${t.of}`));
  const complete = readme.split("\n").find((l) => l.startsWith("| Questions complete |"))!;
  assert.deepEqual([...complete.matchAll(/(\d+) of (\d+)/g)].map((m) => `${m[1]}/${m[2]}`), s.totals.map((t) => `${t.complete}/${t.questions}`));
  const costs = readJson<{ total: { calls: number; cost: number } }>("results/costs.json");
  assert.match(readme, new RegExp(`\\*\\*${costs.total.calls}\\*\\* \\| \\*\\*\\$${costs.total.cost.toFixed(2)}\\*\\*`));
});

test("the production table covers the nine problems", () => {
  assert.deepEqual(
    productionRows().map((r) => r.problem),
    ["Extraction quality and cost", "Schema design and change", "Entity resolution errors", "Stale facts and provenance", "Text-to-Cypher safety", "Graph size and query latency", "Global questions", "Hybrid vector + graph retrieval", "Permissions"],
  );
});

test("the static export has no ask endpoint, and the page explains why when asking fails", () => {
  const exportScript = readFileSync(join(ROOT, "scripts", "export.ts"), "utf8");
  assert.doesNotMatch(exportScript, /api/);
  assert.match(clientSource, /the published site only replays the recorded runs/);
});

test("the prompt the page shows is the one the code sends, and each linked line produced its piece of the recorded query", async () => {
  const { cypherSystem } = await import("../src/cypher-prompt.ts");
  const { PROMPT_LINKS, promptParts } = await import("../client/explain.ts");
  const graph = readJson<Parameters<typeof cypherSystem>[0]>("results/graph.json");
  const prompt = cypherSystem(graph);
  const parts = promptParts(prompt);
  assert.equal(parts.length, 4);
  assert.equal(parts.map((p) => p.text).join("\n\n"), prompt.trim());
  const ex = readJson<{ attempts: { cypher: string }[] }>("results/query-example.json");
  const cypher = ex.attempts[ex.attempts.length - 1].cypher;
  for (const link of PROMPT_LINKS) {
    const lines = prompt.split("\n").filter(link.line);
    assert.equal(lines.length, 1, `prompt line ${link.n}`);
    assert.ok(cypher.includes(link.query), `query piece ${link.n}`);
    assert.ok(readme.includes(lines[0].length > 120 ? lines[0].slice(0, 60) : lines[0]), `README quotes prompt line ${link.n}`);
  }
  assert.ok(readme.includes(cypher.split("\n")[0]));
});

test("the extraction section's numbers come from the recorded results", async () => {
  const { goldMisses } = await import("../src/summary.ts");
  const m = goldMisses(readJson<Question[]>("data/questions.json"), readJson<{ results: QuestionResult[] }>("results/answers.json").results);
  const gold = summarize(readJson<Question[]>("data/questions.json"), readJson<{ results: QuestionResult[] }>("results/answers.json").results).totals.find((t) => t.method === "gold")!;
  assert.equal(gold.of - gold.found, m.scored.length);
  assert.match(readme, new RegExp(`missed ${m.scored.length} of ${gold.of} facts`));
  const v = readJson<{ union: number; inAll: number; inOne: number }>("results/variation.json");
  assert.match(readme, new RegExp(`${v.inAll} of ${v.union} appeared in all three runs, ${v.inOne} in only one`));
});
