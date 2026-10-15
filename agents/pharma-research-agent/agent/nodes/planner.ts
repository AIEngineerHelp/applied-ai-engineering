// The planner node. It reads the query and the skill index (names and one-line
// descriptions only), and splits the query into a few subtasks, each tied to
// one knowledge base and the skills its sub-agent should load. For a follow-up
// it first decides whether new research is needed at all.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callModel, chatModel } from "../model.ts";
import { followUpRequest, plannerSystem } from "../prompts/planner.ts";
import { loadSkills, skillIndex, type Skill } from "../skills/index.ts";
import type { RunState } from "../state.ts";
import type { RunBudget } from "../limits.ts";
import type { RunStore } from "../store.ts";
import { KNOWLEDGE_BASES } from "../tools/index.ts";
import type { Plan, SourceKind, Usage } from "../types.ts";
import { conversationContext, nodeContext, thoughtStream } from "./context.ts";

type Schema = Record<string, unknown>;

export const MAX_SUBTASKS = 4;

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
          source: { type: "string", enum: KNOWLEDGE_BASES.map((s) => s.kind) },
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
  /** Receives the call's token usage and cost. */
  onUsage?: (u: Usage) => void;
}

export async function plan(model: BaseChatModel, query: string, skills: Skill[], maxSubtasks: number, opts: PlanOptions = {}): Promise<Plan> {
  const system = plannerSystem(maxSubtasks, KNOWLEDGE_BASES, skillIndex(skills.filter((s) => s.source !== "synthesis")));
  const followUp = !!opts.context;
  const user = followUp ? followUpRequest(opts.context!, query) : query;
  const res = await callModel(model, [new SystemMessage(system), new HumanMessage(user)], { schema: followUp ? FOLLOW_UP_SCHEMA : PLAN_SCHEMA, onThought: opts.onThought });
  opts.onUsage?.(res.usage);
  const raw = res.json as { mode?: string; reason?: string; focus: string; subtasks: { question: string; source: string; skills: string[]; why: string }[] };
  if (followUp && raw.mode === "answer") return { focus: raw.focus, subtasks: [], mode: "answer", reason: raw.reason };
  const known = new Set(skills.map((s) => s.name));
  const kinds = new Set<string>(KNOWLEDGE_BASES.map((s) => s.kind));
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

export const plannerNode = (store: RunStore, budget?: RunBudget) => async (s: RunState): Promise<Partial<RunState>> => {
  const { run, sink, tracer, vfs, done } = await nodeContext(store, s.reportId, "plan", budget);
  const skills = loadSkills();
  // The input guard may have turned a personal question into its general form.
  const question = s.screen?.question ?? run.query;
  sink.emit({ type: "skills", available: skills.map((x) => ({ name: x.name, description: x.description })) });

  const context = conversationContext(await store.earlierTurns(s.reportId));
  const thought = thoughtStream(sink, "orchestrator");
  const p = await tracer.wrap("agent", "orchestrator", "run", async (span) =>
    tracer.wrap("llm", "plan subtasks", span.id, async (sp) => {
      const r = await plan(chatModel(budget), question, skills, MAX_SUBTASKS, { context, onThought: (t) => thought("plan", t, false), onUsage: (u) => tracer.addUsage(u) });
      tracer.close(sp, { subtasks: r.subtasks.length, input: tracer.usage.input, output: tracer.usage.output, cost: tracer.usage.cost });
      return r;
    }),
  );
  thought("plan", "", true);
  vfs.write("/plan.md", ["# Plan", "", p.focus, "", ...(p.mode === "answer" ? [`No new research: ${p.reason ?? "answered from the earlier turns."}`] : []), ...p.subtasks.map((t) => `- **${t.id}** (${t.source}; skills: ${t.skills.join(", ") || "none"}): ${t.question}`)].join("\n"), "orchestrator");
  sink.emit({ type: "plan", plan: p, loaded: [...new Set(p.subtasks.flatMap((t) => t.skills))] });
  await done();
  await store.save(s.reportId, { plan: p });
  return { plan: p };
};
