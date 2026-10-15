// The orchestrator: reads the query and the skill index (names and one-line
// descriptions only), and splits the query into a few subtasks, each tied to
// one knowledge base and the skills its sub-agent should load.

import type { LLM, Schema } from "../llm.ts";
import { skillIndex, type Skill } from "../skills.ts";
import type { Plan, SourceKind } from "../types.ts";

export const SOURCES: { kind: SourceKind; name: string; holds: string }[] = [
  { kind: "pubmed", name: "PubMed", holds: "published studies, trials, meta-analyses and reviews (abstracts)" },
  { kind: "trials", name: "ClinicalTrials.gov", holds: "registered clinical trials: phase, status, size, outcomes, posted results" },
  { kind: "fda", name: "openFDA", holds: "FDA drug labels (boxed warnings, warnings, adverse reactions) and FAERS adverse-event report counts" },
  { kind: "web", name: "Web search", holds: "regulator announcements, approvals, guidance and other public pages" },
];

const PLAN_SCHEMA: Schema = {
  type: "object",
  properties: {
    focus: { type: "string", description: "The research question restated precisely, with drug(s), population and outcome." },
    subtasks: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "One answerable question for one knowledge base." },
          source: { type: "string", enum: SOURCES.map((s) => s.kind) },
          skills: { type: "array", items: { type: "string" }, description: "Names of skills from the index to load for this subtask." },
          why: { type: "string", description: "Why this subtask matters for the query, in one sentence." },
        },
        required: ["question", "source", "skills", "why"],
      },
    },
  },
  required: ["focus", "subtasks"],
};

/**
 * A follow-up first decides whether it needs new evidence at all. "Simplify the
 * answer" or "what does HFpEF mean?" is a rewrite of what the earlier turns
 * already found; searching again wastes a minute and money, and can change the facts.
 */
const FOLLOW_UP_SCHEMA: Schema = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["answer", "research"],
      description: "answer: the earlier answers and their sources already hold everything needed (rewrite, simplify, shorten, translate, explain a term, reformat, compare things already covered). research: the follow-up needs evidence the earlier turns did not gather.",
    },
    reason: { type: "string", description: "Why, in one sentence." },
    focus: (PLAN_SCHEMA.properties as Record<string, Schema>).focus,
    subtasks: { ...(PLAN_SCHEMA.properties as Record<string, Schema>).subtasks, minItems: 0, description: "Empty when mode is answer." },
  },
  required: ["mode", "reason", "focus", "subtasks"],
};

export interface PlanOptions {
  /** Earlier turns of the conversation, so a follow-up is planned in context. */
  context?: string;
  /** Streams the planner's thought summaries. */
  onThought?: (soFar: string) => void;
}

export async function plan(llm: LLM, query: string, skills: Skill[], maxSubtasks: number, opts: PlanOptions = {}): Promise<Plan> {
  const system = [
    "You are the orchestrator of a pharmaceutical research team. You do not answer questions yourself.",
    "Split the research query into 2 to " + maxSubtasks + " subtasks that can run in parallel, each answered from exactly one knowledge base.",
    "Use a knowledge base only if it can answer part of the question. Do not create two subtasks that would run the same search.",
    "",
    "Knowledge bases:",
    ...SOURCES.map((s) => `- ${s.kind}: ${s.name} — ${s.holds}`),
    "",
    "Skills you can assign (load only the ones a subtask needs):",
    skillIndex(skills.filter((s) => s.source !== "synthesis")),
  ].join("\n");
  const followUp = !!opts.context;
  const user = followUp
    ? `${opts.context}\n\nFollow-up: ${query}\n\nFirst decide whether this follow-up needs new research or can be answered from the earlier answers alone. Choose research only if it asks about something the earlier answers do not cover. If research, plan subtasks for the new part only, using the context to resolve what the follow-up refers to.`
    : query;
  const res = await llm.generate({ agent: "orchestrator", system, turns: [{ role: "user", text: user }], schema: followUp ? FOLLOW_UP_SCHEMA : PLAN_SCHEMA, temperature: 0.2, onThought: opts.onThought });
  const raw = res.json as { mode?: string; reason?: string; focus: string; subtasks: { question: string; source: string; skills: string[]; why: string }[] };
  if (followUp && raw.mode === "answer") return { focus: raw.focus, subtasks: [], mode: "answer", reason: raw.reason };
  const known = new Set(skills.map((s) => s.name));
  const kinds = new Set<string>(SOURCES.map((s) => s.kind));
  // Keep the model honest: real sources, real skills, a bounded number of subtasks.
  const subtasks = raw.subtasks
    .filter((t) => kinds.has(t.source) && t.question?.trim())
    .slice(0, maxSubtasks)
    .map((t, i) => ({
      id: `agent-${i + 1}`,
      question: t.question.trim(),
      source: t.source as SourceKind,
      skills: (t.skills ?? []).filter((n) => known.has(n)),
      why: t.why ?? "",
    }));
  if (!subtasks.length) throw new Error("The orchestrator produced no usable subtasks");
  return { focus: raw.focus, subtasks, mode: "research", ...(raw.reason ? { reason: raw.reason } : {}) };
}
