// Gemini over the REST streamGenerateContent endpoint (SSE), with no SDK.
// Streaming lets the UI show the model's thought summaries and the report as
// they are written; the chunks are merged back into one response here.
// Checked against https://ai.google.dev/api/generate-content on 2026-10-12:
// - structured output: responseMimeType "application/json" + responseJsonSchema
// - tools: functionDeclarations with parametersJsonSchema; googleSearch for grounding
// - function results go back in a "user" turn as functionResponse parts
// - the model's content is echoed back unchanged, so thought signatures survive
// Streaming checked with a live call on 2026-10-13: with thinkingConfig.includeThoughts,
// thought-summary parts (thought: true) arrive first, then text deltas; usageMetadata
// is on every chunk (cumulative); the thought signature arrives on the last part.

import type { GenerateRequest, GenerateResult, LLM, Turn } from "./llm.ts";
import { parseJson } from "./llm.ts";
import type { Usage } from "./types.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}
interface Content {
  role: "user" | "model";
  parts: Part[];
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: { web?: { uri: string; title: string } }[];
  groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[];
}

/** The parts of a generateContent response this client reads. */
interface GenerateResponse {
  candidates?: { content?: Content; finishReason?: string; groundingMetadata?: GroundingMetadata }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; toolUsePromptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  /** USD per million tokens; unset means cost is reported as unknown. */
  inputPrice?: number;
  outputPrice?: number;
  /** USD per grounded search query. */
  searchPrice?: number;
  timeoutMs?: number;
  retries?: number;
}

const num = (v: string | undefined) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);

