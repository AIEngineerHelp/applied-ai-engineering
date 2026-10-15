// Evals for one run. Four are deterministic checks that need no model; one,
// groundedness, asks a judge model whether each cited sentence is supported by
// the sources it cites.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callModel } from "./model.ts";

type Schema = Record<string, unknown>;
import type { Tracer } from "./trace.ts";
import type { EvalResult, Finding, Plan, Report, Source } from "./types.ts";

/**
 * The passages of a source most relevant to a claim: the source split into
 * ~500-character chunks, ranked by how many of the claim's words they share.
 * A judge given only the first part of a long label would miss evidence that
 * sits in section 5.
 */
export function relevant(text: string, claim: string, budget = 1500): string {
  if (text.length <= budget) return text;
  const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "were", "was", "are", "has", "have", "had", "not", "but", "its", "their", "than", "into", "per"]);
  const terms = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9][a-z0-9.-]{2,}/g) ?? []).map((w) => w.replace(/[.,-]+$/, "")).filter((w) => !STOP.has(w)));
  const want = terms(claim);
  const chunks = text.match(/[\s\S]{1,500}(?=\s|$)/g) ?? [text];
  // Score each chunk by how many distinct claim words it contains.
  const scored = chunks.map((c, i) => ({ i, c, score: [...terms(c)].filter((w) => want.has(w)).length }));
  const keep = scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(1, Math.floor(budget / 500)))
    .sort((a, b) => a.i - b.i);
  // Neighbouring chunks join without a break; gaps are marked with an ellipsis.
  return keep.map((k, j) => (j && keep[j - 1].i === k.i - 1 ? "" : j ? " … " : "") + k.c).join("").trim();
}

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

const JUDGE_SCHEMA: Schema = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          verdict: { type: "string", enum: ["supported", "partial", "unsupported"] },
          reason: { type: "string" },
        },
        required: ["n", "verdict", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

/** Judge up to `limit` cited sentences against the text of the sources they cite. */
export async function groundedness(model: BaseChatModel, tracer: Tracer, report: Report, registry: Map<string, Source>, parent: string, limit = 12): Promise<EvalResult & { verdicts: { text: string; verdict: string; reason: string }[] }> {
  const items = citedSentences(report)
    .filter((s) => s.ids.some((id) => registry.has(id)))
    .slice(0, limit);
  if (!items.length) return { name: "Groundedness", score: 0, detail: "No cited sentences to judge.", method: "judge", verdicts: [] };
  const prompt = items
    .map((s, i) => {
      const evidence = s.ids
        .filter((id) => registry.has(id))
        .map((id) => `  [${id}] ${registry.get(id)!.title}\n  ${relevant(registry.get(id)!.text, s.text)}`)
        .join("\n");
      return `${i + 1}. CLAIM: ${s.text}\n  EVIDENCE:\n${evidence}`;
    })
    .join("\n\n");
  const res = await tracer.wrap("llm", "judge groundedness", parent, async (span) => {
    const r = await callModel(
      model,
      [
        new SystemMessage("You check claims against evidence. For each numbered claim, decide if the evidence text supports it: supported (fully), partial (some of it, or a number differs), unsupported (not in the evidence). Judge only from the evidence given."),
        new HumanMessage(prompt),
      ],
      { schema: JUDGE_SCHEMA },
    );
    tracer.addUsage(r.usage);
    tracer.close(span, { model: model.getName(), input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost });
    return r;
  });
  const verdicts = ((res.json as { verdicts: { n: number; verdict: string; reason: string }[] }).verdicts ?? [])
    .filter((v) => v.n >= 1 && v.n <= items.length)
    .map((v) => ({ text: items[v.n - 1].text, verdict: v.verdict, reason: v.reason }));
  const score = verdicts.length ? verdicts.reduce((n, v) => n + (v.verdict === "supported" ? 1 : v.verdict === "partial" ? 0.5 : 0), 0) / verdicts.length : 0;
  const ok = verdicts.filter((v) => v.verdict === "supported").length;
  return { name: "Groundedness", score, detail: `${ok} of ${verdicts.length} judged sentences are fully supported by the sources they cite.`, method: "judge", verdicts };
}
