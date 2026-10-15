// The one interface every agent uses to call a model. The Gemini client lives
// in gemini.ts; the offline model in offline.ts replays a recorded run so the
// whole pipeline can be run and tested without an API key.

import type { Usage } from "./types.ts";

/** A JSON schema object (the subset both providers accept). */
export type Schema = Record<string, unknown>;

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Schema;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** A conversation turn, kept provider-neutral. `raw` round-trips provider parts. */
export type Turn =
  | { role: "user"; text: string }
  | { role: "model"; text: string; calls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: { name: string; response: unknown }[] };

export interface GenerateRequest {
  /** Which agent is calling, for the trace and for the offline model. */
  agent: string;
  system: string;
  turns: Turn[];
  tools?: ToolDecl[];
  /** Ask for JSON matching this schema. */
  schema?: Schema;
  /** Require a call to this one tool (e.g. "finish" on the last turn). */
  force?: string;
  /** Let the model search the web; its sources come back in `grounding`. */
  search?: boolean;
  temperature?: number;
  /** Streams the model's thought summaries as they arrive (the text so far). */
  onThought?: (soFar: string) => void;
  /** Streams the answer text as it arrives (the text so far). */
  onText?: (soFar: string) => void;
}

export interface GenerateResult {
  text: string;
  /** Parsed JSON when a schema was given. */
  json?: unknown;
  calls: ToolCall[];
  /** Pass back in the next turn so the provider can continue (e.g. thought signatures). */
  raw?: unknown;
  usage: Usage;
  /** Web sources the model used, when `search` was on. */
  grounding?: { title: string; url: string; text: string }[];
  /** Which sentences of the answer came from which grounding sources (indices into `grounding`). */
  supports?: { text: string; chunks: number[] }[];
  /** The model's thought summaries, when requested. */
  thoughts?: string;
  /** How many web searches the model ran (grounding is billed per query). */
  searches?: number;
  model: string;
}

export interface LLM {
  readonly model: string;
  readonly mode: "live" | "offline";
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Pulls the first JSON object out of a model's text (fenced or bare). */
export function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[{[]/);
  if (start < 0) throw new Error("No JSON in model output");
  return JSON.parse(body.slice(start, body.lastIndexOf(body[start] === "{" ? "}" : "]") + 1));
}
