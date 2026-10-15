// The output guard: what happens to a report before it is final.
//   1. Citations to sources no agent retrieved are removed (deterministic).
//   2. Personal data is redacted (deterministic).
//   3. A model checks each sentence against the risk catalogue; sentences that
//      break a risk are removed, and the report says so in its limitations.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { citedSentences } from "../evals/checks.ts";
import { callModel } from "../model.ts";
import { policySystem } from "../prompts/guards.ts";
import type { Report, Source, Usage } from "../types.ts";
import { redactPII } from "./pii.ts";
import { RISKS, riskById } from "./risks.ts";

const CITE = /\s?\[((?:PMID|NCT|FDA|FAERS|WEB)[^\]\s]*)\]/g;

/** Applies `fn` to every prose field of a report. */
function mapProse(r: Report, fn: (t: string) => string): Report {
  return { ...r, title: fn(r.title), answer: fn(r.answer), sections: r.sections.map((s) => ({ heading: fn(s.heading), body: fn(s.body) })), limitations: r.limitations.map(fn) };
}

/** Removes citations to ids that are not in the registry; returns the ids removed. */
export function enforceCitations(report: Report, registry: Map<string, Source>): { report: Report; removed: string[] } {
  const removed: string[] = [];
  const out = mapProse(report, (t) =>
    t.replace(CITE, (m, id: string) => {
      if (registry.has(id)) return m;
      removed.push(id);
      return "";
    }),
  );
  return { report: out, removed };
}

export function redactReport(report: Report): { report: Report; found: string[] } {
  const found = new Set<string>();
  const out = mapProse(report, (t) => {
    const r = redactPII(t);
    r.found.forEach((k) => found.add(k));
    return r.text;
  });
  return { report: out, found: [...found] };
}

const OUTPUT_RISKS = RISKS.filter((r) => r.stages.includes("output") && r.behaviour !== "redact").map((r) => r.id);

const POLICY_SCHEMA = {
  type: "object",
  properties: {
    violations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer", description: "The sentence number." },
          risk: { type: "string", enum: OUTPUT_RISKS },
          why: { type: "string", description: "Why the sentence breaks the risk, in one sentence." },
        },
        required: ["n", "risk", "why"],
      },
    },
  },
  required: ["violations"],
};

export interface Violation {
  text: string;
  risk: string;
  why: string;
}

/** Asks the guard model which sentences break a risk. */
export async function policyCheck(model: BaseChatModel, report: Report): Promise<{ violations: Violation[]; usage: Usage; checked: number }> {
  const sentences = citedSentences(report).map((s) => s.text);
  const numbered = sentences.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const r = await callModel(model, [new SystemMessage(policySystem()), new HumanMessage(numbered || "(empty report)")], { schema: POLICY_SCHEMA });
  const raw = (r.json as { violations?: { n: number; risk: string; why: string }[] }).violations ?? [];
  const violations = raw
    .filter((v) => v.n >= 1 && v.n <= sentences.length && OUTPUT_RISKS.includes(v.risk))
    .map((v) => ({ text: sentences[v.n - 1], risk: v.risk, why: v.why }));
  return { violations, usage: r.usage, checked: sentences.length };
}

/** The report without the given sentences, and a limitation saying what was removed and why. */
export function removeSentences(report: Report, violations: Violation[]): Report {
  if (!violations.length) return report;
  const drop = (t: string) => violations.reduce((acc, v) => acc.replace(v.text, ""), t).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const sections = report.sections.map((s) => ({ ...s, body: drop(s.body) })).filter((s) => s.body);
  const risks = [...new Set(violations.map((v) => riskById(v.risk)?.title.toLowerCase() ?? v.risk))];
  const note = `${violations.length === 1 ? "One sentence was" : `${violations.length} sentences were`} removed by the safety check (${risks.join(", ")}).`;
  return { ...report, answer: drop(report.answer), sections, limitations: [...report.limitations, note] };
}
