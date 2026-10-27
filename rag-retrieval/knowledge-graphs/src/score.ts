// Scoring against the gold answers (data/questions.json), by code.
//
// Each question lists the facts its correct answer needs. A fact has answer
// strings (`match`, e.g. "Osterby") and the source sentences that support it
// (`support`, the whole chain: QX-7 is in the Atlas-3, Osterby runs the Atlas-3).
//
// - Retrieved passages find a fact only if every supporting sentence is in them:
//   a passage naming Osterby but not the chain doesn't prove Osterby is affected.
// - Graph rows and written answers find a fact if one of its answer strings appears.
// - `wrong` lists outdated or incorrect values; if one appears, it is flagged.

import { normQuote } from "./schema.ts";

export interface Support {
  doc: string;
  quote: string;
}
export interface Item {
  label: string;
  match: string[];
  support: Support[];
}
export interface Question {
  id: string;
  kind: string;
  question: string;
  answer: string;
  items: Item[];
  wrong?: { label: string; match: string[] }[];
  cypher: string;
  judge?: boolean;
  /** For "how many" questions: the correct count, so a count-only result can be recognised. */
  count?: number;
}

export interface ItemScore {
  label: string;
  found: boolean;
}
export interface Score {
  found: number;
  of: number;
  items: ItemScore[];
  wrong: string[]; // labels of outdated or incorrect values that appeared
  countRight?: boolean; // a "how many" question whose correct count appears as a number
}

const lower = (s: string) => s.toLowerCase();
const hasAny = (text: string, needles: string[]) => needles.some((n) => lower(text).includes(lower(n)));

function tally(q: Question, found: boolean[], text: string): Score {
  const items = q.items.map((it, i) => ({ label: it.label, found: found[i] }));
  const wrong = (q.wrong ?? []).filter((w) => hasAny(text, w.match)).map((w) => w.label);
  return { found: found.filter(Boolean).length, of: q.items.length, items, wrong };
}

/** Passages: a fact is found only if every supporting sentence appears in the retrieved text. */
export function scorePassages(q: Question, passages: { doc: string; text: string }[]): Score {
  const found = q.items.map((it) => it.support.every((s) => passages.some((p) => p.doc === s.doc && normQuote(p.text).includes(normQuote(s.quote)))));
  return tally(q, found, passages.map((p) => p.text).join("\n"));
}

/** Rows, edges or a written answer: a fact is found if one of its answer strings appears. */
export function scoreText(q: Question, text: string): Score {
  const s = tally(q, q.items.map((it) => hasAny(text, it.match)), text);
  if (q.count !== undefined) s.countRight = new RegExp(`(^|[^0-9.])${q.count}([^0-9.]|$)`).test(text) || new RegExp(`\\b${["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][q.count] ?? "@"}\\b`, "i").test(text);
  return s;
}

/** Hybrid context: a fact is found by either rule. */
export function scoreEither(a: Score, b: Score): Score {
  const items = a.items.map((it, i) => ({ label: it.label, found: it.found || b.items[i].found }));
  return { found: items.filter((i) => i.found).length, of: a.of, items, wrong: [...new Set([...a.wrong, ...b.wrong])] };
}
