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

const delay = () => Number(process.env.RESEARCH_OFFLINE_DELAY_MS) || 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams text in small pieces, like the live model, through a callback. */
async function streamOut(text: string, cb: ((soFar: string) => void) | undefined, totalMs: number) {
  if (!cb) return;
  const words = text.split(/(?<=\s)/);
  const step = Math.max(1, Math.ceil(words.length / 40));
  for (let i = step; i < words.length + step; i += step) {
    cb(words.slice(0, i).join(""));
    await sleep(totalMs / 40);
  }
}

const THOUGHTS: Record<string, string> = {
  orchestrator: "**Reading the question**\n\nThe question asks about a drug class and one adverse outcome, so I need pooled trial evidence, the registered trials and the label wording.\n\n**Choosing the sources**\n\nPubMed for meta-analyses, ClinicalTrials.gov for the trial landscape, and the FDA label for the regulator's position.",
  researcher: "**Searching**\n\nStarting with a focused query, then reading the most relevant results before writing the finding.",
  synthesis: "**Organising the findings**\n\nGrouping the evidence by design and noting where sources agree or conflict.",
};

export function offlineLLM(): LLM {
  return {
    model: "offline (scripted)",
    mode: "offline",
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      // RESEARCH_OFFLINE_DELAY_MS simulates model latency, to see the live progress UI.
      const kind = req.agent.startsWith("researcher") ? "researcher" : req.agent;
      if (THOUGHTS[kind]) await streamOut(THOUGHTS[kind], req.onThought, delay() * 0.6);
      await sleep(delay() * 0.4);
      const base = { text: "", calls: [], usage: usage(1200, 200), model: "offline (scripted)" } as GenerateResult;
      if (THOUGHTS[kind]) base.thoughts = THOUGHTS[kind];
      if (req.agent === "orchestrator") {
        // A follow-up asking for a rewrite is answered from the earlier turns, as the live planner would.
        const followUp = (req.turns[0] as { text: string }).text.match(/^Follow-up: (.*)$/m)?.[1];
        if (followUp && /\b(simplif|simpler|shorter|plain|summari[sz]e|explain)/i.test(followUp)) {
          const json = { mode: "answer", reason: "The follow-up asks for a rewrite of the earlier answer.", focus: followUp, subtasks: [] };
          return { ...base, text: JSON.stringify(json), json };
        }
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
        const md = [
          "# Offline run: structure only",
          "",
          `This report was written by the offline stand-in, so its text is a placeholder [${ids[0]}]. The pipeline, the files and the citations are real.`,
          "",
          "## Sources used",
          "",
          ids.slice(0, 6).map((id) => `A placeholder sentence citing a recorded source [${id}].`).join(" "),
          "",
          "## Limitations",
          "",
          "- Offline mode: run with a Gemini key for a real report.",
          "",
          "Confidence: low",
        ].join("\n");
        await streamOut(md, req.onText, delay() * 2);
        return { ...base, text: md };
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
