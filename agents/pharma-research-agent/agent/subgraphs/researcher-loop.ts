// A research sub-agent's loop: one subtask, one knowledge base, its assigned skills.
// It is a small LangGraph graph of its own — a model node and a tools node in
// a loop — that ends when the model calls `finish` with claims tied to source
// ids. Full documents go to the virtual file system; the model sees only short
// excerpts.
//
//   START → model ─┬─ tool calls ──→ tools ──→ model
//                  ├─ finish ──────→ finish → END
//                  └─ no call ─────→ model (nudged)
//
// The turn limit lives in the graph's state: on the last turn the model is
// given only `finish`, and forced to call it.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Annotation, END, MessagesAnnotation, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { callModel } from "../model.ts";
import { LAST_TURN, NUDGE, WEB_INSTRUCTIONS, researcherSystem, subtaskMessage } from "../prompts/researcher.ts";
import type { Skill } from "../skills/index.ts";
import { asLangChainTools, type Toolset } from "../tools/toolset.ts";
import type { Tracer } from "../trace.ts";
import type { Finding, Source, Subtask } from "../types.ts";
import type { VirtualFS } from "../vfs.ts";

export const MAX_TURNS = 6;

/** The tool that ends the loop. It is never executed: its arguments are the finding. */
const finishTool = tool(async () => "recorded", {
  name: "finish",
  description: "Call once, when you have enough evidence or have run out of useful searches. Every claim must cite source ids you retrieved.",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Two or three sentences answering your subtask." },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "One factual claim, with the number if there is one." },
            sources: { type: "array", items: { type: "string" }, description: "Source ids exactly as given, e.g. PMID:12345678." },
          },
          required: ["text", "sources"],
        },
      },
      gaps: { type: "array", items: { type: "string" }, description: "What you looked for and could not find." },
    },
    required: ["summary", "claims", "gaps"],
  },
});

export interface ResearchContext {
  model: BaseChatModel;
  tracer: Tracer;
  vfs: VirtualFS;
  /** Every source any agent retrieved, by id. */
  registry: Map<string, Source>;
  onSources: (subtask: string, sources: Source[]) => void;
  /** Streams a sub-agent's thought summary for one model call (key identifies the call). */
  onThought?: (key: string, soFar: string, done: boolean) => void;
}

/** The sub-agent's state: its conversation, how many turns it has used, and its finding once done. */
const SubAgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  turn: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  finding: Annotation<Finding | undefined>(),
});
type SubAgent = typeof SubAgentState.State;

/** The markdown file a source is saved as. */
export const sourceFile = (s: Source) => `/sources/${s.kind}/${s.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.md`;

function saveSources(ctx: ResearchContext, task: Subtask, sources: Source[]) {
  const fresh = sources.filter((s) => !ctx.registry.has(s.id));
  for (const s of fresh) {
    ctx.registry.set(s.id, s);
    const meta = Object.entries(s.meta).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `- ${k}: ${v}`).join("\n");
    ctx.vfs.write(sourceFile(s), `# ${s.title}\n\nid: ${s.id}\nurl: ${s.url}\n${meta}\n\n${s.text}\n`, task.id);
  }
  if (sources.length) ctx.onSources(task.id, sources);
}

const lastAI = (messages: BaseMessage[]) => [...messages].reverse().find((m): m is AIMessage => AIMessage.isInstance(m) || m.type === "ai") as AIMessage | undefined;

