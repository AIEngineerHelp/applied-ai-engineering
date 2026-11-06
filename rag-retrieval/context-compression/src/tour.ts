// Data for the technique tour. Every number shown in the tour comes from these
// functions, which call the same compress() the lab uses. Nothing is hard-coded
// except the choice of example, question and the "breaks when" variations.
import {
  STOP,
  checkEvidence,
  compress,
  defaults,
  jaccard,
  mergeSpans,
  renderSpans,
  splitUnits,
  terms,
  type Evidence,
  type Options,
  type Result,
  type Unit,
} from "./compress.ts";
import { countTokens } from "./tokens.ts";
import { formatPassages, scenarios } from "./fixtures.ts";

export type TourMethod = "relevance" | "mmr" | "words" | "truncate";
export const tourMethods: TourMethod[] = ["relevance", "mmr", "words", "truncate"];

const handbook = scenarios.find((s) => s.id === "document")!;
const refund = handbook.questions.find((q) => q.id === "refund")!;

export const tourExample = {
  source: formatPassages(handbook.passages),
  question: refund.text,
  evidence: refund.evidence,
  remove: 60,
  title: handbook.origin,
};

/** Variations used by each chapter's "Show me it breaking" demo. */
export const breakingCases = {
  // Same intent, different words: no shared terms with the general rule.
  synonym: refund.paraphrases![0],
  // A stronger repetition penalty at a tight budget.
  mmr: { diversity: 0.5, remove: 85 },
};

export const tourOptions = (method: TourMethod, overrides: Partial<Options> = {}): Options => ({
  ...defaults,
  query: tourExample.question,
  method,
  remove: tourExample.remove,
  ...overrides,
});

export interface FactCheck extends Evidence {
  present: boolean;
  kept: boolean;
}
export const factsFor = (source: string, result: Result, evidence: Evidence[]): FactCheck[] =>
  checkEvidence(source, result.spans, evidence);

/** How the question becomes search terms: dropped filler, shortened plurals, kept terms. */
export function questionTerms(query: string) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const steps = words.map((word) => {
    if (word.length <= 1 || STOP.has(word)) return { word, term: null as string | null };
    const term = word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
    return { word, term };
  });
  return { steps, terms: terms(query) };
}

function unitTerms(source: string, units: Unit[]) {
  return units.map((u) =>
    terms(u.text + " " + u.headings.map((h) => source.slice(h.start, h.end)).join(" ")),
  );
}

export interface TermWeight {
  term: string;
  df: number;
  weight: number;
}
/** Rarity weight of each question term: ln(1 + N / df), the same formula compress() uses. */
export function termWeights(source: string, units: Unit[], query: string): TermWeight[] {
  const docs = unitTerms(source, units);
  return terms(query).map((term) => {
    const df = docs.filter((d) => d.includes(term)).length;
    return { term, df, weight: df ? Math.log(1 + units.length / df) : 0 };
  });
}

export interface PackStep {
  unit: Unit;
  outcome: "kept" | "over-budget" | "no-relevance";
  tokensAfter?: number;
}
export function lexicalWalkthrough(overrides: Partial<Options> = {}) {
  const { source, evidence } = tourExample;
  const options = tourOptions("relevance", overrides);
  const result = compress(source, options);
  const weights = termWeights(source, result.units, options.query);
  const ranked = [...result.units]
    .filter((u) => u.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start);
  const docs = unitTerms(source, result.units);
  const top = ranked[0];
  const topCalculation = top
    ? {
        unit: top,
        contributions: top.matches.map((term) => weights.find((w) => w.term === term)!),
        uniqueTerms: docs[top.id].length,
      }
    : null;
  const pack: PackStep[] = (result.decisions ?? []).map((d) => ({
    unit: result.units[d.id],
    outcome: d.outcome,
    tokensAfter: d.outcome === "kept" ? d.candidateTokens : undefined,
  }));
  return {
    options,
    result,
    question: questionTerms(options.query),
    weights,
    ranked,
    zeroScore: result.units.length - ranked.length,
    topCalculation,
    pack,
    facts: factsFor(source, result, evidence),
  };
}

export interface MmrRound {
  unit: Unit;
  relevance: number;
  similarity: number;
  similarTo: Unit | null;
  priority: number;
  outcome: "kept" | "over-budget" | "no-relevance";
  tokensAfter?: number;
}
/**
 * Replays compress()'s MMR loop and records each round. Tests check that the
 * kept units match compress() exactly, so the tour cannot drift from the lab.
 */
