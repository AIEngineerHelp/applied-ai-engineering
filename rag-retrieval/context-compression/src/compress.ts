import { countTokens } from "./tokens.ts";

export interface Span {
  start: number;
  end: number;
}
export interface Unit extends Span {
  id: number;
  text: string;
  headings: Span[];
  score: number;
  matches: string[];
}
export type Method =
  | "relevance"
  | "mmr"
  | "words"
  | "truncate"
  | "semantic"
  | "llmlingua2"
  | "compresr"
  | "laya"
  | "llmlingua"
  | "longllmlingua";
export const isModelMethod = (method: Method) =>
  ["semantic", "llmlingua2", "compresr", "laya", "llmlingua", "longllmlingua"].includes(method);
export interface Scoring {
  units: Unit[];
  description: string;
  separator?: string;
}

export interface Options {
  query: string;
  focus?: string;
  useFocus?: boolean;
  queryAware: boolean;
  granularity: "paragraph" | "sentence";
  method: Method;
  remove: number;
  dynamic: boolean;
  minFactor: number;
  maxFactor: number;
  threshold: number;
  diversity?: number;
}
export const defaults: Options = {
  query: "",
  focus: "",
  useFocus: true,
  queryAware: true,
  granularity: "sentence",
  method: "relevance",
  remove: 60,
  dynamic: false,
  minFactor: 2,
  maxFactor: 6,
  threshold: 80,
};
export interface Segment extends Span {
  text: string;
  kept: boolean;
}
export interface UnitDecision {
  id: number;
  outcome: "kept" | "no-relevance" | "over-budget";
  candidateTokens?: number;
}
export interface Result {
  decisions?: UnitDecision[];
  text: string;
  units: Unit[];
  selected: number[];
  spans: Span[];
  segments: Segment[];
  originalTokens: number;
  compressedTokens: number;
  budget: number;
  removed: number;
  status: "compressed" | "small-input" | "empty";
  reason: string;
  alignment?: "exact" | "unavailable";
  backend?: { method: string; model: string; durationMs: number; fallback: boolean };
}

const STOP = new Set(
  "a an the and or but for of in on at to from by with is are was were be been it its this that these those what which who how when where why does do did can could should would will our we as about any their they them per than then my i me please tell give has have had not".split(
    " ",
  ),
);
export function terms(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((word) => word.length > 1 && !STOP.has(word))
        .map((word) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word)),
    ),
  ];
}

// UTF-16 offsets always point into the original source. Headings are dependencies,
// never independently ranked. Fenced code blocks stay whole even in sentence mode.
export function splitUnits(source: string, granularity: Options["granularity"]): Unit[] {
  const units: Unit[] = [];
  const headings: { level: number; span: Span }[] = [];
  const lines = [...source.matchAll(/[^\n]*\n|[^\n]+$/g)];
  let bodyStart = -1;
  let bodyEnd = 0;
  let fence = "";
  const flush = (atomic = false) => {
    if (bodyStart < 0) return;
    const text = source.slice(bodyStart, bodyEnd);
    const ranges =
      granularity === "sentence" && !atomic
        ? [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)].map((s) => ({
            start: bodyStart + s.index,
            end: bodyStart + s.index + s.segment.length,
          }))
        : [{ start: bodyStart, end: bodyEnd }];
    for (const range of ranges) {
      if (!source.slice(range.start, range.end).trim()) continue;
      units.push({
        ...range,
        id: units.length,
        text: source.slice(range.start, range.end),
        headings: headings.map((h) => h.span),
        score: 0,
        matches: [],
      });
    }
    bodyStart = -1;
  };
  for (const line of lines) {
    const text = line[0];
    const start = line.index!;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(text);
    if (fenceMatch) {
      if (!fence) {
        flush();
        fence = fenceMatch[1];
        bodyStart = start;
      } else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        bodyEnd = start + text.length;
        flush(true);
        fence = "";
      }
      bodyEnd = start + text.length;
      continue;
    }
    if (fence) {
      bodyEnd = start + text.length;
      continue;
    }
    const heading = /^(#{1,6})\s+/.exec(text);
    if (heading) {
      flush();
      while (headings.length && headings.at(-1)!.level >= heading[1].length) headings.pop();
      headings.push({ level: heading[1].length, span: { start, end: start + text.length } });
    } else if (!text.trim()) flush();
    else {
      if (bodyStart < 0) bodyStart = start;
      bodyEnd = start + text.length;
    }
  }
  flush(Boolean(fence));
  return units;
}

export function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

export function segmentsFor(source: string, spans: Span[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of mergeSpans(spans)) {
    if (span.start > cursor)
      segments.push({
        start: cursor,
        end: span.start,
        text: source.slice(cursor, span.start),
        kept: false,
      });
    segments.push({ ...span, text: source.slice(span.start, span.end), kept: true });
    cursor = span.end;
  }
  if (cursor < source.length)
    segments.push({ start: cursor, end: source.length, text: source.slice(cursor), kept: false });
  return segments;
}

