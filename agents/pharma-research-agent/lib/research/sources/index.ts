// The four knowledge bases. Web search has no function tools of its own: the
// web sub-agent makes one grounded model call (Google Search) instead.

import type { SourceKind } from "../types.ts";
import { fdaToolset } from "./fda.ts";
import { pubmedToolset } from "./pubmed.ts";
import type { Toolset } from "./toolset.ts";
import { trialsToolset } from "./trials.ts";

export function createToolsets(): Record<SourceKind, Toolset> {
  return {
    pubmed: pubmedToolset(),
    trials: trialsToolset(),
    fda: fdaToolset(),
    web: { kind: "web", tools: [], call: async () => ({ forModel: {}, sources: [] }) },
  };
}
