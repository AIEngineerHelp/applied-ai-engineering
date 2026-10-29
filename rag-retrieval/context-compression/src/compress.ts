import { countTokens } from "./tokens.ts";

export interface Span { start: number; end: number }
export interface Unit extends Span {
  id: number;
  text: string;
  headings: Span[];
  score: number;
  matches: string[];
}
export type Method = "relevance" | "truncate";
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
}
export const defaults: Options = {
  query: "", focus: "", useFocus: true, queryAware: true, granularity: "sentence",
  method: "relevance", remove: 60, dynamic: false, minFactor: 2, maxFactor: 6, threshold: 80,
};
export interface Segment extends Span { text: string; kept: boolean }
export interface Result {
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
}

const STOP = new Set("a an the and or but for of in on at to from by with is are was were be been it its this that these those what which who how when where why does do did can could should would will our we as about any their they them per than then my i me please tell give has have had not".split(" "));
export function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map((word) => word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word))];
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
    const ranges = granularity === "sentence" && !atomic
      ? [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)]
        .map((s) => ({ start: bodyStart + s.index, end: bodyStart + s.index + s.segment.length }))
      : [{ start: bodyStart, end: bodyEnd }];
    for (const range of ranges) {
      if (!source.slice(range.start, range.end).trim()) continue;
      units.push({ ...range, id: units.length, text: source.slice(range.start, range.end),
        headings: headings.map((h) => h.span), score: 0, matches: [] });
    }
    bodyStart = -1;
  };
  for (const line of lines) {
    const text = line[0];
    const start = line.index!;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(text);
    if (fenceMatch) {
      if (!fence) { flush(); fence = fenceMatch[1]; bodyStart = start; }
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        bodyEnd = start + text.length; flush(true); fence = "";
      }
      bodyEnd = start + text.length;
      continue;
    }
    if (fence) { bodyEnd = start + text.length; continue; }
    const heading = /^(#{1,6})\s+/.exec(text);
    if (heading) {
      flush();
      while (headings.length && headings.at(-1)!.level >= heading[1].length) headings.pop();
      headings.push({ level: heading[1].length, span: { start, end: start + text.length } });
    } else if (!text.trim()) flush();
    else { if (bodyStart < 0) bodyStart = start; bodyEnd = start + text.length; }
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
    if (span.start > cursor) segments.push({ start: cursor, end: span.start, text: source.slice(cursor, span.start), kept: false });
    segments.push({ ...span, text: source.slice(span.start, span.end), kept: true });
    cursor = span.end;
  }
  if (cursor < source.length) segments.push({ start: cursor, end: source.length, text: source.slice(cursor), kept: false });
  return segments;
}

const render = (source: string, spans: Span[]) => mergeSpans(spans).map((s) => source.slice(s.start, s.end)).join("\n\n");

function scoreUnits(source: string, units: Unit[], query: string, aware: boolean): Unit[] {
  const queryTerms = terms(query);
  const docs = units.map((u) => terms(u.text + " " + u.headings.map((h) => source.slice(h.start, h.end)).join(" ")));
  const frequency = new Map<string, number>();
  for (const words of docs) for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return units.map((unit, i) => {
    const words = docs[i];
    const matches = aware ? queryTerms.filter((t) => words.includes(t)) : [];
    // A small, explainable TF/IDF-style overlap score. Not semantic inference.
    const score = aware
      ? matches.reduce((sum, t) => sum + Math.log(1 + units.length / (frequency.get(t) ?? 1)), 0) / Math.sqrt(Math.max(1, words.length))
      : words.reduce((sum, t) => sum + Math.log(1 + units.length / (frequency.get(t) ?? 1)), 0) / Math.sqrt(Math.max(1, words.length));
    return { ...unit, matches, score };
  });
}

function validate(o: Options): void {
  if (o.method === "truncate" && o.dynamic) throw new Error("Prefix truncation uses fixed removal. Disable dynamic budgeting.");
  if (!Number.isFinite(o.remove) || o.remove < 0 || o.remove > 100) throw new Error("Removal must be between 0 and 100.");
  if (!Number.isFinite(o.threshold) || o.threshold < 0) throw new Error("Pass-through threshold must be non-negative.");
  if (!Number.isFinite(o.minFactor) || !Number.isFinite(o.maxFactor) || o.minFactor < 1 || o.maxFactor < o.minFactor) throw new Error("Dynamic multipliers must satisfy 1 ≤ min ≤ max.");
}

export function compress(source: string, options: Options): Result {
  validate(options);
  const originalTokens = countTokens(source);
  const query = options.query + (options.useFocus && options.focus ? `\n${options.focus}` : "");
  const units = scoreUnits(source, splitUnits(source, options.granularity), query, options.queryAware);
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
      if (gap > largestGap) { largestGap = gap; cut = i; }
    }
    const preferred = countTokens(render(source, ranked.slice(0, cut).flatMap((u) => [u, ...u.headings])));
    const lower = Math.ceil(originalTokens / options.maxFactor);
    const upper = Math.floor(originalTokens / options.minFactor);
    budget = Math.max(0, Math.min(upper, Math.max(lower, preferred)));
    reason = `Our largest-score-gap heuristic chose ${budget} tokens, bounded by ${options.minFactor}×–${options.maxFactor}×. This is not Latte's algorithm.`;
  }
  const passthrough = originalTokens < options.threshold || originalTokens === 0 || options.remove === 0 && !options.dynamic;
  let spans: Span[] = [];
  const selected: number[] = [];
  let text = "";
  if (passthrough) {
    spans = source.length ? [{ start: 0, end: source.length }] : [];
    text = source;
    selected.push(...units.map((u) => u.id));
    reason = originalTokens === 0 ? "The source is empty." : originalTokens < options.threshold
      ? `Small input: ${originalTokens} tokens is below the ${options.threshold}-token threshold. Passed through unchanged.`
      : "Zero removal: the complete source passes through unchanged.";
    budget = originalTokens;
  } else if (options.method === "truncate") {
    // Binary search an original-text prefix. Re-encode candidates to avoid slicing
    // a multi-byte character at a tokenizer boundary.
    const chars = [...source];
    let low = 0; let high = chars.length;
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
    for (const unit of ranked) {
      if (options.queryAware && unit.score === 0) continue;
      const candidate = mergeSpans([...spans, unit, ...unit.headings]);
      const candidateText = render(source, candidate);
      if (countTokens(candidateText) <= budget) {
        spans = candidate; text = candidateText; selected.push(unit.id);
      }
    }
    if (!selected.length) reason += " No eligible whole unit fits; try a larger budget or sentence units.";
  }
  const compressedTokens = countTokens(text);
  return { text, units, selected, spans, segments: segmentsFor(source, spans), originalTokens,
    compressedTokens, budget, removed: originalTokens ? 1 - compressedTokens / originalTokens : 0,
    status: originalTokens === 0 ? "empty" : originalTokens < options.threshold ? "small-input" : "compressed", reason };
}

export interface Evidence { label: string; quote: string }
export function checkEvidence(source: string, spans: Span[], evidence: Evidence[]) {
  return evidence.map((item) => {
    const start = source.indexOf(item.quote);
    return { ...item, present: start >= 0,
      kept: start >= 0 && spans.some((span) => span.start <= start && span.end >= start + item.quote.length) };
  });
}
