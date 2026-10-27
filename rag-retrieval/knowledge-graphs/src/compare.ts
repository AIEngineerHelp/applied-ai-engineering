// Answer one question three ways and check each against the facts the
// correct answer needs:
//
//   chunks  top-k paragraphs by TF-IDF similarity (the vector-RAG stand-in)
//   graph   the question's traversal over the extracted graph
//   hybrid  the graph's edges, plus the paragraphs those edges were extracted
//           from, plus the top-k chunks
//
// A fact counts as retrieved by chunk search when a returned paragraph
// contains the sentence that states it, and by the graph when the traversal
// returned the edge for it. Facts that were never extracted as an edge (a
// recommendation, a reason, a number in prose) can only come from text.

import { findByName, followPattern, linkEntities, neighbourhood, shortestPath, type Graph, type Hop, type Step } from "./graph.ts";
import type { Chunk, Hit, TfIdfIndex } from "./retrieve.ts";
import type { RelationType } from "./schema.ts";

export type Strategy =
  | { type: "pattern"; start: string; steps: Step[]; count?: boolean }
  | { type: "path"; from: string; to: string }
  | { type: "neighbourhood"; around: string; depth: number };

export interface Fact {
  label: string;
  evidence: string; // the sentence in the corpus that states it
  triple?: [string, RelationType, string]; // the edge that represents it, if one was extracted
}

export interface Question {
  id: string;
  kind: string;
  question: string;
  answer: string;
  strategy: Strategy;
  cypher: string;
  expected: string[];
  facts: Fact[];
}

export interface FactResult extends Fact {
  chunk: string | null; // id of the paragraph that states it
  edge: string | null; // id of the edge that represents it
  rank: number | null; // where chunk search ranked that paragraph (1 = first)
  score: number | null; // and its similarity to the question
  byChunks: boolean;
  byGraph: boolean;
  byHybrid: boolean;
}

export type Outcome = "complete" | "partial" | "missed";

export interface Comparison {
  question: Question;
  linked: string[]; // entity ids found in the question text
  hops: Hop[]; // graph result, in the order to light them up
  answerIds: string[]; // graph answer entities
  hits: Hit[]; // chunk result
  hybridChunks: string[];
  facts: FactResult[];
  outcome: { chunks: Outcome; graph: Outcome; hybrid: Outcome };
  verdict: { winner: "graph" | "chunks" | "both" | "neither"; headline: string; detail: string };
}

const outcome = (n: number, of: number): Outcome => (n === of ? "complete" : n === 0 ? "missed" : "partial");

function idOf(g: Graph, name: string): string {
  const e = findByName(g, name);
  if (!e) throw new Error(`No entity named "${name}" in the graph`);
  return e.id;
}

/** Run the question's graph strategy. */
export function traverse(g: Graph, s: Strategy): { hops: Hop[]; answerIds: string[] } {
  if (s.type === "pattern") {
    const { paths, ends } = followPattern(g, idOf(g, s.start), s.steps);
    // Light hops up level by level: every first hop, then every second hop...
    const hops: Hop[] = [];
    const seen = new Set<string>();
    for (let level = 0; level < s.steps.length; level++) {
      for (const p of paths) {
        const h = p[level];
        if (h && !seen.has(`${h.edge.id}>${h.to}`)) {
          seen.add(`${h.edge.id}>${h.to}`);
          hops.push(h);
        }
      }
    }
    return { hops, answerIds: ends };
  }
  if (s.type === "path") {
    const hops = shortestPath(g, idOf(g, s.from), idOf(g, s.to)) ?? [];
    return { hops, answerIds: hops.length ? [hops[0].from, ...hops.map((h) => h.to)] : [] };
  }
  const hops = neighbourhood(g, [idOf(g, s.around)], s.depth);
  return { hops, answerIds: [] };
}

