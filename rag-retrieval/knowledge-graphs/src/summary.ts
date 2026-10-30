// The measured tables, computed from results/answers.json. The app, the README
// and the tests all use this one function, so they cannot disagree.

import type { MethodResult, QuestionResult } from "./pipeline/ask.ts";
import type { Question } from "./score.ts";

export const METHODS = ["tfidf", "vector", "cypher", "gold", "hybrid"] as const;
export type MethodId = (typeof METHODS)[number];
export const METHOD_NAMES: Record<MethodId | "community", string> = {
  tfidf: "Chunk search (TF-IDF)",
  vector: "Chunk search (embeddings)",
  cypher: "Graph: Gemini writes the query",
  gold: "Graph: hand-written query",
  hybrid: "Hybrid: embeddings + graph",
  community: "Community summaries",
};

export interface Cell {
  found: number;
  of: number;
  wrong: number;
  answerFound: number | null;
  answerWrong: number | null;
  countRight: boolean | null; // "how many" questions: did the result give the correct count?
  judged: boolean; // scored by the LLM judge (the global question)
}

/**
 * One method on one question. For the global question, graph and hybrid results are
 * graded by the LLM judge on the written answer (matching words in rows says little
 * there); the hand-written query has no written answer, so it has no cell.
 */
export function cellOf(q: Question, m: MethodResult | undefined): Cell | null {
  if (!m) return null;
  if (q.judge && m.method !== "tfidf") {
    if (!m.judge) return null;
    return { found: m.judge.found, of: m.judge.of, wrong: 0, answerFound: m.judge.found, answerWrong: 0, countRight: null, judged: true };
  }
  return {
    found: m.context.found,
    of: m.context.of,
    wrong: m.context.wrong.length,
    answerFound: m.answerScore?.found ?? null,
    answerWrong: m.answerScore ? m.answerScore.wrong.length : null,
    countRight: q.count === undefined ? null : Boolean(m.context.countRight),
    judged: false,
  };
}

export function summarize(questions: Question[], results: QuestionResult[]) {
  const rows = questions.map((q) => {
    const r = results.find((x) => x.id === q.id)!;
    const cells = Object.fromEntries(METHODS.map((id) => [id, cellOf(q, r.methods.find((m) => m.method === id))])) as Record<MethodId, Cell | null>;
    return { id: q.id, kind: q.kind, question: q.question, cells };
  });
  const totals = METHODS.map((id) => {
    const cells = rows.map((r) => r.cells[id]).filter((c): c is Cell => c !== null);
    const sum = (f: (c: Cell) => number) => cells.reduce((s, c) => s + f(c), 0);
    const withAnswers = cells.filter((c) => c.answerFound !== null);
    return {
      method: id,
      name: METHOD_NAMES[id],
      found: sum((c) => c.found),
      of: sum((c) => c.of),
      complete: cells.filter((c) => c.found === c.of).length,
      questions: cells.length,
      wrong: sum((c) => c.wrong),
      answerFound: withAnswers.length ? withAnswers.reduce((s, c) => s + (c.answerFound ?? 0), 0) : null,
      answerOf: withAnswers.length ? withAnswers.reduce((s, c) => s + c.of, 0) : null,
      answerWrong: withAnswers.length ? withAnswers.reduce((s, c) => s + (c.answerWrong ?? 0), 0) : null,
    };
  });
  return { rows, totals };
}

/**
 * Facts the hand-written query could not return, because extraction never made
 * them edges. `scored` are the misses inside the gold total (the table's 34/37);
 * `judged` are misses on the global question, whose gold query is not scored.
 */
export function goldMisses(questions: Question[], results: QuestionResult[]) {
  const scored: { question: string; kind: string; label: string }[] = [];
  const judged: { question: string; kind: string; label: string }[] = [];
  for (const q of questions) {
    const gold = results.find((r) => r.id === q.id)?.methods.find((m) => m.method === "gold");
    if (!gold) continue;
    for (const it of gold.context.items) if (!it.found) (q.judge ? judged : scored).push({ question: q.question, kind: q.kind, label: it.label });
  }
  return { scored, judged };
}
