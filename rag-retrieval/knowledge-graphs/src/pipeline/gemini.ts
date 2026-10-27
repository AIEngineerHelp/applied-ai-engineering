// Gemini calls for the pipeline, through the official @google/genai SDK:
// structured JSON with the Interactions API (`response_format`), plain text,
// and embeddings with gemini-embedding-2 (task prefixes, not task types).
// Every call appends its tokens and cost to runs/ledger.jsonl.
//
// Prices (paid tier, per 1M tokens, from https://ai.google.dev/gemini-api/docs/pricing,
// checked 2026-10-23): gemini-3.8-flash $0.75 input and $3.75 output, thinking
// tokens billed as output; gemini-embedding-2 $0.20 input.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { ROOT } from "../load-corpus.ts";

export const PRICES: Record<string, { input: number; output: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-embedding-2": { input: 0.2, output: 0 },
};

export interface CallUsage {
  step: string;
  label: string;
  model: string;
  input: number;
  output: number;
  thought: number;
  cost: number;
  ms: number;
}

export function costOf(model: string, input: number, output: number): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for model ${model}. Add it to PRICES in src/pipeline/gemini.ts.`);
  return (input * p.input + output * p.output) / 1e6;
}

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY in .env for live calls (see .env.example).");
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}
export const MODEL = () => process.env.GEMINI_MODEL || "gemini-3.8-flash";
export const EMBED_MODEL = () => process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2";

export const usageLog: CallUsage[] = [];
function record(u: CallUsage) {
  usageLog.push(u);
  mkdirSync(join(ROOT, "runs"), { recursive: true });
  appendFileSync(join(ROOT, "runs", "ledger.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...u })}\n`);
}

/** Bounded retries for rate limits and server errors, on top of the SDK's own. */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|timed out|fetch failed/i.test(msg) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw last;
}

interface Interaction {
  output_text?: string;
  status?: string;
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number };
}

async function interact(step: string, label: string, body: Record<string, unknown>): Promise<{ text: string; usage: CallUsage }> {
  const model = MODEL();
  const started = Date.now();
  const res = (await withRetry(() =>
    ai().interactions.create({ model, store: false, ...body } as never, { timeout: 120_000, maxRetries: 2 }),
  )) as unknown as Interaction;
  if (res.status && res.status !== "completed") throw new Error(`Gemini interaction ended with status ${res.status}`);
  const input = res.usage?.total_input_tokens ?? 0;
  const output = res.usage?.total_output_tokens ?? 0;
  const thought = res.usage?.total_thought_tokens ?? 0;
  const usage: CallUsage = { step, label, model, input, output, thought, cost: costOf(model, input, output + thought), ms: Date.now() - started };
  record(usage);
  return { text: res.output_text ?? "", usage };
}

/** One structured call: the reply must match `schema`. Returns the parsed object and the raw text. */
export async function generateJson<T>(o: { step: string; label: string; system: string; input: string; schema: object; temperature?: number }): Promise<{ data: T; raw: string; usage: CallUsage }> {
  const { text, usage } = await interact(o.step, o.label, {
    system_instruction: o.system,
    input: o.input,
    generation_config: { temperature: o.temperature ?? 0, thinking_level: "low" },
    response_format: { type: "text", mime_type: "application/json", schema: o.schema },
  });
  try {
    return { data: JSON.parse(text) as T, raw: text, usage };
  } catch {
    throw new Error(`Gemini returned text that is not JSON (${o.step} ${o.label}): ${text.slice(0, 200)}`);
  }
}

/** One plain-text call. */
export async function generateText(o: { step: string; label: string; system: string; input: string; temperature?: number }): Promise<{ text: string; usage: CallUsage }> {
  return interact(o.step, o.label, { system_instruction: o.system, input: o.input, generation_config: { temperature: o.temperature ?? 0, thinking_level: "low" } });
}

/**
 * Embeddings with gemini-embedding-2. It takes no task type; the docs ask for
 * text prefixes instead: "task: search result | query: …" for questions and
 * "title: … | text: …" for documents. 768 dimensions (normalised by the API).
 */
export async function embed(o: { step: string; label: string; items: { text: string; title?: string }[]; kind: "query" | "document" }): Promise<number[][]> {
  const model = EMBED_MODEL();
  const texts = o.items.map((it) => (o.kind === "query" ? `task: search result | query: ${it.text}` : `title: ${it.title ?? "none"} | text: ${it.text}`));
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const contents = batch.map((t) => ({ role: "user", parts: [{ text: t }] }));
    const started = Date.now();
    const res = await withRetry(() => ai().models.embedContent({ model, contents, config: { outputDimensionality: 768 } }));
    const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== batch.length) throw new Error(`Expected ${batch.length} embeddings, got ${vectors.length}`);
    out.push(...vectors);
    // The embeddings response has no token count, so count the same contents (a free call).
    const counted = await withRetry(() => ai().models.countTokens({ model, contents }));
    const input = counted.totalTokens ?? 0;
    record({ step: o.step, label: `${o.label} [${i}-${i + batch.length - 1}]`, model, input, output: 0, thought: 0, cost: costOf(model, input, 0), ms: Date.now() - started });
  }
  return out;
}

export const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
