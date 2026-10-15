// Which model and knowledge bases a run uses. With GEMINI_API_KEY: Gemini and
// the live public APIs. Without it, outside production: the offline stand-in
// (scripted model, recorded sources), so the app works end to end locally.

import { createGemini } from "./gemini";
import type { LLM } from "./llm";
import { fixtureToolsets, offlineLLM } from "./offline";
import { createToolsets } from "./sources";
import type { Toolset } from "./sources/toolset";
import type { SourceKind } from "./types";

export function isOffline(): boolean {
  if (process.env.RESEARCH_OFFLINE === "1") return true;
  return !process.env.GEMINI_API_KEY && process.env.NODE_ENV !== "production";
}

export function getRuntime(): { llm: LLM; toolsets: Record<SourceKind, Toolset> } {
  if (isOffline()) return { llm: offlineLLM(), toolsets: fixtureToolsets() };
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const llm = createGemini();
  return { llm, toolsets: createToolsets() };
}

export const modelName = () => (isOffline() ? "offline (scripted)" : process.env.GEMINI_MODEL || "gemini-3.8-flash");
