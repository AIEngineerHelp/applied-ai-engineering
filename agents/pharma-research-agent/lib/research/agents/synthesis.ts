// The synthesis agent: reads the research files — the sub-agents' findings and
// a catalogue of every source retrieved — and writes one cited report. It sees
// file contents, not the sub-agents' conversations.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callModel } from "../model.ts";
import type { Skill } from "../skills.ts";
import type { Tracer } from "../trace.ts";
import type { Plan, Report, Source } from "../types.ts";
import { parseReport } from "../report-format.ts";

export { draftForDisplay, parseReport } from "../report-format.ts";
import type { VirtualFS } from "../vfs.ts";

/**
 * The report is written as markdown, so it can stream to the reader as it is
 * written, then parsed into a Report. The shape is fixed by the prompt.
 */
const FORMAT = `Write the report in this exact markdown shape:

# <a specific title>

<the direct answer: two to four sentences, with the key number, every sentence cited>

## <section heading, e.g. Efficacy>

<paragraphs or "- " bullets; every factual sentence cited>

(more ## sections as the evidence supports: efficacy, safety, trial landscape, regulatory status)

## Limitations

- <one limitation per bullet>

Confidence: <low | moderate | high>

Cite with source ids in square brackets right after the claim, e.g. [PMID:12345678] or [NCT01234567]. Use only ids from the source catalogue. No other text before the title or after the confidence line.`;

/** One line per source: what the synthesis agent may cite. */
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
    // The agent works from files: list them, then read the findings.
    const answering = plan.mode === "answer";
    const findings = vfs.list("/findings").map((f) => f.content);
    vfs.write("/sources/CATALOGUE.md", `# Sources retrieved (${registry.size})\n\n${catalogue([...registry.values()])}\n`, "synthesis");
    if (answering) vfs.write("/context/earlier.md", opts.earlier ?? "", "synthesis");
    const system = [
      "You are the synthesis agent of a pharmaceutical research team. You write the final report from the research files only.",
      answering
        ? "This is a follow-up that needs no new research. Answer it from /context/earlier.md, the earlier answers with their citations, and nothing else: do not add facts, numbers or sources that are not there. Do what the follow-up asks (for example, plain language and fewer, shorter sections for a simpler answer) and keep each claim's citation."
        : "",
      FORMAT,
      skill ? `\n## Skill: ${skill.name}\n${skill.body}` : "",
    ].join("\n");
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

export function renderReport(r: Report): string {
  return [
    `# ${r.title}`,
    "",
    r.answer,
    "",
    ...r.sections.flatMap((s) => [`## ${s.heading}`, "", s.body, ""]),
    "## Limitations",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
    `Confidence: **${r.confidence}**`,
  ].join("\n");
}
