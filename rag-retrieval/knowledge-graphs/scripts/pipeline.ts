// The pipeline, step by step. A dry run unless --live is given.
//
//   npm run pipeline -- extract --live --runs 3   extract every document 3 times (paid)
//   npm run pipeline -- variation                compare the extraction runs (offline)
//   npm run pipeline -- resolve --live           entity resolution: rules, embeddings, LLM check (paid)
//   npm run pipeline -- load                     load results/graph.json into Neo4j; no model calls (--rebuild: rebuild it offline first)
//   npm run pipeline -- ask --live               every question, every method (paid, needs Neo4j)
//   npm run pipeline -- costs                    total the ledger into results/costs.json (offline)
//   npm run pipeline -- site                     write the corpus and the graph layout for the app (offline)
//
// Raw model responses go to the Git-ignored runs/; cleaned results go to results/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus, ROOT } from "../src/load-corpus.ts";
import { extractRun, type ExtractionRun } from "../src/pipeline/extract.ts";
import { variation } from "../src/pipeline/variation.ts";
import { clusterByRules } from "../src/resolve.ts";
import { goldAnyType } from "../src/gold.ts";
import { buildGraph } from "../src/graph.ts";
import type { Cluster } from "../src/resolve.ts";
import { closeDb, loadGraph } from "../src/pipeline/neo4j.ts";
import { askAll, graphAnswer, judge, type QuestionResult } from "../src/pipeline/ask.ts";
import { scoreEither, scorePassages, scoreText } from "../src/score.ts";
import type { Graph } from "../src/graph.ts";
import { layoutGraph } from "../src/layout.ts";
import type { Question } from "../src/score.ts";
import { PRICES, type CallUsage } from "../src/pipeline/gemini.ts";
import { applyReview, evaluate, mentionsOf, resolveRun, type Resolution, type ReviewDecision } from "../src/pipeline/resolve-run.ts";

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // No .env: replay and offline steps still work.
}