export const renderSpans = (source: string, spans: Span[], separator = "\n\n") =>
  mergeSpans(spans)
    .map((s) => source.slice(s.start, s.end))
    .join(separator);

export function wordUnits(source: string): Unit[] {
  let previousEnd = 0;
  return [...source.matchAll(/\S+/gu)].map((match, id) => {
    const start = previousEnd;
    const end = match.index! + match[0].length;
    previousEnd = end;
    return { id, start, end, text: source.slice(start, end), headings: [], score: 0, matches: [] };
  });
}

export function jaccard(a: string, b: string): number {
  const first = new Set(terms(a));
  const second = new Set(terms(b));
  const intersection = [...first].filter((word) => second.has(word)).length;
  const union = new Set([...first, ...second]).size;
  return union ? intersection / union : 0;
}

function scoreUnits(source: string, units: Unit[], query: string, aware: boolean): Unit[] {
  const queryTerms = terms(query);
  const docs = units.map((u) =>
    terms(u.text + " " + u.headings.map((h) => source.slice(h.start, h.end)).join(" ")),
  );
  const frequency = new Map<string, number>();
  for (const words of docs)
    for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return units.map((unit, i) => {
    const words = docs[i];
    const matches = aware ? queryTerms.filter((t) => words.includes(t)) : [];
    // A small, explainable TF/IDF-style overlap score. Not semantic inference.
    const score = aware
      ? matches.reduce((sum, t) => sum + Math.log(1 + units.length / (frequency.get(t) ?? 1)), 0) /
        Math.sqrt(Math.max(1, words.length))
      : words.reduce((sum, t) => sum + Math.log(1 + units.length / (frequency.get(t) ?? 1)), 0) /
        Math.sqrt(Math.max(1, words.length));
    return { ...unit, matches, score };
  });
}

export function validate(o: Options): void {
  if (
    ![
      "relevance",
      "mmr",
      "words",
      "truncate",
      "semantic",
      "llmlingua2",
      "compresr",
      "laya",
      "llmlingua",
      "longllmlingua",
    ].includes(o.method)
  )
    throw new Error("Unknown compression method.");
  if (!["paragraph", "sentence"].includes(o.granularity)) throw new Error("Unknown unit size.");
  if (
    typeof o.query !== "string" ||
    o.query.length > 1000 ||
    (o.focus !== undefined && (typeof o.focus !== "string" || o.focus.length > 1000))
  )
    throw new Error("Question and focus must be text of at most 1,000 characters each.");
  if (
    o.diversity !== undefined &&
    (!Number.isFinite(o.diversity) || o.diversity < 0 || o.diversity > 1)
  )
    throw new Error("MMR relevance weight must be between 0 and 1.");
  if (o.method === "truncate" && o.dynamic)
    throw new Error("Prefix truncation uses fixed removal. Disable dynamic budgeting.");
  if (!Number.isFinite(o.remove) || o.remove < 0 || o.remove > 100)
    throw new Error("Removal must be between 0 and 100.");
  if (!Number.isFinite(o.threshold) || o.threshold < 0)
    throw new Error("Pass-through threshold must be non-negative.");
  if (
    !Number.isFinite(o.minFactor) ||
    !Number.isFinite(o.maxFactor) ||
    o.minFactor < 1 ||
    o.maxFactor < o.minFactor
  )
    throw new Error("Dynamic multipliers must satisfy 1 ≤ min ≤ max.");
}

