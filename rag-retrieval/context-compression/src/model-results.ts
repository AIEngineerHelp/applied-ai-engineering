import { compress, defaults, type Options, type Result, type Scoring, type Unit } from "./compress.ts";
import { countTokens } from "./tokens.ts";

export function scoredUnits(source: string, raw: unknown): Unit[] {
  if (!Array.isArray(raw) || raw.length > 12000 || source.trim() && !raw.length) throw new Error("Invalid model score response.");
  let lastEnd = 0;
  const units = raw.map((item, id) => {
    if (!item || typeof item !== "object") throw new Error("Invalid model score item.");
    const { start, end, score } = item;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start !== lastEnd || end > source.length || start >= end || !Number.isFinite(score)) throw new Error("Invalid model score offsets.");
    lastEnd = end;
    return { id, start, end, score, text: source.slice(start, end), headings: [], matches: [] };
  });
  if (source.slice(lastEnd).trim()) throw new Error("Model scores did not cover the source.");
  return units;
}

export function semanticScoring(source: string, units: Unit[], scores: unknown, model: string): Scoring {
  if (!Array.isArray(scores) || scores.length !== units.length || scores.some((score) => !Number.isFinite(score) || score < -1.0001 || score > 1.0001)) throw new Error("Invalid semantic similarity scores.");
  return { units: units.map((u, i) => ({ ...u, score: Math.max(0, scores[i]), matches: [] })),
    description: `Semantic cosine similarity from ${model}; scores are not correctness probabilities. Embeddings are computed independently per unit.` };
}

export function hostedResult(source: string, text: string, options: Options, model: string, durationMs: number): Result {
  const originalTokens = countTokens(source);
  const compressedTokens = countTokens(text);
  return { text, units: [], selected: [], spans: [], segments: [], originalTokens, compressedTokens,
    budget: Math.floor(originalTokens * (1 - options.remove / 100)), removed: originalTokens ? 1 - compressedTokens / originalTokens : 0,
    status: "compressed", alignment: "unavailable",
    reason: `${model} returned text without source offsets. Exact dropped-span attribution is unavailable. API removal is approximate; token counts here use cl100k_base.`,
    backend: { method: "compresr", model, durationMs, fallback: false } };
}

export function rawFallback(source: string, options: Options, method: string, durationMs: number): Result {
  const result = compress(source, { ...defaults, ...options, method: "relevance", dynamic: false, remove: 0 });
  return { ...result, reason: "Compression failed. Explicit fail-open policy returned the complete source; no token savings were achieved. Check its size against your answering model's context limit.",
    backend: { method, model: "raw fallback", durationMs, fallback: true } };
}
