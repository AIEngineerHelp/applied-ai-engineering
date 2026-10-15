// One research run, end to end:
//   query → orchestrator (+ skills index) → parallel research sub-agents
//   → knowledge bases → virtual file system → synthesis agent → evals & traces
// Every step is emitted as an event, so the UI can draw it live and the run
// can be saved and replayed.

import { plan as makePlan } from "./agents/orchestrator.ts";
import { research } from "./agents/researcher.ts";
import { renderReport, synthesize } from "./agents/synthesis.ts";
import { checks, groundedness } from "./evals.ts";
import type { LLM } from "./llm.ts";
import { loadSkills } from "./skills.ts";
import type { Toolset } from "./sources/toolset.ts";
import { Tracer } from "./trace.ts";
import type { EvalResult, Finding, Report, RunEvent, Source, SourceKind } from "./types.ts";
import { VirtualFS } from "./vfs.ts";

export interface RunOptions {
  llm: LLM;
  toolsets: Record<SourceKind, Toolset>;
  /** Most sub-agents the orchestrator may plan. */
  maxSubtasks?: number;
  /** Most sub-agents running at once. */
  concurrency?: number;
  /** Ask a judge model to check groundedness (one extra call). */
  judge?: boolean;
  emit?: (e: RunEvent) => void;
}

export interface RunResult {
  id: string;
  events: RunEvent[];
  report?: Report;
  evals: EvalResult[];
  files: { path: string; content: string; by: string }[];
}

export const newRunId = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z") + "-" + Math.random().toString(36).slice(2, 6);

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

export async function runResearch(query: string, opts: RunOptions, id = newRunId()): Promise<RunResult> {
  const events: RunEvent[] = [];
  const emit = (e: RunEvent) => {
    events.push(e);
    opts.emit?.(e);
  };
  const t0 = Date.now();
  const tracer = new Tracer(emit);
  const vfs = new VirtualFS((f) => emit({ type: "file", path: f.path, bytes: f.content.length, by: f.by, content: f.content }));
  const registry = new Map<string, Source>();
  const skills = loadSkills();
  const result: RunResult = { id, events, evals: [], files: [] };

  emit({ type: "run", id, query, model: opts.llm.model, mode: opts.llm.mode, at: new Date().toISOString() });
  emit({ type: "skills", available: skills.map((s) => ({ name: s.name, description: s.description })) });

  try {
    await tracer.wrap("run", "research run", undefined, async (root) => {
      // 1. Orchestration: a plan, with skills chosen from the index.
      const plan = await tracer.wrap("agent", "orchestrator", root.id, async (span) => {
        const p = await tracer.wrap("llm", "plan subtasks", span.id, async (s) => {
          const before = tracer.usage.input;
          const out = await makePlan(trackedLLM(opts.llm, tracer), query, skills, opts.maxSubtasks ?? 4);
          tracer.close(s, { subtasks: out.subtasks.length, input: tracer.usage.input - before });
          return out;
        });
        vfs.write("/plan.md", ["# Plan", "", p.focus, "", ...p.subtasks.map((t) => `- **${t.id}** (${t.source}; skills: ${t.skills.join(", ") || "none"}): ${t.question}`)].join("\n"), "orchestrator");
        return p;
      });
      const loaded = [...new Set(plan.subtasks.flatMap((t) => t.skills))];
      emit({ type: "plan", plan, loaded });

      // 2. Parallel research sub-agents, each on one knowledge base.
      const ctx = { llm: opts.llm, tracer, vfs, registry, onSources: (subtask: string, sources: Source[]) => emit({ type: "sources", subtask, sources }) };
      const settled = await pool(
        plan.subtasks.map((task) => () => research(ctx, task, opts.toolsets[task.source], skills, root.id)),
        opts.concurrency ?? 4,
      );
      const findings: Finding[] = settled.map((r, i) =>
        r.status === "fulfilled" ? r.value : { subtask: plan.subtasks[i].id, summary: `Failed: ${(r.reason as Error).message}`, claims: [], gaps: [plan.subtasks[i].question] },
      );
      for (const f of findings) emit({ type: "finding", finding: f });

      // 3. Synthesis from the files.
      const synthesisSkill = skills.find((s) => s.source === "synthesis");
      const report = await synthesize(opts.llm, tracer, vfs, query, plan, registry, synthesisSkill, root.id);
      result.report = report;
      emit({ type: "report", report, markdown: renderReport(report) });

      // 4. Evals.
      const evals = await tracer.wrap("eval", "evals", root.id, async (span) => {
        const list = checks(report, plan, findings, registry);
        if (opts.judge !== false) {
          const g = await groundedness(opts.llm, tracer, report, registry, span.id);
          vfs.write("/evals/groundedness.md", g.verdicts.map((v) => `- **${v.verdict}** — ${v.text}\n  ${v.reason}`).join("\n"), "judge");
          list.push({ name: g.name, score: g.score, detail: g.detail, method: g.method, items: g.verdicts });
        }
        return list;
      });
      result.evals = evals;
      emit({ type: "evals", evals });
    });
  } catch (err) {
    emit({ type: "error", message: (err as Error).message });
  }
  result.files = vfs.snapshot().map(({ path, content, by }) => ({ path, content, by }));
  emit({ type: "done", ms: Date.now() - t0 });
  return result;
}

/** Wraps an LLM so the orchestrator's call is counted like every other. */
function trackedLLM(llm: LLM, tracer: Tracer): LLM {
  return {
    model: llm.model,
    mode: llm.mode,
    async generate(req) {
      const r = await llm.generate(req);
      tracer.addUsage(r.usage);
      return r;
    },
  };
}
