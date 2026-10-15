// The writer node: reads the research files — the sub-agents' findings and a
// catalogue of every source retrieved — and writes one cited report. It sees
// file contents, not the sub-agents' conversations. For a follow-up answered
// without new research, it works from the earlier answers instead.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callModel, chatModel } from "../model.ts";
import { writerSystem } from "../prompts/writer.ts";
import { draftForDisplay, parseReport, renderReport } from "../report-format.ts";
import { loadSkills, type Skill } from "../skills/index.ts";
import type { RunState } from "../state.ts";
import type { RunStore } from "../store.ts";
import { throttle } from "../throttle.ts";
import type { Tracer } from "../trace.ts";
import type { Plan, Report, Source } from "../types.ts";
import type { VirtualFS } from "../vfs.ts";
import { conversationContext, nodeContext, thoughtStream } from "./context.ts";

/** One line per source: what the writer may cite. */
export function catalogue(sources: Source[]): string {
  return sources
    .map((s) => {
      const year = s.meta.year ? `, ${s.meta.year}` : "";
      const extra = s.kind === "trials" ? `, ${s.meta.phase ?? ""} ${s.meta.status ?? ""}`.replace(/\s+/g, " ") : "";
      return `[${s.id}] ${s.title}${year}${extra}`;
    })
    .join("\n");
}

export interface SynthesisOptions {
  /** Earlier turns of the conversation. */
  context?: string;
  /** Answer mode: the earlier answers in full, citations kept, as the only evidence. */
  earlier?: string;
  /** Streams the report markdown as it is written. */
  onText?: (soFar: string) => void;
  onThought?: (soFar: string) => void;
}

export async function synthesize(model: BaseChatModel, tracer: Tracer, vfs: VirtualFS, query: string, plan: Plan, registry: Map<string, Source>, skill: Skill | undefined, parent: string, opts: SynthesisOptions = {}): Promise<Report> {
  return tracer.wrap("agent", "synthesis", parent, async (span) => {
    // The writer works from files: list them, then read the findings.
    const answering = plan.mode === "answer";
    const findings = vfs.list("/findings").map((f) => f.content);
    vfs.write("/sources/CATALOGUE.md", `# Sources retrieved (${registry.size})\n\n${catalogue([...registry.values()])}\n`, "synthesis");
    if (answering) vfs.write("/context/earlier.md", opts.earlier ?? "", "synthesis");
    const system = writerSystem(answering, skill);
    const user = answering
      ? [`Follow-up: ${query}`, `Focus: ${plan.focus}`, "", "Files in the workspace:", "/context/earlier.md", "/sources/CATALOGUE.md", "", "---", vfs.read("/context/earlier.md"), "---", vfs.read("/sources/CATALOGUE.md")].join("\n")
      : [
          opts.context ? `${opts.context}\n` : "",
          `Research query: ${query}`,
          `Focus: ${plan.focus}`,
          "",
          "Files in the workspace:",
          vfs.tree("/findings"),
          "/sources/CATALOGUE.md",
          "",
          ...findings.map((f) => `---\n${f}`),
          "---",
          vfs.read("/sources/CATALOGUE.md"),
        ].join("\n");
    const res = await tracer.wrap("llm", "write report", span.id, async (s) => {
      const r = await callModel(model, [new SystemMessage(system), new HumanMessage(user)], { onText: opts.onText, onThought: opts.onThought });
      tracer.addUsage(r.usage);
      tracer.close(s, { model: model.getName(), input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost });
      return r;
    });
    const report = parseReport(res.text, query);
    vfs.write("/report.md", renderReport(report), "synthesis");
    return report;
  });
}

export const writerNode = (store: RunStore) => async (s: RunState): Promise<Partial<RunState>> => {
  const plan = s.plan!;
  const { run, sink, tracer, vfs, done } = await nodeContext(store, s.reportId, "synthesis");
  vfs.load(await store.files(s.reportId));
  // Answer mode: no sub-agents ran, so this turn takes over the earlier turns' sources.
  const answering = plan.mode === "answer";
  const turns = await store.earlierTurns(s.reportId, { withSources: answering });
  const earlierSources = answering ? turns.flatMap((t) => t.sources) : [];
  if (earlierSources.length) sink.emit({ type: "sources", subtask: "earlier", sources: [...new Map(earlierSources.map((x) => [x.id, x])).values()] });
  const registry = new Map([...(await store.sources(s.reportId)), ...earlierSources].map((x) => [x.id, x] as const));
  const earlier = answering ? turns.filter((t) => t.report).map((t, i) => `## Turn ${i + 1}\n\nQuestion: ${t.query}\n\n${renderReport(t.report!)}`).join("\n\n") : undefined;

  const skill = loadSkills().find((x) => x.source === "synthesis");
  const draft = throttle((text: string) => sink.emit({ type: "draft", text: draftForDisplay(text) }));
  const thought = thoughtStream(sink, "synthesis");
  const report = await synthesize(chatModel(), tracer, vfs, run.query, plan, registry, skill, "run", {
    context: answering ? undefined : conversationContext(turns),
    earlier,
    onText: (t) => draft.push(t),
    onThought: (t) => thought("synthesis", t, false),
  });
  draft.flush();
  thought("synthesis", "", true);
  sink.emit({ type: "report", report, markdown: renderReport(report) });
  await done();
  await store.save(s.reportId, { report });
  return { report };
};
