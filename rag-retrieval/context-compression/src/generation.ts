import { compress, defaults } from "./compress.ts";

export interface GenerationConfig { key?: string; answerModel?: string; judgeModel?: string }
export interface Usage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
export interface ModelCall { kind: "answer" | "agent" | "judge"; model: string; system: string; payload: Record<string, unknown>; schema: object }
export interface ModelReply { value: unknown; model: string; usage: Usage; durationMs: number }
export type Generator = (call: ModelCall) => Promise<ModelReply>;
export const generationFromEnv = (): GenerationConfig => ({ key: process.env.GEMINI_API_KEY,
  answerModel: process.env.GEMINI_ANSWER_MODEL, judgeModel: process.env.GEMINI_JUDGE_MODEL ?? process.env.GEMINI_ANSWER_MODEL });
const validModel = (name: string | undefined) => Boolean(name && /^[\w.-]+$/.test(name));
export const generationReady = (config: GenerationConfig) => Boolean(config.key && validModel(config.answerModel) && validModel(config.judgeModel));

export function geminiGenerator(config: GenerationConfig, fetcher: typeof fetch = fetch): Generator {
  return async (call) => {
    if (!config.key || !validModel(call.model)) throw new Error("Configure GEMINI_API_KEY and explicit Gemini model identifiers first.");
    const started = performance.now();
    const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${call.model}:generateContent`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: call.system }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(call.payload) }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json", responseJsonSchema: call.schema } }),
    });
    if (!response.ok) throw new Error(`Gemini request failed with HTTP ${response.status}. No retry was attempted.`);
    const body = await response.json() as { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[]; modelVersion?: string; usageMetadata?: Record<string, unknown> };
    const candidate = body.candidates?.[0];
    if (!candidate || candidate.finishReason !== "STOP") throw new Error("Gemini did not return a complete answer (blocked, truncated, or unavailable).");
    const text = candidate.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
    if (!text || text.length > 20000) throw new Error("Missing or oversized Gemini JSON output.");
    const token = (key: string) => typeof body.usageMetadata?.[key] === "number" && Number.isInteger(body.usageMetadata[key]) && (body.usageMetadata[key] as number) >= 0 ? body.usageMetadata[key] as number : null;
    return { value: JSON.parse(text), model: body.modelVersion ?? call.model, durationMs: performance.now() - started,
      usage: { inputTokens: token("promptTokenCount"), outputTokens: token("candidatesTokenCount"), totalTokens: token("totalTokenCount") } };
  };
}

// A visible, model-free driver for learning the orchestration. No quality claims.
export const fixtureGenerator: Generator = async (call) => {
  const extract = (context: string, question: string) => compress(context, { ...defaults, query: question, threshold: 0, remove: 55 }).text.trim() || "No matching evidence in the supplied context.";
  let value: unknown;
  if (call.kind === "answer") value = { answer: extract(String(call.payload.context), String(call.payload.question)), citations: [] };
  else if (call.kind === "judge") {
    const answers = call.payload.answers as { A: string; B: string };
    value = { verdict: answers.A === answers.B ? "equivalent" : "uncertain", reason: "Scripted fixture: compares exact answer strings only; this is not an LLM judgment or an answer-quality measurement." };
  } else {
    const history = call.payload.history as { action: string; id?: string; query?: string; text: string }[];
    const catalog = call.payload.catalog as { id: string; title: string }[];
    if (!history.length) value = { action: "search", query: String(call.payload.question), id: "", focus: "Find primary evidence and any exceptions or corrections.", answer: "", citations: [] };
    else if (history.length === 1) value = { action: "read", query: "", id: catalog.at(-1)!.id, focus: "Read the additional source for exceptions or follow-up details.", answer: "", citations: [] };
    else value = { action: "finish", query: "", id: "", focus: "", answer: extract(history.map((h) => h.text).join("\n\n"), String(call.payload.question)), citations: [] };
  }
  return { value, model: "scripted-fixture-NOT-AN-LLM", durationMs: 0, usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
};
