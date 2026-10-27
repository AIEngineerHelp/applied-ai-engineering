// The recorded results the page replays. Nothing here calls a model: these are
// the committed outputs of `npm run pipeline` (results/) and the hand-written
// inputs (data/).

import CORPUS from "../results/corpus.json" with { type: "json" };
import RUN1 from "../results/extraction/run-1.json" with { type: "json" };
import VARIATION from "../results/variation.json" with { type: "json" };
import RESOLUTION from "../results/resolution.json" with { type: "json" };
import GRAPH from "../results/graph.json" with { type: "json" };
import LAYOUT from "../results/layout.json" with { type: "json" };
import ANSWERS from "../results/answers.json" with { type: "json" };
import COSTS from "../results/costs.json" with { type: "json" };
import QUESTIONS from "../data/questions.json" with { type: "json" };
import REVIEW from "../data/extraction-review.json" with { type: "json" };
import type { Doc } from "../src/corpus.ts";
import type { ExtractionRun } from "../src/pipeline/extract.ts";
import type { Resolution } from "../src/pipeline/resolve-run.ts";
import type { Graph } from "../src/graph.ts";
import type { MethodResult, QuestionResult } from "../src/pipeline/ask.ts";
import type { Question } from "../src/score.ts";
import type { Cluster } from "../src/resolve.ts";

export const docs = CORPUS as Doc[];
export const run1 = RUN1 as unknown as ExtractionRun;
export const variation = VARIATION as unknown as {
  runs: { run: number; entities: number; relations: number; distinct: number; rejects: number; cost: number }[];
  pairs: { a: number; b: number; jaccard: number }[];
  union: number;
  inAll: number;
  inOne: number;
  onlyInOne: string[];
};
export const resolution = RESOLUTION as unknown as Resolution & {
  review: { a: string; b: string; type: string; decision: string; note: string }[];
  reviewed: { clusters: Cluster[]; evaluation: Resolution["evaluation"] };
  withoutTypeGuard: { cluster: string; members: { name: string; gold: string | null; goldType: string | null }[] }[];
  ambiguousWithoutTypeGuard: { name: string; candidates: string[] }[];
};
export const graph = GRAPH as unknown as Graph;
export const layout = LAYOUT as unknown as Record<string, [number, number]>;
export const answers = ANSWERS as unknown as { model: string; embeddingModel: string; k: number; at: string; summaries: { members: string[]; summary: string }[]; results: QuestionResult[] };
export const costs = COSTS as unknown as { steps: { step: string; calls: number; input: number; output: number; thought: number; cost: number }[]; total: { calls: number; cost: number; input: number; output: number } };
export const questions = QUESTIONS as unknown as Question[];
export const review = REVIEW as unknown as {
  wrong: { doc: string; source: string; relation: string; target: string; why: string }[];
  unsupported: { doc: string; source: string; relation: string; target: string; why: string }[];
  typeErrors: { doc: string; name: string; extractedAs: string; should: string; why: string }[];
  spurious: { doc: string; name: string; type: string; why: string }[];
};

export const docById = (id: string) => docs.find((d) => d.id === id)!;
export const questionById = (id: string) => questions.find((q) => q.id === id)!;
export const resultOf = (id: string) => answers.results.find((r) => r.id === id)!;
export const methodOf = (id: string, method: MethodResult["method"]) => resultOf(id).methods.find((m) => m.method === method)!;
export const nodeById = (id: string) => graph.nodes.find((n) => n.id === id);
export const nodeByName = (name: string) => graph.nodes.find((n) => n.name === name || n.aliases.includes(name));

export const MAIN = "qx7-customers";
export const PROSE = "qx7-recommendations";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
export const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
