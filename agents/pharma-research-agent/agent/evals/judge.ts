// The groundedness judge: a model checks each cited sentence against the
// passages of the sources it cites that are most relevant to it.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callModel } from "../model.ts";
import { JUDGE_SYSTEM } from "../prompts/judge.ts";
import type { Tracer } from "../trace.ts";
import type { EvalResult, Report, Source } from "../types.ts";
import { citedSentences } from "./checks.ts";

type Schema = Record<string, unknown>;

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
        new SystemMessage(JUDGE_SYSTEM),
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
