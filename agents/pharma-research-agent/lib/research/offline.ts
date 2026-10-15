// Offline mode: a scripted stand-in for the model, plus knowledge bases that
// answer from recorded API responses (tests/fixtures/sources.json). The whole
// pipeline runs — plan, parallel tool loops, file system, synthesis, evals —
// with no API key and no network. Its text is canned; its structure is real.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerateRequest, GenerateResult, LLM, Turn } from "./llm.ts";
import type { Toolset, ToolOutput } from "./sources/toolset.ts";
import type { SourceKind } from "./types.ts";

const FIXTURES = join(/*turbopackIgnore: true*/ process.cwd(), "tests", "fixtures", "sources.json");

type Fixture = { name: string; args: Record<string, unknown>; output: ToolOutput };

export function fixtureToolsets(): Record<SourceKind, Toolset> {
  const f = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<"pubmed" | "trials" | "fda", Fixture>;
  const make = (kind: "pubmed" | "trials" | "fda", tools: Toolset["tools"]): Toolset => ({
    kind,
    tools,
    call: async (name) => {
      await new Promise((r) => setTimeout(r, 30));
      if (name !== f[kind].name) return { forModel: { error: `Offline mode only has a recorded ${f[kind].name}` }, sources: [] };
      return f[kind].output;
    },
  });
  const decl = (name: string) => ({ name, description: `${name} (recorded response)`, parameters: { type: "object", properties: {} } });
  return {
    pubmed: make("pubmed", [decl("search_pubmed")]),
    trials: make("trials", [decl("search_trials")]),
    fda: make("fda", [decl("get_drug_label")]),
    web: { kind: "web", tools: [], call: async () => ({ forModel: {}, sources: [] }) },
  };
}

const usage = (input: number, output: number) => ({ input, output, thinking: 0, cost: 0 });
const lastTool = (turns: Turn[]) => [...turns].reverse().find((t) => t.role === "tool") as Extract<Turn, { role: "tool" }> | undefined;

/** Ids the tools returned, in order. */
function returnedIds(turns: Turn[]): string[] {
  const out = lastTool(turns)?.results[0]?.response as Record<string, unknown> | undefined;
  if (!out) return [];
  const list = (out.articles ?? out.trials ?? (out.id ? [out] : [])) as { id: string }[];
  return list.map((x) => x.id);
}

export function offlineLLM(): LLM {
  return {
    model: "offline (scripted)",
    mode: "offline",
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      // RESEARCH_OFFLINE_DELAY_MS simulates model latency, to see the live progress UI.
      await new Promise((r) => setTimeout(r, Number(process.env.RESEARCH_OFFLINE_DELAY_MS) || 40));
      const base = { text: "", calls: [], usage: usage(1200, 200), model: "offline (scripted)" } as GenerateResult;
      if (req.agent === "orchestrator") {
        const json = {
          focus: "GLP-1 receptor agonists (semaglutide) and pancreatitis: trial evidence, registered trials and label warnings.",
          subtasks: [
            { question: "What do meta-analyses and randomised trials report about pancreatitis risk with GLP-1 receptor agonists?", source: "pubmed", skills: ["literature-review"], why: "Pooled trial evidence is the strongest signal." },
            { question: "Which phase 3 semaglutide trials are registered, and which have posted results?", source: "trials", skills: ["clinical-trials"], why: "Shows what evidence exists or is coming." },
            { question: "What does the semaglutide FDA label say about pancreatitis?", source: "fda", skills: ["drug-safety"], why: "The label states the regulator's position." },
          ],
        };
        return { ...base, text: JSON.stringify(json), json };
      }
      if (req.agent.startsWith("researcher:")) {
        const ids = returnedIds(req.turns);
        const tool = req.tools?.find((t) => t.name !== "finish");
        if (!ids.length && tool) return { ...base, calls: [{ name: tool.name, args: {} }] };
        return {
          ...base,
          calls: [{
            name: "finish",
            args: {
              summary: `Recorded ${req.agent.slice(11)} results for this subtask (offline mode: canned text).`,
              claims: ids.slice(0, 3).map((id) => ({ text: `Offline placeholder claim drawn from ${id}.`, sources: [id] })),
              gaps: ["Offline mode does not read the sources; run live for real findings."],
            },
          }],
        };
      }
      if (req.agent === "synthesis") {
        const ids = [...new Set([...(req.turns[0] as { text: string }).text.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]))];
        const json = {
          title: "Offline run: structure only",
          answer: `This report was written by the offline stand-in, so its text is a placeholder [${ids[0]}]. The pipeline, the files and the citations are real.`,
          sections: [{ heading: "Sources used", body: ids.slice(0, 6).map((id) => `A placeholder sentence citing a recorded source [${id}].`).join(" ") }],
          limitations: ["Offline mode: run with --live for a real report."],
          confidence: "low",
        };
        return { ...base, text: JSON.stringify(json), json };
      }
      if (req.agent === "judge") {
        const n = (req.turns[0] as { text: string }).text.match(/^\d+\. CLAIM/gm)?.length ?? 0;
        const json = { verdicts: Array.from({ length: n }, (_, i) => ({ n: i + 1, verdict: "partial", reason: "Offline mode: not actually judged." })) };
        return { ...base, text: JSON.stringify(json), json };
      }
      return base;
    },
  };
}
