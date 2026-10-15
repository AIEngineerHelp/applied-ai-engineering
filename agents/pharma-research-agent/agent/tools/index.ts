// The four knowledge bases, and what each holds. Web search has no function tools of its own: the
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

/** What each knowledge base holds, as the planner sees it. */
export const KNOWLEDGE_BASES: { kind: SourceKind; name: string; holds: string }[] = [
  { kind: "pubmed", name: "PubMed", holds: "published studies, trials, meta-analyses and reviews (abstracts)" },
  { kind: "trials", name: "ClinicalTrials.gov", holds: "registered clinical trials: phase, status, size, outcomes, posted results" },
  { kind: "fda", name: "openFDA", holds: "FDA drug labels (boxed warnings, warnings, adverse reactions) and FAERS adverse-event report counts" },
  { kind: "web", name: "Web search", holds: "regulator announcements, approvals, guidance and other public pages" },
];