export async function research(ctx: ResearchContext, task: Subtask, toolset: Toolset, skills: Skill[], parent: string, config?: LangGraphRunnableConfig): Promise<Finding> {
  return ctx.tracer.wrap("agent", `${task.id} · ${toolset.kind}`, parent, async (span) => {
    const playbooks = skills.filter((s) => task.skills.includes(s.name));
    const system = researcherSystem(toolset.kind, MAX_TURNS, playbooks);

    // Web search has no function tools: one grounded call, sources from the grounding metadata.
    if (toolset.kind === "web") return webResearch(ctx, task, system, span.id);

    const tools = asLangChainTools(toolset);
    const byName = new Map(tools.map((t) => [t.name, t]));

    const model = async (s: SubAgent) => {
      const turn = s.turn + 1;
      const last = turn >= MAX_TURNS;
      const key = `${task.id}:t${turn}`;
      const r = await ctx.tracer.wrap("llm", `${task.id} turn ${turn}`, span.id, async (sp) => {
        const r = await callModel(ctx.model, s.messages, {
          tools: last ? [finishTool] : [...tools, finishTool],
          toolChoice: last ? "finish" : undefined,
          onThought: ctx.onThought ? (t) => ctx.onThought!(key, t, false) : undefined,
        });
        if (ctx.onThought && r.thoughts) ctx.onThought(key, r.thoughts, true);
        ctx.tracer.addUsage(r.usage);
        ctx.tracer.close(sp, { model: ctx.model.getName(), input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost, calls: (r.message.tool_calls ?? []).map((c) => c.name).join(", ") });
        return r;
      });
      const messages: BaseMessage[] = [r.message];
      if (!r.message.tool_calls?.length && !last) messages.push(new HumanMessage(NUDGE));
      return { messages, turn };
    };

    const runTools = async (s: SubAgent) => {
      const calls = lastAI(s.messages)?.tool_calls ?? [];
      const left = MAX_TURNS - s.turn;
      const out: ToolMessage[] = [];
      for (const call of calls) {
        const t = byName.get(call.name);
        const { content, sources } = await ctx.tracer.wrap("tool", call.name, span.id, async (sp) => {
          ctx.tracer.addToolCall();
          const msg = t ? ((await t.invoke({ ...call, type: "tool_call" })) as ToolMessage) : undefined;
          const sources = (msg?.artifact ?? []) as Source[];
          ctx.tracer.close(sp, { args: JSON.stringify(call.args).slice(0, 200), results: sources.length });
          return { content: msg?.text ?? JSON.stringify({ error: `Unknown tool ${call.name}` }), sources };
        });
        saveSources(ctx, task, sources);
        // Every result carries the remaining budget, so the model can plan its last search.
        let body: Record<string, unknown>;
        try {
          const parsed = JSON.parse(content) as unknown;
          body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as object) } : { result: parsed };
        } catch {
          body = { result: content };
        }
        body.turns_left = left;
        if (left === 1) body.note = LAST_TURN;
        out.push(new ToolMessage({ content: JSON.stringify(body), tool_call_id: call.id ?? call.name, name: call.name }));
      }
      return { messages: out };
    };

    const done = async (s: SubAgent) => {
      const call = (lastAI(s.messages)?.tool_calls ?? []).find((c) => c.name === "finish");
      // Out of turns without finishing: record an honest empty finding.
      const args = call?.args ?? { summary: "The sub-agent ran out of turns before finishing.", claims: [], gaps: [task.question] };
      return { finding: finish(ctx, task, args) };
    };

    const route = (s: SubAgent) => {
      const calls = lastAI(s.messages)?.tool_calls ?? [];
      if (calls.some((c) => c.name === "finish")) return "finish";
      if (s.turn >= MAX_TURNS) return "finish";
      return calls.length ? "tools" : "model";
    };

    const graph = new StateGraph(SubAgentState)
      .addNode("model", model)
      .addNode("tools", runTools)
      .addNode("finish", done)
      .addEdge(START, "model")
      .addConditionalEdges("model", route, ["tools", "finish", "model"])
      .addEdge("tools", "model")
      .addEdge("finish", END)
      .compile({ name: `researcher-${task.id}` });

    const out = await graph.invoke(
      { messages: [new SystemMessage(system), new HumanMessage(subtaskMessage(task))] },
      { ...config, recursionLimit: 4 * MAX_TURNS },
    );
    return out.finding ?? finish(ctx, task, { summary: "The sub-agent stopped without a finding.", claims: [], gaps: [task.question] });
  });
}

async function webResearch(ctx: ResearchContext, task: Subtask, system: string, parent: string): Promise<Finding> {
  const res = await ctx.tracer.wrap("llm", `${task.id} web search`, parent, async (s) => {
    const r = await callModel(
      ctx.model,
      [new SystemMessage(`${system}\n\n${WEB_INSTRUCTIONS}`), new HumanMessage(task.question)],
      { tools: [{ googleSearch: {} }], onThought: ctx.onThought ? (t) => ctx.onThought!(`${task.id}:web`, t, false) : undefined },
    );
    if (ctx.onThought && r.thoughts) ctx.onThought(`${task.id}:web`, r.thoughts, true);
    ctx.tracer.addUsage(r.usage);
    ctx.tracer.addToolCall();
    ctx.tracer.close(s, { model: ctx.model.getName(), input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost, results: r.grounding?.length ?? 0, searches: r.searches });
    return r;
  });
  const sources: Source[] = (res.grounding ?? []).map((g, i) => ({
    id: `WEB:${task.id.replace("agent-", "")}.${i + 1}`,
    kind: "web",
    title: g.title,
    url: g.url,
    text: g.text,
    meta: { host: safeHost(g.url) },
  }));
  saveSources(ctx, task, sources);
  // Each grounded sentence becomes a claim citing exactly the pages it came from.
  const claims = (res.supports ?? [])
    .map((sup) => ({ text: sup.text.trim(), sources: [...new Set(sup.chunks)].map((i) => sources[i]?.id).filter((x): x is string => !!x) }))
    .filter((c) => c.text.length > 30 && c.sources.length)
    .slice(0, 8);
  const summary = res.text.split(/\n{2,}/)[0]?.trim() ?? "";
  return finish(ctx, task, { summary, claims, gaps: sources.length ? [] : ["The web search returned no sources."] });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function finish(ctx: ResearchContext, task: Subtask, args: Record<string, unknown>): Finding {
  const a = args as { summary?: string; claims?: { text: string; sources?: string[] }[]; gaps?: string[] };
  const finding: Finding = {
    subtask: task.id,
    summary: a.summary ?? "",
    claims: (a.claims ?? []).map((c) => ({ text: c.text, sources: (c.sources ?? []).filter((id) => ctx.registry.has(id)) })),
    gaps: a.gaps ?? [],
  };
  const md = [
    `# ${task.id}: ${task.question}`,
    "",
    `Knowledge base: ${task.source}. Skills: ${task.skills.join(", ") || "none"}.`,
    "",
    "## Summary",
    finding.summary,
    "",
    "## Claims",
    ...finding.claims.map((c) => `- ${c.text} ${c.sources.map((s) => `[${s}]`).join(" ")}`),
    "",
    "## Gaps",
    ...(finding.gaps.length ? finding.gaps.map((g) => `- ${g}`) : ["- None reported."]),
  ].join("\n");
  ctx.vfs.write(`/findings/${task.id}.md`, md, task.id);
  return finding;
}
