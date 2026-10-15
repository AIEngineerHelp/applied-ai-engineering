// The synthesis agent: reads the research files — the sub-agents' findings and
// a catalogue of every source retrieved — and writes one cited report. It sees
// file contents, not the sub-agents' conversations.

import type { LLM, Schema } from "../llm.ts";
import type { Skill } from "../skills.ts";
import type { Tracer } from "../trace.ts";
import type { Plan, Report, Source } from "../types.ts";
import type { VirtualFS } from "../vfs.ts";

const REPORT_SCHEMA: Schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    answer: { type: "string", description: "Two to four sentences answering the query directly, with citations." },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: { heading: { type: "string" }, body: { type: "string", description: "Markdown paragraphs; every factual sentence cites ids in square brackets." } },
        required: ["heading", "body"],
      },
    },
    limitations: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "moderate", "high"] },
  },
  required: ["title", "answer", "sections", "limitations", "confidence"],
};

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

export async function synthesize(llm: LLM, tracer: Tracer, vfs: VirtualFS, query: string, plan: Plan, registry: Map<string, Source>, skill: Skill | undefined, parent: string): Promise<Report> {
  return tracer.wrap("agent", "synthesis", parent, async (span) => {
    // The agent works from files: list them, then read the findings.
    const findings = vfs.list("/findings").map((f) => f.content);
    vfs.write("/sources/CATALOGUE.md", `# Sources retrieved (${registry.size})\n\n${catalogue([...registry.values()])}\n`, "synthesis");
    const system = [
      "You are the synthesis agent of a pharmaceutical research team. You write the final report from the research files only.",
      skill ? `\n## Skill: ${skill.name}\n${skill.body}` : "",
    ].join("\n");
    const user = [
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
      const r = await llm.generate({ agent: "synthesis", system, turns: [{ role: "user", text: user }], schema: REPORT_SCHEMA, temperature: 0.2 });
      tracer.addUsage(r.usage);
      tracer.close(s, { model: r.model, input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cost: r.usage.cost });
      return r;
    });
    const report = res.json as Report;
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