export function mmrWalkthrough(overrides: Partial<Options> = {}) {
  const { source, evidence } = tourExample;
  const options = tourOptions("mmr", overrides);
  const result = compress(source, options);
  const weight = options.diversity ?? 0.65;
  const units = result.units;
  const maxScore = Math.max(1e-12, ...units.map((u) => u.score));
  const kept: Unit[] = [];
  let spans: { start: number; end: number }[] = [];
  const remaining = [...units].sort((a, b) => b.score - a.score || a.start - b.start);
  const closest = (u: Unit) => {
    let best: Unit | null = null;
    let similarity = 0;
    for (const v of kept) {
      const s = jaccard(u.text, v.text);
      if (s > similarity) {
        similarity = s;
        best = v;
      }
    }
    return { similarity, best };
  };
  const priority = (u: Unit) =>
    (weight * u.score) / maxScore - (1 - weight) * closest(u).similarity;
  const rounds: MmrRound[] = [];
  while (remaining.length) {
    remaining.sort((a, b) => priority(b) - priority(a) || a.start - b.start);
    const unit = remaining.shift()!;
    const { similarity, best } = closest(unit);
    const base = {
      unit,
      relevance: unit.score / maxScore,
      similarity,
      similarTo: best,
      priority: priority(unit),
    };
    if (options.queryAware && unit.score <= 0) {
      rounds.push({ ...base, outcome: "no-relevance" });
      continue;
    }
    const candidate = mergeSpans([...spans, unit, ...unit.headings]);
    const tokens = countTokens(renderSpans(source, candidate));
    if (tokens <= result.budget) {
      spans = candidate;
      kept.push(unit);
      rounds.push({ ...base, outcome: "kept", tokensAfter: tokens });
    } else rounds.push({ ...base, outcome: "over-budget" });
  }
  return { options, result, weight, rounds, facts: factsFor(source, result, evidence) };
}

export function wordWalkthrough(overrides: Partial<Options> = {}) {
  const { source, evidence } = tourExample;
  const options = tourOptions("words", overrides);
  const result = compress(source, options);
  const keptWords = result.units.filter((u) => result.selected.includes(u.id));
  // The exception sentence, word by word, to show what deletion does inside a fact.
  const quote = evidence[evidence.length - 1].quote;
  const start = source.indexOf(quote);
  const inQuote = result.units
    .filter((u) => u.end > start && u.start < start + quote.length)
    .map((u) => ({ word: u.text.trim(), kept: result.selected.includes(u.id) }));
  return {
    options,
    result,
    totalWords: result.units.length,
    keptWords: keptWords.length,
    inQuote,
    facts: factsFor(source, result, evidence),
  };
}

export function truncationWalkthrough(overrides: Partial<Options> = {}) {
  const { source, evidence } = tourExample;
  const options = tourOptions("truncate", overrides);
  const result = compress(source, options);
  const cutoff = result.spans[0]?.end ?? 0;
  const sections = [...source.matchAll(/^## (.+?) \[[^\]]+\]$/gm)].map((m, i, all) => ({
    title: m[1],
    start: m.index!,
    bodyStart: m.index! + m[0].length,
    end: i + 1 < all.length ? all[i + 1].index! : source.length,
  }));
  const tail = source.slice(Math.max(0, cutoff - 60), cutoff);
  return {
    options,
    result,
    cutoff,
    // The last characters before the cut, to show exactly where it lands.
    tail,
    sections: sections.map((s) => ({
      title: s.title,
      // A section counts as cut only when some of its body text survived.
      state: s.end <= cutoff ? "kept" : cutoff <= s.bodyStart ? "dropped" : "cut",
    })),
    facts: factsFor(source, result, evidence),
  };
}

/** Share of each sentence that survived, for the side-by-side document maps. */
export function sentenceCoverage(source: string, result: Result) {
  return splitUnits(source, "sentence").map((unit) => {
    const kept = result.spans.reduce(
      (sum, s) => sum + Math.max(0, Math.min(s.end, unit.end) - Math.max(s.start, unit.start)),
      0,
    );
    return { unit, kept: kept / (unit.end - unit.start) };
  });
}

export function compareAll(remove: number) {
  const { source, evidence } = tourExample;
  return tourMethods.map((method) => {
    const result = compress(source, tourOptions(method, { remove }));
    return {
      method,
      result,
      coverage: sentenceCoverage(source, result),
      facts: factsFor(source, result, evidence),
    };
  });
}
