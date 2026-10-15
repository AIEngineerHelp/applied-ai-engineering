// Gemini over the REST generateContent endpoint, with no SDK.
// Checked against https://ai.google.dev/api/generate-content on 2026-10-12:
// - structured output: responseMimeType "application/json" + responseJsonSchema
// - tools: functionDeclarations with parametersJsonSchema; googleSearch for grounding
// - function results go back in a "user" turn as functionResponse parts
// - the model's content is echoed back unchanged, so thought signatures survive

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

  async function call(body: unknown): Promise<GenerateResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey ?? "" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 200)}`), { retry: true });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
        return JSON.parse(text) as GenerateResponse;
      } catch (err) {
        lastErr = err;
        const retry = (err as { retry?: boolean }).retry || (err as Error).name === "TimeoutError";
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
          ...(req.schema ? { responseMimeType: "application/json", responseJsonSchema: req.schema } : {}),
        },
      };
      const data = await call(body);
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
      return { text, json, calls, raw: cand.content, usage, grounding, supports: groundingSupports(cand), searches: req.search ? queries.length : undefined, model };
    },
  };
}

/** Which sentences of the answer came from which grounding chunks. */
function groundingSupports(cand: { groundingMetadata?: GroundingMetadata }): { text: string; chunks: number[] }[] | undefined {
  const s = cand.groundingMetadata?.groundingSupports;
  return s?.map((x) => ({ text: x.segment?.text ?? "", chunks: x.groundingChunkIndices ?? [] })).filter((x) => x.text);
}