export function compress(source: string, options: Options, scoring?: Scoring): Result {
  validate(options);
  const originalTokens = countTokens(source);
  const query = options.query + (options.useFocus && options.focus ? `\n${options.focus}` : "");
  if (isModelMethod(options.method) && !scoring)
    throw new Error("This method requires an explicitly requested backend run.");
  const words = options.method === "words" || options.method === "llmlingua2";
  const separator = scoring?.separator ?? (words ? "" : "\n\n");
  const render = (text: string, ranges: Span[]) => renderSpans(text, ranges, separator);
  const units =
    scoring?.units ??
    scoreUnits(
      source,
      options.method === "words" ? wordUnits(source) : splitUnits(source, options.granularity),
      query,
      options.queryAware,
    );
  if (
    units.some(
      (u) =>
        !Number.isFinite(u.score) ||
        !Number.isInteger(u.start) ||
        !Number.isInteger(u.end) ||
        u.start < 0 ||
        u.end > source.length ||
        u.start >= u.end ||
        u.text !== source.slice(u.start, u.end),
    )
  )
    throw new Error("Invalid source-aligned model scores.");
  const ranked = [...units].sort((a, b) => b.score - a.score || a.start - b.start);
  let budget = Math.floor(originalTokens * (1 - options.remove / 100));
  let reason = `Fixed budget: keep at most ${budget} tokens (${100 - options.remove}% of source).`;
  if (options.dynamic) {
    // Our heuristic: find the largest adjacent relevance drop, count its preferred
    // units, then clamp their rendered size between the multiplier bounds.
    let cut = ranked.filter((u) => u.score > 0).length;
    let largestGap = 0;
    for (let i = 1; i < ranked.length; i++) {
      const gap = ranked[i - 1].score - ranked[i].score;
      if (gap > largestGap) {
        largestGap = gap;
        cut = i;
      }
    }
    const preferred = countTokens(
      render(
        source,
        ranked.slice(0, cut).flatMap((u) => [u, ...u.headings]),
      ),
    );
    const lower = Math.ceil(originalTokens / options.maxFactor);
    const upper = Math.floor(originalTokens / options.minFactor);
    budget = Math.max(0, Math.min(upper, Math.max(lower, preferred)));
    reason = `Our largest-score-gap heuristic chose ${budget} tokens, bounded by ${options.minFactor}×–${options.maxFactor}×. This is not Latte's algorithm.`;
  }
  const passthrough =
    originalTokens < options.threshold ||
    originalTokens === 0 ||
    (options.remove === 0 && !options.dynamic);
  let spans: Span[] = [];
  const selected: number[] = [];
  const decisions: UnitDecision[] = [];
  let text = "";
  if (passthrough) {
    spans = source.length ? [{ start: 0, end: source.length }] : [];
    text = source;
    selected.push(...units.map((u) => u.id));
    reason =
      originalTokens === 0
        ? "The source is empty."
        : originalTokens < options.threshold
          ? `Small input: ${originalTokens} tokens is below the ${options.threshold}-token threshold. Passed through unchanged.`
          : "Zero removal: the complete source passes through unchanged.";
    budget = originalTokens;
  } else if (options.method === "truncate") {
    // Binary search an original-text prefix. Re-encode candidates to avoid slicing
    // a multi-byte character at a tokenizer boundary.
    const chars = [...source];
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (countTokens(chars.slice(0, mid).join("")) <= budget) low = mid;
      else high = mid - 1;
    }
    text = chars.slice(0, low).join("");
    spans = text ? [{ start: 0, end: text.length }] : [];
    selected.push(...units.filter((u) => u.end <= text.length).map((u) => u.id));
    reason += " Prefix truncation ignores relevance and may cut a sentence.";
  } else {
    const remaining = [...ranked];
    const maxScore = Math.max(1e-12, ...units.map((u) => u.score));
    while (remaining.length) {
      // MMR recomputes a redundancy penalty after every accepted unit.
      if (options.method === "mmr") {
        const weight = options.diversity ?? 0.65;
        const mmr = (u: Unit) =>
          (weight * u.score) / maxScore -
          (1 - weight) *
            Math.max(
              0,
              ...units.filter((v) => selected.includes(v.id)).map((v) => jaccard(u.text, v.text)),
            );
        remaining.sort((a, b) => mmr(b) - mmr(a) || a.start - b.start);
      }
      const unit = remaining.shift()!;
      if (options.queryAware && unit.score <= 0) {
        decisions.push({ id: unit.id, outcome: "no-relevance" });
        continue;
      }
      const candidate = mergeSpans([...spans, unit, ...unit.headings]);
      const candidateText = render(source, candidate);
      const candidateTokens = countTokens(candidateText);
      if (candidateTokens <= budget) {
        spans = candidate;
        text = candidateText;
        selected.push(unit.id);
        decisions.push({ id: unit.id, outcome: "kept", candidateTokens });
      } else decisions.push({ id: unit.id, outcome: "over-budget", candidateTokens });
    }
    if (!selected.length)
      reason += " No eligible whole unit fits; try a larger budget or sentence units.";
  }
  if (options.method === "mmr")
    reason += ` MMR uses a ${options.diversity ?? 0.65} relevance weight and Jaccard redundancy penalty; inspector scores are the base relevance scores.`;
  if (options.method === "words")
    reason +=
      " Lexical word deletion: this is not a learned token classifier. Deletion can break grammar and remove negation.";
  if (scoring) reason += ` ${scoring.description}`;
  const compressedTokens = countTokens(text);
  return {
    text,
    units,
    selected,
    decisions,
    spans,
    segments: segmentsFor(source, spans),
    originalTokens,
    compressedTokens,
    budget,
    removed: originalTokens ? 1 - compressedTokens / originalTokens : 0,
    status:
      originalTokens === 0
        ? "empty"
        : originalTokens < options.threshold
          ? "small-input"
          : "compressed",
    reason,
  };
}

export interface Evidence {
  label: string;
  quote: string;
}
export function checkEvidence(source: string, spans: Span[], evidence: Evidence[]) {
  return evidence.map((item) => {
    const start = source.indexOf(item.quote);
    return {
      ...item,
      present: start >= 0,
      kept:
        start >= 0 &&
        spans.some((span) => span.start <= start && span.end >= start + item.quote.length),
    };
  });
}
