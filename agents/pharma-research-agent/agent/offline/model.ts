// Offline mode's model: a scripted LangChain chat model (the recorded
// knowledge bases are in toolsets.ts). The whole graph runs — plan, parallel
// tool loops, file system, synthesis, evals — with no API key and no network.
// Its text is canned; its structure is real.

import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel, type BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";

const delay = () => Number(process.env.RESEARCH_OFFLINE_DELAY_MS) || 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const THOUGHTS = {
  orchestrator: "**Reading the question**\n\nThe question asks about a drug class and one adverse outcome, so I need pooled trial evidence, the registered trials and the label wording.\n\n**Choosing the sources**\n\nPubMed for meta-analyses, ClinicalTrials.gov for the trial landscape, and the FDA label for the regulator's position.",
  researcher: "**Searching**\n\nStarting with a focused query, then reading the most relevant results before writing the finding.",
  synthesis: "**Organising the findings**\n\nGrouping the evidence by design and noting where sources agree or conflict.",
  judge: "",
};

export interface ScriptedCallOptions extends BaseChatModelCallOptions {
  tools?: unknown[];
  tool_choice?: string;
  responseSchema?: Record<string, unknown>;
}

export type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> } };
export type Agent = keyof typeof THOUGHTS;

/** Ids the last tool call returned, in order. */
function returnedIds(messages: BaseMessage[]): string[] {
  const last = [...messages].reverse().find((m) => ToolMessage.isInstance(m));
  if (!last) return [];
  try {
    const out = JSON.parse(last.text) as Record<string, unknown>;
    const list = (out.articles ?? out.trials ?? (out.id ? [out] : [])) as { id: string }[];
    return list.map((x) => x.id);
  } catch {
    return [];
  }
}

/** Which agent is calling, from its system prompt; each agent's prompt opens differently. */
function agentOf(messages: BaseMessage[]): Agent {
  const system = messages.find((m) => m.type === "system")?.text ?? "";
  if (system.includes("orchestrator")) return "orchestrator";
  if (system.includes("research sub-agent")) return "researcher";
  if (system.includes("synthesis agent")) return "synthesis";
  return "judge";
}

const toolName = (t: unknown) => (t && typeof t === "object" && "name" in t ? String((t as { name: string }).name) : Object.keys(t as object)[0]);

/** The scripted answer for one call. */
function reply(messages: BaseMessage[], o: ScriptedCallOptions): Reply {
  const agent = agentOf(messages);
  const user = messages.find((m) => m.type === "human")?.text ?? "";
  if (agent === "orchestrator") {
    // A follow-up asking for a rewrite is answered from the earlier turns, as the live planner would.
    const followUp = user.match(/^Follow-up: (.*)$/m)?.[1];
    if (followUp && /\b(simplif|simpler|shorter|plain|summari[sz]e|explain)/i.test(followUp)) {
      return { text: JSON.stringify({ mode: "answer", reason: "The follow-up asks for a rewrite of the earlier answer.", focus: followUp, subtasks: [] }) };
    }
    const plan = {
      ...(followUp ? { mode: "research", reason: "The follow-up asks about something new." } : {}),
      focus: "GLP-1 receptor agonists (semaglutide) and pancreatitis: trial evidence, registered trials and label warnings.",
      subtasks: [
        { question: "What do meta-analyses and randomised trials report about pancreatitis risk with GLP-1 receptor agonists?", source: "pubmed", skills: ["literature-review"], why: "Pooled trial evidence is the strongest signal." },
        { question: "Which phase 3 semaglutide trials are registered, and which have posted results?", source: "trials", skills: ["clinical-trials"], why: "Shows what evidence exists or is coming." },
        { question: "What does the semaglutide FDA label say about pancreatitis?", source: "fda", skills: ["drug-safety"], why: "The label states the regulator's position." },
      ],
    };
    return { text: JSON.stringify(plan) };
  }
  if (agent === "researcher") {
    const names = (o.tools ?? []).map(toolName);
    if (names.includes("googleSearch")) return { text: "Offline mode: no web search was run." };
    const ids = returnedIds(messages);
    const search = names.find((n) => n !== "finish");
    if (!ids.length && search && o.tool_choice !== "finish" && !messages.some((m) => ToolMessage.isInstance(m))) return { call: { name: search, args: {} } };
    return {
      call: {
        name: "finish",
        args: {
          summary: "Recorded results for this subtask (offline mode: canned text).",
          claims: ids.slice(0, 3).map((id) => ({ text: `Offline placeholder claim drawn from ${id}.`, sources: [id] })),
          gaps: ["Offline mode does not read the sources; run live for real findings."],
        },
      },
    };
  }
  if (agent === "synthesis") {
    const ids = [...new Set([...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]))];
    return {
      text: [
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
      ].join("\n"),
    };
  }
  const n = user.match(/^\d+\. CLAIM/gm)?.length ?? 0;
  return { text: JSON.stringify({ verdicts: Array.from({ length: n }, (_, i) => ({ n: i + 1, verdict: "partial", reason: "Offline mode: not actually judged." })) }) };
}

