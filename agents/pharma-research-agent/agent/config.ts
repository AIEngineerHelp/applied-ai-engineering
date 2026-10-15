// Which model and knowledge bases a run uses. With GEMINI_API_KEY: Gemini and
// the live public APIs. Without it, outside production: the offline stand-in
// (scripted model, recorded sources), so the app works end to end locally.

import { fixtureToolsets } from "./offline/toolsets.ts";
import { createToolsets } from "./tools/index.ts";
import type { Toolset } from "./tools/toolset.ts";
import type { SourceKind } from "./types.ts";

export function isOffline(): boolean {
  if (process.env.RESEARCH_OFFLINE === "1") return true;
  return !process.env.GEMINI_API_KEY && process.env.NODE_ENV !== "production";
}

export function getToolsets(): Record<SourceKind, Toolset> {
  return isOffline() ? fixtureToolsets() : createToolsets();
}

export const modelName = () => (isOffline() ? "offline (scripted)" : process.env.GEMINI_MODEL || "gemini-3.8-flash");