export function createGemini(opts: GeminiOptions = {}): LLM {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  const model = opts.model ?? process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
  const inputPrice = opts.inputPrice ?? num(process.env.GEMINI_INPUT_USD_PER_MILLION);
  const outputPrice = opts.outputPrice ?? num(process.env.GEMINI_OUTPUT_USD_PER_MILLION);
  const searchPrice = opts.searchPrice ?? num(process.env.GEMINI_SEARCH_USD_PER_QUERY);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const retries = opts.retries ?? 2;

  /** Builds contents, merging consecutive turns of the same role (e.g. tool results then a note). */
  function toContents(turns: Turn[]): Content[] {
    const out: Content[] = [];
    for (const c of turns.map(toContent)) {
      const prev = out.at(-1);
      if (prev && prev.role === c.role && c.role === "user") prev.parts = [...prev.parts, ...c.parts];
      else out.push(c);
    }
    return out;
  }

  function toContent(t: Turn): Content {
    if (t.role === "user") return { role: "user", parts: [{ text: t.text }] };
    if (t.role === "model") return (t.raw as Content | undefined) ?? { role: "model", parts: [...(t.text ? [{ text: t.text }] : []), ...t.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] };
    return {
      role: "user",
      parts: t.results.map((r) => ({
        functionResponse: { name: r.name, response: r.response && typeof r.response === "object" && !Array.isArray(r.response) ? (r.response as Record<string, unknown>) : { result: r.response } },
      })),
    };
  }

  /**
   * One streamed request. Chunks are merged: text deltas are joined, thought
   * summaries are collected separately (and not echoed back), function calls and
   * signatures are kept. Retries (bounded) only if nothing has streamed yet.
   */
  async function stream(body: unknown, onThought?: (t: string) => void, onText?: (t: string) => void): Promise<GenerateResponse & { thoughts: string }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let received = false;
      try {
        const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey ?? "" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok || !res.body) {
          const text = await res.text();
          if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 200)}`), { retry: true });
          throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        const parts: Part[] = [];
        let thoughts = "";
        let text = "";
        let finishReason: string | undefined;
        let usage: GenerateResponse["usageMetadata"];
        let blockReason: string | undefined;
        const chunks: NonNullable<GroundingMetadata["groundingChunks"]> = [];
        const supports: NonNullable<GroundingMetadata["groundingSupports"]> = [];
        const queries = new Set<string>();

        const handle = (data: GenerateResponse) => {
          received = true;
          if (data.usageMetadata) usage = data.usageMetadata;
          if (data.promptFeedback?.blockReason) blockReason = data.promptFeedback.blockReason;
          const c = data.candidates?.[0];
          if (!c) return;
          if (c.finishReason) finishReason = c.finishReason;
          const g = c.groundingMetadata;
          if (g) {
            // Streamed grounding sends only new chunks; indices count across the whole stream.
            chunks.push(...(g.groundingChunks ?? []));
            supports.push(...(g.groundingSupports ?? []));
            for (const q of g.webSearchQueries ?? []) queries.add(q);
          }
          for (const p of c.content?.parts ?? []) {
            if (p.thought) {
              thoughts += p.text ?? "";
              if (p.text) onThought?.(thoughts);
              continue;
            }
            const last = parts.at(-1);
            // An empty part only matters for its signature.
            if (p.text === "" && !p.functionCall) {
              if (p.thoughtSignature && last) last.thoughtSignature = p.thoughtSignature;
              continue;
            }
            if (p.text !== undefined && !p.functionCall && last && last.text !== undefined && !last.functionCall) {
              last.text += p.text;
              if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
            } else {
              parts.push({ ...p });
            }
            if (p.text) {
              text += p.text;
              onText?.(text);
            }
          }
        };

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const event = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of event.split("\n")) if (line.startsWith("data: ")) handle(JSON.parse(line.slice(6)) as GenerateResponse);
          }
        }
        if (buf.trim().startsWith("data: ")) handle(JSON.parse(buf.trim().slice(6)) as GenerateResponse);

        return {
          candidates: [
            {
              content: { role: "model", parts: parts.length ? parts : [{ text: "" }] },
              finishReason,
              groundingMetadata: chunks.length || supports.length || queries.size ? { groundingChunks: chunks, groundingSupports: supports, webSearchQueries: [...queries] } : undefined,
            },
          ],
          promptFeedback: blockReason ? { blockReason } : undefined,
          usageMetadata: usage,
          thoughts,
        };
      } catch (err) {
        lastErr = err;
        const retry = !received && ((err as { retry?: boolean }).retry || (err as Error).name === "TimeoutError");
        if (!retry || attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  return {
    model,
    mode: "live",
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
      const tools: unknown[] = [];
      if (req.tools?.length) tools.push({ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) });
      if (req.search) tools.push({ googleSearch: {} });
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: toContents(req.turns),
        ...(tools.length ? { tools } : {}),
        ...(req.force ? { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [req.force] } } } : {}),
        generationConfig: {
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.onThought ? { thinkingConfig: { includeThoughts: true } } : {}),
          ...(req.schema ? { responseMimeType: "application/json", responseJsonSchema: req.schema } : {}),
        },
      };
      const data = await stream(body, req.onThought, req.onText);
      const cand = data.candidates?.[0];
      if (!cand?.content) throw new Error(`Gemini returned no content (finishReason: ${cand?.finishReason ?? data.promptFeedback?.blockReason ?? "unknown"})`);
      const parts: Part[] = cand.content.parts ?? [];
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
      const calls = parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));

      const u = data.usageMetadata ?? {};
      const input = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
      const output = u.candidatesTokenCount ?? 0;
      const thinking = u.thoughtsTokenCount ?? 0;
      const queries: string[] = cand.groundingMetadata?.webSearchQueries ?? [];
      // Output price covers thinking tokens too.
      let cost: number | undefined =
        inputPrice !== undefined && outputPrice !== undefined ? (input * inputPrice + (output + thinking) * outputPrice) / 1e6 : undefined;
      if (cost !== undefined && req.search) cost = searchPrice !== undefined ? cost + queries.length * searchPrice : undefined;
      const usage: Usage = { input, output, thinking, cost };

      // Grounding: each chunk is a web page; supports say which text came from which chunks.
      let grounding: GenerateResult["grounding"];
      if (req.search && cand.groundingMetadata) {
        const chunks = cand.groundingMetadata.groundingChunks ?? [];
        const supports = cand.groundingMetadata.groundingSupports ?? [];
        grounding = chunks.map((c, i) => ({
          title: c.web?.title ?? `Source ${i + 1}`,
          url: c.web?.uri ?? "",
          text: supports
            .filter((s) => s.groundingChunkIndices?.includes(i))
            .map((s) => s.segment?.text ?? "")
            .filter(Boolean)
            .join(" "),
        }));
      }

      let json: unknown;
      if (req.schema) json = parseJson(text);
      return { text, json, calls, raw: cand.content, usage, grounding, supports: groundingSupports(cand), searches: req.search ? queries.length : undefined, thoughts: data.thoughts || undefined, model };
    },
  };
}

/** Which sentences of the answer came from which grounding chunks. */
function groundingSupports(cand: { groundingMetadata?: GroundingMetadata }): { text: string; chunks: number[] }[] | undefined {
  const s = cand.groundingMetadata?.groundingSupports;
  return s?.map((x) => ({ text: x.segment?.text ?? "", chunks: x.groundingChunkIndices ?? [] })).filter((x) => x.text);
}