const args = process.argv.slice(2);
const step = args[0];
const live = args.includes("--live");
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const results = (...p: string[]) => join(ROOT, "results", ...p);
const save = (path: string, data: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`);
};
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function main() {
  const docs = loadCorpus();
  switch (step) {
    case "extract": {
      const runs = Number(opt("runs", "1"));
      const first = Number(opt("first", "1"));
      if (!live) {
        console.log(`Dry run: would make ${docs.length * runs} Gemini calls (${docs.length} documents × ${runs} runs) with ${process.env.GEMINI_MODEL || "gemini-3.8-flash"}.`);
        console.log("Estimated cost: about $0.01 per document per run. Add --live to run.");
        return;
      }
      for (let r = first; r < first + runs; r++) {
        const runId = `extract-${r}-${stamp()}`;
        console.log(`Extraction run ${r} (${runId})`);
        const out: ExtractionRun = await extractRun(docs, r, runId);
        save(results("extraction", `run-${r}.json`), out);
      }
      return;
    }
    case "variation": {
      const runs = [1, 2, 3].filter((r) => existsSync(results("extraction", `run-${r}.json`))).map((r) => read<ExtractionRun>(results("extraction", `run-${r}.json`)));
      const v = variation(runs);
      save(results("variation.json"), v);
      console.log(JSON.stringify({ runs: v.runs, pairs: v.pairs, union: v.union, inAll: v.inAll, inOne: v.inOne }, null, 1));
      return;
    }
    case "resolve": {
      const run = read<ExtractionRun>(results("extraction", `run-${opt("run", "1")}.json`));
      if (!live && existsSync(results("resolution.json"))) {
        // Re-score the saved LLM stage and apply the person's review (data/review.json). No API calls.
        const saved = read<Resolution>(results("resolution.json"));
        const llmOnly = saved.clusters.map((c) => ({ ...c, members: c.members.filter((m) => m.how !== "person: approved") }));
        const before = evaluate(llmOnly, run);
        const review = read<{ decisions: ReviewDecision[] }>(join(ROOT, "data", "review.json")).decisions;
        const reviewed = applyReview(llmOnly, review);
        const after = evaluate(reviewed, run);
        // Counterfactual: the same rules without the type guard (every name treated as one type).
        const untyped = clusterByRules(mentionsOf(run).map((m) => ({ ...m, type: "Any" })));
        const withoutTypeGuard = untyped.clusters
          .filter((c) => new Set(c.members.map((m) => goldAnyType(m.name)?.name).filter(Boolean)).size > 1)
          .map((c) => ({ cluster: c.name, members: c.members.map((m) => ({ name: m.name, gold: goldAnyType(m.name)?.name ?? null, goldType: goldAnyType(m.name)?.type ?? null })) }));
        save(results("resolution.json"), { ...saved, clusters: llmOnly, evaluation: before, review, reviewed: { clusters: reviewed, evaluation: after }, withoutTypeGuard, ambiguousWithoutTypeGuard: untyped.ambiguous });
        console.log(`Without the type guard, the rules would make ${withoutTypeGuard.length} false merges: ${withoutTypeGuard.map((w) => w.members.map((m) => m.name).join(" + ")).join("; ")}`);
        console.log(`Before review: ${before.clusters} entities, ${before.falseSplits.length} false splits, ${before.falseMerges.length} false merges.`);
        console.log(`After review: ${after.clusters} entities, ${after.falseSplits.length} false splits, ${after.falseMerges.length} false merges; unmapped ${after.unmapped.length}, type errors ${after.typeErrors.length}.`);
        return;
      }
      if (!live) {
        const { clusters, ambiguous } = clusterByRules(mentionsOf(run));
        const e = evaluate(clusters, run);
        console.log(`Dry run: rules alone give ${clusters.length} clusters from ${e.surfaces} names; ${e.falseSplits.length} false splits, ${e.falseMerges.length} false merges, ${ambiguous.length} ambiguous.`);
        console.log("Add --live to embed the names and ask Gemini about close pairs (about $0.02).");
        return;
      }
      const r = await resolveRun(run, docs);
      save(results("resolution.json"), r);
      const e = r.evaluation;
      console.log(`${e.clusters} entities from ${e.surfaces} names. LLM checked ${r.pairs.filter((p) => p.decision !== "not checked").length} pairs: ${r.pairs.filter((p) => p.decision === "same").length} same, ${r.queue.length} unsure (for a person).`);
      console.log(`False merges: ${e.falseMerges.length}; false splits: ${e.falseSplits.length}; unmapped names: ${e.unmapped.length}; type errors: ${e.typeErrors.length}.`);
      return;
    }
    case "load": {
      // No model calls: loads the committed results/graph.json into whatever NEO4J_* points at
      // (Docker, or AuraDB with a neo4j+s:// URI). --rebuild first rebuilds it from run 1 and
      // the reviewed resolution, offline.
      let graph: Graph;
      if (args.includes("--rebuild")) {
        const run = read<ExtractionRun>(results("extraction", "run-1.json"));
        const resolution = read<Resolution & { reviewed: { clusters: Cluster[] } }>(results("resolution.json"));
        const dateOf = new Map(docs.map((d) => [d.id, d.date]));
        graph = buildGraph(run.runId, resolution.reviewed.clusters, run.docs.map((d) => ({ doc: d.doc, date: dateOf.get(d.doc)!, triples: d.triples })));
        save(results("graph.json"), graph);
      } else graph = read<Graph>(results("graph.json"));
      console.log(`Graph: ${graph.nodes.length} entities, ${graph.edges.length} edges.`);
      const counts = await loadGraph(graph);
      console.log(`Loaded into Neo4j at ${process.env.NEO4J_URI}: ${counts.nodes} nodes, ${counts.edges} relationships.`);
      await closeDb();
      return;
    }
    case "ask": {
      const questions = read<Question[]>(join(ROOT, "data", "questions.json"));
      if (!live) {
        console.log(`Dry run: ${questions.length} questions. Would embed ${docs.reduce((n, d) => n + d.paragraphs.length, 0)} paragraphs and ${questions.length} questions, summarise the graph's communities, write Cypher for each question (plus one repair when needed), write answers for 3 methods per question, and judge the global question (about 75 calls, about $0.40). Needs Neo4j running.`);
        return;
      }
      const graph = read<Graph>(results("graph.json"));
      const out = await askAll({ questions, docs, graph });
      const round = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);
      save(results("answers.json"), { model: process.env.GEMINI_MODEL || "gemini-3.8-flash", embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2", k: 3, at: new Date().toISOString(), summaries: out.summaries, results: out.results });
      save(join(ROOT, "runs", "embeddings.json"), { model: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2", dimensions: 768, chunks: out.chunkVectors.map(round), questions: out.questionVectors.map(round) });
      await closeDb();
      return;
    }
    case "costs": {
      const lines = readFileSync(join(ROOT, "runs", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CallUsage & { at: string });
      const bySteps = new Map<string, { calls: number; input: number; output: number; thought: number; cost: number }>();
      for (const l of lines) {
        const key = l.step.startsWith("extract-run") ? "extract" : l.step;
        const s = bySteps.get(key) ?? { calls: 0, input: 0, output: 0, thought: 0, cost: 0 };
        s.calls++;
        s.input += l.input;
        s.output += l.output;
        s.thought += l.thought;
        s.cost += l.cost;
        bySteps.set(key, s);
      }
      const steps = [...bySteps].map(([step, s]) => ({ step, ...s, cost: Math.round(s.cost * 10000) / 10000 }));
      const total = { calls: lines.length, cost: Math.round(lines.reduce((t, l) => t + l.cost, 0) * 10000) / 10000, input: lines.reduce((t, l) => t + l.input, 0), output: lines.reduce((t, l) => t + l.output + l.thought, 0) };
      save(results("costs.json"), { prices: PRICES, steps, total, note: "Every call in runs/ledger.jsonl, including the smoke test and any reruns. Output includes thinking tokens." });
      console.log(JSON.stringify({ steps, total }, null, 1));
      return;
    }
    case "site": {
      // Offline: the corpus and the drawing layout, for the app.
      const graph = read<Graph>(results("graph.json"));
      save(results("corpus.json"), docs);
      save(results("layout.json"), layoutGraph(graph));
      console.log(`Wrote results/corpus.json (${docs.length} documents) and results/layout.json (${graph.nodes.length} positions).`);
      return;
    }
    case "rescore": {
      // Offline: re-score every recorded context and answer with the current scoring code.
      const questions = read<Question[]>(join(ROOT, "data", "questions.json"));
      const answers = read<{ results: QuestionResult[] }>(results("answers.json"));
      for (const r of answers.results) {
        const q = questions.find((x) => x.id === r.id)!;
        for (const m of r.methods) {
          if (m.passages && m.method !== "hybrid") m.context = scorePassages(q, m.passages);
          if (m.method === "cypher" || m.method === "gold") m.context = scoreText(q, JSON.stringify(m.rows ?? []));
          if (m.method === "hybrid") m.context = scoreEither(scorePassages(q, m.passages ?? []), scoreText(q, (m.edges ?? []).map((e) => `${e.from} ${e.rel} ${e.to} ("${e.quote}")`).join("\n")));
          if (m.answer) m.answerScore = scoreText(q, m.answer);
          if (m.firstTry) m.firstTry.answerScore = scoreText(q, m.firstTry.answer);
        }
      }
      save(results("answers.json"), answers);
      console.log("Re-scored results/answers.json.");
      return;
    }
    case "reanswer": {
      // Regenerate the answers written from query rows, with the query beside the rows. Keeps the first try.
      if (!live) {
        console.log("Dry run: would rewrite 15 answers from the recorded query rows (15 calls, about $0.02) and re-judge the global question. Add --live.");
        return;
      }
      const questions = read<Question[]>(join(ROOT, "data", "questions.json"));
      const answers = read<{ results: QuestionResult[] }>(results("answers.json"));
      for (const r of answers.results) {
        const q = questions.find((x) => x.id === r.id)!;
        const m = r.methods.find((x) => x.method === "cypher")!;
        if (!m.firstTry) m.firstTry = { answer: m.answer!, answerScore: m.answerScore!, note: "Written from the rows alone, under the same instruction as passages (\"use only this context\"). Without the query, the model could not tell what the rows meant." };
        m.answer = await graphAnswer(`${q.id} cypher`, q.question, m.attempts![m.attempts!.length - 1]);
        m.answerScore = scoreText(q, m.answer);
        if (q.judge) m.judge = await judge(q, m.answer, `${q.id} cypher`);
        console.log(`  ${q.id}: ${m.firstTry.answerScore.found}/${m.firstTry.answerScore.of} → ${m.answerScore.found}/${m.answerScore.of}`);
      }
      save(results("answers.json"), answers);
      return;
    }
    default:
      console.log("Steps: extract, variation, resolve, load, ask, costs. See the header of scripts/pipeline.ts.");
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]"));
  process.exit(1);
});
