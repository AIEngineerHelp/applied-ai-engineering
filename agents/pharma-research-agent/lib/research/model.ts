// The chat model every agent uses, through LangChain: Gemini via ChatGoogle
// (@langchain/google), or the scripted stand-in in offline mode. `callModel`
// streams one call and returns what the agents need: the message (to keep in
// the conversation, thought signatures included), its text, the model's
// thought summaries, parsed JSON, grounding, and usage with cost.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatGoogle } from "@langchain/google/node";
import { ScriptedChatModel } from "./offline.ts";
import { isOffline, modelName } from "./runtime.ts";
import type { Usage } from "./types.ts";

export function chatModel(): BaseChatModel {
  if (isOffline()) return new ScriptedChatModel({});
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  return new ChatGoogle({
    model: modelName(),
    apiKey: process.env.GEMINI_API_KEY,
    // Setting a thinking level is what makes Gemini return thought summaries, which the UI streams.
    reasoningEffort: (process.env.GEMINI_THINKING_LEVEL as "low" | "medium" | "high" | undefined) ?? "high",
    maxRetries: 2,
  });
}

/** A Gemini built-in tool (Google Search) or a LangChain tool. */
export type ModelTool = StructuredToolInterface | Record<string, unknown>;

export interface CallOptions {
  tools?: ModelTool[];
  /** Require a call to this tool (e.g. "finish" on a sub-agent's last turn). */
  toolChoice?: string;
  /** Ask for JSON matching this JSON schema; the result is parsed into `json`. */
  schema?: Record<string, unknown>;
  /** The thought summary so far, as it streams. */
  onThought?: (soFar: string) => void;
  /** The answer text so far, as it streams. */
  onText?: (soFar: string) => void;
}

export interface CallResult {
  /** The model's message, to append to the conversation as is. */
  message: AIMessageChunk;
  text: string;
  thoughts: string;
  json?: unknown;
  usage: Usage;
  /** With Google Search: the web pages used, and which sentences came from which pages. */
  grounding?: { title: string; url: string; text: string }[];
  supports?: { text: string; chunks: number[] }[];
  /** Grounded web searches run (billed per query). */
  searches?: number;
}

const num = (v: string | undefined) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Text of the reasoning blocks: Gemini's thought summaries. */
const thoughtsOf = (m: AIMessageChunk) => m.contentBlocks.filter((b) => b.type === "reasoning").map((b) => (b as { reasoning: string }).reasoning).join("");

export async function callModel(model: BaseChatModel, messages: BaseMessage[], o: CallOptions = {}): Promise<CallResult> {
  if (o.tools?.length && !model.bindTools) throw new Error("This model does not support tools");
  const runnable = o.tools?.length ? model.bindTools!(o.tools, o.toolChoice ? { tool_choice: o.toolChoice } : undefined) : model;
  // ChatGoogle takes the response schema per call; the scripted model reads the same option.
  const stream = await runnable.stream(messages, (o.schema ? { responseSchema: o.schema } : {}) as never);
  let message: AIMessageChunk | undefined;
  let thoughts = "";
  let text = "";
  for await (const chunk of stream) {
    message = message ? message.concat(chunk) : chunk;
    const t = thoughtsOf(chunk);
    if (t) o.onThought?.((thoughts += t));
    const x = chunk.text;
    if (x) o.onText?.((text += x));
  }
  if (!message) throw new Error("The model returned nothing");
  text = message.text;
  thoughts = thoughtsOf(message) || thoughts;

  const meta = message.response_metadata as { groundingMetadata?: GroundingMetadata } | undefined;
  const g = meta?.groundingMetadata;
  const searches = g?.webSearchQueries?.length;
  const result: CallResult = { message, text, thoughts, usage: usageOf(model, message, searches) };
  if (o.schema) result.json = parseJson(text);
  if (g) {
    const chunks = g.groundingChunks ?? [];
    const supports = g.groundingSupports ?? [];
    result.grounding = chunks.map((c, i) => ({
      title: c.web?.title ?? `Source ${i + 1}`,
      url: c.web?.uri ?? "",
      text: supports.filter((s) => s.groundingChunkIndices?.includes(i)).map((s) => s.segment?.text ?? "").filter(Boolean).join(" "),
    }));
    result.supports = supports.map((s) => ({ text: s.segment?.text ?? "", chunks: s.groundingChunkIndices ?? [] })).filter((s) => s.text);
    result.searches = searches ?? 0;
  }
  return result;
}

interface GroundingMetadata {
  groundingChunks?: { web?: { uri?: string; title?: string } }[];
  groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[];
  webSearchQueries?: string[];
}

/**
 * Tokens and cost of one call. LangChain counts thinking inside output tokens;
 * they are split out here because the UI shows them separately. Prices come
 * from the environment; without them, cost is unknown rather than zero.
 */
function usageOf(model: BaseChatModel, m: AIMessageChunk, searches?: number): Usage {
  const u = m.usage_metadata;
  const thinking = u?.output_token_details?.reasoning ?? 0;
  const input = u?.input_tokens ?? 0;
  const output = Math.max(0, (u?.output_tokens ?? 0) - thinking);
  if (model instanceof ScriptedChatModel) return { input, output, thinking, cost: 0 };
  const inP = num(process.env.GEMINI_INPUT_USD_PER_MILLION);
  const outP = num(process.env.GEMINI_OUTPUT_USD_PER_MILLION);
  const searchP = num(process.env.GEMINI_SEARCH_USD_PER_QUERY);
  let cost = inP !== undefined && outP !== undefined ? (input * inP + (output + thinking) * outP) / 1e6 : undefined;
  if (cost !== undefined && searches) cost = searchP !== undefined ? cost + searches * searchP : undefined;
  return { input, output, thinking, cost };
}

/** Pulls the first JSON object out of a model's text (fenced or bare). */
export function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[{[]/);
  if (start < 0) throw new Error("No JSON in model output");
  return JSON.parse(body.slice(start, body.lastIndexOf(body[start] === "{" ? "}" : "]") + 1));
}
