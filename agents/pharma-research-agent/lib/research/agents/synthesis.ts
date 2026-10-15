// The synthesis agent: reads the research files — the sub-agents' findings and
// a catalogue of every source retrieved — and writes one cited report. It sees
// file contents, not the sub-agents' conversations.

import type { LLM } from "../llm.ts";
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
  /** Streams the report markdown as it is written. */
  onText?: (soFar: string) => void;
  onThought?: (soFar: string) => void;
}

export async function synthesize(llm: LLM, tracer: Tracer, vfs: VirtualFS, query: string, plan: Plan, registry: Map<string, Source>, skill: Skill | undefined, parent: string, opts: SynthesisOptions = {}): Promise<Report> {
  return tracer.wrap("agent", "synthesis", parent, async (span) => {
    // The agent works from files: list them, then read the findings.
    const findings = vfs.list("/findings").map((f) => f.content);
    vfs.write("/sources/CATALOGUE.md", `# Sources retrieved (${registry.size})\n\n${catalogue([...registry.values()])}\n`, "synthesis");
    const system = [
      "You are the synthesis agent of a pharmaceutical research team. You write the final report from the research files only.",
      FORMAT,
      skill ? `\n## Skill: ${skill.name}\n${skill.body}` : "",
    ].join("\n");
    const user = [
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
      const r = await llm.generate({ agent: "synthesis", system, turns: [{ role: "user", text: user }], temperature: 0.2, onText: opts.onText, onThought: opts.onThought });
      tracer.addUsage(r.usage);
      tracer.close(s, { model: r.model, input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost });
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
