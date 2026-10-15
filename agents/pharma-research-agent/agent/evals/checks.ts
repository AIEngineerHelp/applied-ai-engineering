// Deterministic checks on a report: no model needed. They catch citations to
// sources no agent retrieved, uncited sentences, sub-agents that came back
// empty, and knowledge bases the plan used but the report ignored.

import type { EvalResult, Finding, Plan, Report, Source } from "../types.ts";

const CITE = /\[((?:PMID|NCT|FDA|FAERS|WEB)[^\]\s]*)\]/g;

/** The report as sentences, each with the ids it cites. */
export function citedSentences(report: Report): { text: string; ids: string[] }[] {
  const prose = [report.answer, ...report.sections.map((s) => s.body)].join("\n");
  return prose
    .split(/(?<=[.!?])\s+(?=[A-Z(])|\n+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 25 && !t.startsWith("#"))
    .map((text) => ({ text, ids: [...text.matchAll(CITE)].map((m) => m[1]) }));
}

export function checks(report: Report, plan: Plan, findings: Finding[], registry: Map<string, Source>): EvalResult[] {
  const sentences = citedSentences(report);
  const ids = sentences.flatMap((s) => s.ids);
  const valid = ids.filter((id) => registry.has(id));
  const withCite = sentences.filter((s) => s.ids.length);
  const answered = plan.subtasks.filter((t) => findings.find((f) => f.subtask === t.id)?.claims.some((c) => c.sources.length));
  const planned = new Set(plan.subtasks.map((t) => t.source));
  const cited = new Set(valid.map((id) => registry.get(id)!.kind));
  const list: EvalResult[] = [
    {
      name: "Citation validity",
      score: ids.length ? valid.length / ids.length : 0,
      detail: ids.length ? `${valid.length} of ${ids.length} citations point to a source the agents actually retrieved.` : "The report cites nothing.",
      method: "check",
    },
    {
      name: "Citation coverage",
      score: sentences.length ? withCite.length / sentences.length : 0,
      detail: `${withCite.length} of ${sentences.length} sentences carry at least one citation.`,
      method: "check",
    },
    {
      name: "Subtasks answered",
      score: plan.subtasks.length ? answered.length / plan.subtasks.length : 0,
      detail: `${answered.length} of ${plan.subtasks.length} sub-agents returned at least one sourced claim.`,
      method: "check",
    },
    {
      name: "Source diversity",
      score: planned.size ? [...cited].filter((k) => planned.has(k)).length / planned.size : 0,
      detail: `The report cites ${cited.size} of the ${planned.size} knowledge bases the plan used.`,
      method: "check",
    },
  ];
  // An answer from earlier turns ran no sub-agents; scoring them would only report zeros.
  return plan.mode === "answer" ? list.slice(0, 2) : list;
}
