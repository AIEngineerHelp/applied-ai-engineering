// A research sub-agent: one subtask, one knowledge base, its assigned skills.
// It runs a short tool loop — search, read, maybe search again — then calls
// `finish` with claims tied to source ids. Full documents go to the virtual
// file system; the model sees only short excerpts.

import type { LLM, Schema, ToolDecl, Turn } from "../llm.ts";
import type { Skill } from "../skills.ts";
import type { Toolset } from "../sources/toolset.ts";
import type { Tracer } from "../trace.ts";
import type { Finding, Source, Subtask } from "../types.ts";
import type { VirtualFS } from "../vfs.ts";

export const MAX_TURNS = 6;

const FINISH: ToolDecl = {
  name: "finish",
  description: "Call once, when you have enough evidence or have run out of useful searches. Every claim must cite source ids you retrieved.",
  parameters: {
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
  } satisfies Schema,
};

export interface ResearchContext {
  llm: LLM;
  tracer: Tracer;
  vfs: VirtualFS;
  /** Every source any agent retrieved, by id. */
  registry: Map<string, Source>;
  onSources: (subtask: string, sources: Source[]) => void;
}

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

export async function research(ctx: ResearchContext, task: Subtask, toolset: Toolset, skills: Skill[], parent: string): Promise<Finding> {
  return ctx.tracer.wrap("agent", `${task.id} · ${toolset.kind}`, parent, async (span) => {
    const playbooks = skills.filter((s) => task.skills.includes(s.name));
    const system = [
      `You are a research sub-agent on a pharmaceutical research team. Your knowledge base is ${toolset.kind}.`,
      "Answer only your subtask, only from what the tools return. Cite source ids exactly as the tools give them.",
      `You have at most ${MAX_TURNS} turns. Search, read what matters, then call finish.`,
      ...playbooks.map((p) => `\n## Skill: ${p.name}\n${p.body}`),
    ].join("\n");
    const turns: Turn[] = [{ role: "user", text: `Subtask: ${task.question}\nWhy it matters: ${task.why}` }];
    const tools = [...toolset.tools, FINISH];

    // Web search has no function tools: one grounded call, sources from the grounding metadata.
    if (toolset.kind === "web") return webResearch(ctx, task, system, span.id);

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const last = turn === MAX_TURNS - 1;
      const res = await ctx.tracer.wrap("llm", `${task.id} turn ${turn + 1}`, span.id, async (s) => {
        const r = await ctx.llm.generate({ agent: `researcher:${toolset.kind}`, system, turns, tools: last ? [FINISH] : tools, force: last ? "finish" : undefined, temperature: 0.2 });
        ctx.tracer.addUsage(r.usage);
        ctx.tracer.close(s, { model: r.model, input: r.usage.input, output: r.usage.output, calls: r.calls.map((c) => c.name).join(", ") });
        return r;
      });
      turns.push({ role: "model", text: res.text, calls: res.calls, raw: res.raw });

      const done = res.calls.find((c) => c.name === "finish");
      if (done) return finish(ctx, task, done.args);
      if (!res.calls.length) {
        turns.push({ role: "user", text: "Use a tool, or call finish with what you have." });
        continue;
      }
      const results: { name: string; response: unknown }[] = [];
      for (const call of res.calls) {
        const out = await ctx.tracer.wrap("tool", `${call.name}`, span.id, async (s) => {
          ctx.tracer.addToolCall();
          const o = await toolset.call(call.name, call.args).catch((err: Error) => ({ forModel: { error: err.message }, sources: [] as Source[] }));
          ctx.tracer.close(s, { args: JSON.stringify(call.args).slice(0, 200), results: o.sources.length });
          return o;
        });
        saveSources(ctx, task, out.sources);
        // Every result carries the remaining budget, so the model can plan its last search.
        const left = MAX_TURNS - turn - 1;
        const response = out.forModel && typeof out.forModel === "object" && !Array.isArray(out.forModel) ? { ...(out.forModel as object), turns_left: left } : { result: out.forModel, turns_left: left };
        results.push({ name: call.name, response });
      }
      turns.push({ role: "tool", results });
      if (turn === MAX_TURNS - 2) turns.push({ role: "user", text: "Last turn: call finish now, citing the source ids you have." });
    }
    // Out of turns without finishing: record an honest empty finding.
    return finish(ctx, task, { summary: "The sub-agent ran out of turns before finishing.", claims: [], gaps: [task.question] });
  });
}

async function webResearch(ctx: ResearchContext, task: Subtask, system: string, parent: string): Promise<Finding> {
  const res = await ctx.tracer.wrap("llm", `${task.id} web search`, parent, async (s) => {
    const r = await ctx.llm.generate({
      agent: "researcher:web",
      system: `${system}\n\nSearch the web, then answer in plain prose. Do not write citations; the sources you used are recorded automatically.`,
      turns: [{ role: "user", text: task.question }],
      search: true,
      temperature: 0.2,
    });
    ctx.tracer.addUsage(r.usage);
    ctx.tracer.addToolCall();
    ctx.tracer.close(s, { model: r.model, input: r.usage.input, output: r.usage.output, results: r.grounding?.length ?? 0, searches: r.searches });
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