let callIds = 0;

/** Splits text into small pieces, about six words each, to stream like a model. */
const pieces = (s: string) => s.split(/(?<=\s)/).reduce<string[]>((acc, w, i) => (i % 6 ? ((acc[acc.length - 1] += w), acc) : [...acc, w]), []);

/**
 * A LangChain chat model that follows a script instead of calling an API. It
 * streams thought summaries and text like ChatGoogle, honours bound tools and
 * a forced tool choice, and answers in JSON when a response schema is given.
 */
export class ScriptedChatModel extends BaseChatModel<ScriptedCallOptions> {
  /**
   * Tests replace the script for one agent here (return undefined to fall
   * back to the default script; throw to simulate a failed call).
   */
  static script: ((agent: Agent, messages: BaseMessage[], options: ScriptedCallOptions) => Reply | undefined) | undefined;

  _llmType() {
    return "scripted";
  }

  override bindTools(tools: unknown[], kwargs?: Partial<ScriptedCallOptions>): Runnable<BaseMessage[], AIMessageChunk, ScriptedCallOptions> {
    return this.withConfig({ tools, tool_choice: kwargs?.tool_choice } as Partial<ScriptedCallOptions>) as unknown as Runnable<BaseMessage[], AIMessageChunk, ScriptedCallOptions>;
  }

  override async *_streamResponseChunks(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    const agent = agentOf(messages);
    const r = ScriptedChatModel.script?.(agent, messages, options) ?? reply(messages, options);
    // RESEARCH_OFFLINE_DELAY_MS simulates model latency, to see the live progress UI.
    const thought = THOUGHTS[agent];
    for (const p of thought ? pieces(thought) : []) {
      await sleep((delay() * 0.6) / 20);
      yield new ChatGenerationChunk({ text: "", message: new AIMessageChunk({ content: [{ type: "reasoning", reasoning: p }] }) });
    }
    await sleep(delay() * 0.4);
    if (r.text) {
      const parts = pieces(r.text);
      for (const p of parts) {
        if (agent === "synthesis") await sleep((delay() * 2) / parts.length);
        yield new ChatGenerationChunk({ text: p, message: new AIMessageChunk({ content: [{ type: "text", text: p }] }) });
        await runManager?.handleLLMNewToken(p);
      }
    }
    if (r.call) {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({ content: "", tool_call_chunks: [{ type: "tool_call_chunk", name: r.call.name, args: JSON.stringify(r.call.args), id: `offline_${++callIds}`, index: 0 }] }),
      });
    }
    yield new ChatGenerationChunk({ text: "", message: new AIMessageChunk({ content: "", usage_metadata: { input_tokens: 1200, output_tokens: 200, total_tokens: 1400 } }) });
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    let message: AIMessageChunk | undefined;
    for await (const c of this._streamResponseChunks(messages, options, runManager)) message = message ? message.concat(c.message as AIMessageChunk) : (c.message as AIMessageChunk);
    return { generations: [{ text: message?.text ?? "", message: message! }] };
  }
}