export function compare(g: Graph, index: TfIdfIndex, q: Question, k = 3): Comparison {
  const linked = linkEntities(g, q.question);
  const { hops, answerIds } = traverse(g, q.strategy);
  const ranking = index.search(q.question, index.chunks.length);
  const hits = ranking.slice(0, k);
  const chunkOf = (sentence: string): Chunk | undefined => index.chunks.find((c) => c.text.includes(sentence));

  const returnedEdges = new Set(hops.map((h) => h.edge.id));
  const hitIds = new Set(hits.map((h) => h.chunk.id));
  // Hybrid: the paragraphs each returned edge was extracted from, plus the top-k chunks.
  const hybrid = new Set(hitIds);
  for (const h of hops) for (const ev of h.edge.evidence) {
    const c = chunkOf(ev.text);
    if (c) hybrid.add(c.id);
  }

  const facts: FactResult[] = q.facts.map((f) => {
    const chunk = chunkOf(f.evidence)?.id ?? null;
    let edge: string | null = null;
    if (f.triple) {
      const [s, rel, t] = f.triple;
      const se = findByName(g, s);
      const te = findByName(g, t);
      if (se && te) edge = g.edges.find((e) => e.source === se.id && e.type === rel && e.target === te.id)?.id ?? null;
    }
    const byChunks = chunk !== null && hitIds.has(chunk);
    const byGraph = edge !== null && returnedEdges.has(edge);
    const at = ranking.findIndex((h) => h.chunk.id === chunk);
    const rank = at === -1 ? null : at + 1;
    const score = at === -1 ? null : ranking[at].score;
    return { ...f, chunk, edge, rank, score, byChunks, byGraph, byHybrid: byGraph || (chunk !== null && hybrid.has(chunk)) };
  });

  const count = (key: "byChunks" | "byGraph" | "byHybrid") => facts.filter((f) => f[key]).length;
  const result = {
    chunks: outcome(count("byChunks"), facts.length),
    graph: outcome(count("byGraph"), facts.length),
    hybrid: outcome(count("byHybrid"), facts.length),
  };
  return { question: q, linked, hops, answerIds, hits, hybridChunks: [...hybrid], facts, outcome: result, verdict: verdict(g, index, facts, result, k) };
}

function verdict(g: Graph, index: TfIdfIndex, facts: FactResult[], o: Comparison["outcome"], k: number): Comparison["verdict"] {
  const n = facts.length;
  const c = facts.filter((f) => f.byChunks).length;
  const gr = facts.filter((f) => f.byGraph).length;
  const title = (id: string | null) => index.chunks.find((x) => x.id === id)?.title ?? "an unextracted passage";
  const missedByChunks = facts.filter((f) => !f.byChunks);
  if (o.graph === "complete" && o.chunks === "complete") {
    return {
      winner: "both",
      headline: "Both find it",
      detail: `Chunk search ranked the passage${n === 1 ? "" : "s"} holding ${n === 1 ? "the fact" : `all ${n} facts`} in its top ${k}, and the graph returned the matching edge${n === 1 ? "" : "s"}. When one passage holds the whole answer, the graph adds extraction cost without adding recall.`,
    };
  }
  if (o.graph === "complete") {
    // Say why chunk search missed, from the actual rank and score of each missed passage.
    const zero = missedByChunks.filter((f) => !f.score);
    const low = missedByChunks.filter((f) => f.score);
    const why: string[] = [];
    for (const chunk of new Set(low.map((f) => f.chunk))) {
      const same = low.filter((f) => f.chunk === chunk);
      why.push(`The passage stating ${list(same.map((f) => `“${f.label}”`))} ranked ${ordinal(same[0].rank ?? 0)} of ${index.chunks.length}, below the cut-off.`);
    }
    if (zero.length === 1) why.push(`“${zero[0].label}” is in a passage (${title(zero[0].chunk)}) that shares no words with the question.`);
    if (zero.length > 1) why.push(`${zero.length} facts, such as “${zero[0].label}”, are in passages that share no words with the question.`);
    return {
      winner: "graph",
      headline: `The graph finds the whole answer; chunk search ${c === 0 ? "misses all of it" : "misses part of it"}`,
      detail: `The answer needs ${n} facts from ${new Set(facts.map((f) => f.chunk)).size} passages. Chunk search found ${c} in its top ${k}. ${why.join(" ")} The graph reached every fact by following edges from the entity the question names.`,
    };
  }
  if (o.chunks === "complete") {
    const missing = facts.find((f) => !f.byGraph);
    return {
      winner: "chunks",
      headline: "Chunk search finds it; the graph doesn't",
      detail: `The answer is a sentence of prose, not a relation between entities, so the extractor never turned it into an edge. The graph returned ${gr} of ${n} fact${n === 1 ? "" : "s"}${missing ? `: it knows what is connected to the entities, not “${missing.label.toLowerCase()}”` : ""}. Hybrid retrieval, which also returns the source passages, gets it.`,
    };
  }
  return {
    winner: "neither",
    headline: "Neither method finds the whole answer",
    detail: `Chunk search found ${c} of ${n} facts and the graph found ${gr}.`,
  };
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Used by the tests: the expected answer names, resolved to entity ids. */
export const expectedIds = (g: Graph, q: Question) => q.expected.map((n) => idOf(g, n));
