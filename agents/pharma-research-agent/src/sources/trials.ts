// Knowledge base 2: ClinicalTrials.gov, API v2 (https://clinicaltrials.gov/api/v2/studies).
// No key. No published rate limit; we keep requests few and back off on 429.

import type { Source } from "../types.ts";
import { clip, getJson, limiter, type Toolset } from "./toolset.ts";

const BASE = "https://clinicaltrials.gov/api/v2/studies";

/** Normalises one study from the v2 API. */
export function studyToSource(study: any): Source {
  const p = study.protocolSection ?? {};
  const id = p.identificationModule?.nctId ?? "NCT?";
  const status = p.statusModule ?? {};
  const design = p.designModule ?? {};
  const outcomes: { measure?: string; timeFrame?: string }[] = p.outcomesModule?.primaryOutcomes ?? [];
  const phases: string[] = design.phases ?? [];
  const phase = phases.map((x) => x.replace("PHASE", "Phase ").replace("EARLY_", "Early ").replace("NA", "N/A")).join("/") || "N/A";
  const conditions: string[] = p.conditionsModule?.conditions ?? [];
  const interventions: string[] = (p.armsInterventionsModule?.interventions ?? []).map((i: { name?: string }) => i.name ?? "");
  const enrollment = design.enrollmentInfo?.count;
  const text = [
    `Conditions: ${conditions.join("; ")}`,
    `Interventions: ${interventions.join("; ")}`,
    `Phase: ${phase}. Status: ${status.overallStatus ?? "unknown"}. Enrollment: ${enrollment ?? "unknown"} (${design.enrollmentInfo?.type ?? ""}).`,
    `Start: ${status.startDateStruct?.date ?? "?"}. Primary completion: ${status.primaryCompletionDateStruct?.date ?? "?"}.`,
    `Primary outcome: ${outcomes.map((o) => `${o.measure}${o.timeFrame ? ` (${o.timeFrame})` : ""}`).join("; ") || "not listed"}.`,
    `Results posted: ${study.hasResults ? "yes" : "no"}.`,
  ].join("\n");
  return {
    id,
    kind: "trials",
    title: p.identificationModule?.briefTitle ?? id,
    url: `https://clinicaltrials.gov/study/${id}`,
    text,
    meta: { phase, status: status.overallStatus, enrollment, year: Number(String(status.startDateStruct?.date ?? "").slice(0, 4)) || undefined, results: !!study.hasResults },
  };
}

export function trialsToolset(): Toolset {
  const wait = limiter(2);
  return {
    kind: "trials",
    tools: [
      {
        name: "search_trials",
        description: "Search ClinicalTrials.gov. Returns trials with phase, status, enrollment, primary outcome and whether results are posted.",
        parameters: {
          type: "object",
          properties: {
            intervention: { type: "string", description: "Drug or drug class, e.g. tirzepatide." },
            condition: { type: "string", description: "Condition, e.g. heart failure. Optional." },
            phase3_only: { type: "boolean", description: "Only phase 3 trials." },
            max: { type: "integer", minimum: 1, maximum: 15, description: "How many trials, 1-15 (default 10)." },
          },
          required: ["intervention"],
        },
      },
    ],
    async call(name, args) {
      if (name !== "search_trials") throw new Error(`Unknown tool ${name}`);
      const q = new URLSearchParams({
        "query.intr": String(args.intervention ?? ""),
        pageSize: String(Math.min(15, Math.max(1, Number(args.max) || 10))),
        countTotal: "true",
        sort: "@relevance",
        format: "json",
      });
      if (args.condition) q.set("query.cond", String(args.condition));
      if (args.phase3_only) q.set("query.term", "AREA[Phase]PHASE3");
      await wait();
      const data = (await getJson(`${BASE}?${q}`)) as { totalCount?: number; studies?: unknown[] } | null;
      const sources = (data?.studies ?? []).map(studyToSource);
      return {
        forModel: {
          total: data?.totalCount ?? sources.length,
          trials: sources.map((s) => ({ id: s.id, title: s.title, phase: s.meta.phase, status: s.meta.status, enrollment: s.meta.enrollment, results_posted: s.meta.results, primary_outcome: clip(s.text.split("\n").find((l) => l.startsWith("Primary outcome")), 240) })),
        },
        sources,
      };
    },
  };
}
