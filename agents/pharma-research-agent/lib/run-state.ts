// Client-side view of a research run, folded from its event stream. Shared by
// the report page, the run details page and the shared (read-only) page.
import type { EvalResult, Finding, Plan, Report, RunEvent, Source, Span, Subtask } from "./research/types";
import type { SerializedReport } from "./reports";

export interface RunState {
  report: SerializedReport;
  plan?: Plan;
  loaded: string[];
  skills: { name: string; description: string }[];
  spans: Map<string, Span>;
  files: Map<string, { path: string; bytes: number; by: string }>;
  sources: Map<string, Source>;
  sourcesBy: Map<string, string[]>;
  findings: Map<string, Finding>;
  result?: Report;
  evals?: EvalResult[];
  error?: string;
  doneMs?: number;
}

/** What the database sends for a "sources" event before enrichment. */
type WireEvent = RunEvent | { type: "sources"; subtask: string; ids: string[] } | { type: "file"; path: string; bytes: number; by: string };

export function initialState(report: SerializedReport, sources: Source[], events: WireEvent[]): RunState {
  const s: RunState = {
    report,
    plan: report.plan ?? undefined,
    loaded: [],
    skills: [],
    spans: new Map(),
    files: new Map(),
    sources: new Map(sources.map((x) => [x.id, x])),
    sourcesBy: new Map(),
    findings: new Map(),
    result: report.report ?? undefined,
    evals: report.evals ?? undefined,
    error: report.error ?? undefined,
    doneMs: report.durationMs ?? undefined,
  };
  for (const e of events) apply(s, e);
  return s;
}

/** Applies one event in place; callers copy the state to trigger a render. */
export function apply(s: RunState, e: WireEvent) {
  switch (e.type) {
    case "plan":
      s.plan = e.plan;
      s.loaded = e.loaded;
      break;
    case "skills":
      s.skills = e.available;
      break;
    case "span":
      s.spans.set(e.span.id, e.span);
      break;
    case "file":
      s.files.set(e.path, { path: e.path, bytes: e.bytes, by: e.by });
      break;
    case "sources":
      if ("sources" in e) {
        for (const x of e.sources) s.sources.set(x.id, x);
        s.sourcesBy.set(e.subtask, [...new Set([...(s.sourcesBy.get(e.subtask) ?? []), ...e.sources.map((x) => x.id)])]);
      } else s.sourcesBy.set(e.subtask, e.ids);
      break;
    case "finding":
      s.findings.set(e.finding.subtask, e.finding);
      break;
    case "report":
      s.result = e.report;
      break;
    case "evals":
      s.evals = e.evals;
      break;
    case "error":
      s.error = e.message;
      break;
    case "done":
      s.doneMs = e.ms;
      break;
  }
}

export const isTerminal = (status: SerializedReport["status"]) => status === "completed" || status === "failed" || status === "cancelled";

export type Phase = "queued" | "planning" | "researching" | "writing" | "verifying" | "done" | "failed";

/** Where the run is, for the progress line. */
export function phase(s: RunState): Phase {
  if (s.report.status === "failed" || s.report.status === "cancelled") return "failed";
  if (s.report.status === "completed") return "done";
  if (s.evals || [...s.spans.values()].some((x) => x.kind === "eval")) return "verifying";
  if (s.result || [...s.spans.values()].some((x) => x.name === "synthesis")) return s.result ? "verifying" : "writing";
  if (s.plan) return "researching";
  if (s.report.status === "running") return "planning";
  return "queued";
}

export type AgentStatus = "queued" | "running" | "done" | "failed";

/** One row per sub-agent: its task, status, and what it has found so far. */
export function agents(s: RunState): { task: Subtask; status: AgentStatus; sources: number; claims: number; steps: Span[] }[] {
  return (s.plan?.subtasks ?? []).map((task) => {
    const span = [...s.spans.values()].find((x) => x.kind === "agent" && x.name.startsWith(`${task.id} ·`));
    const finding = s.findings.get(task.id);
    const status: AgentStatus = finding ? (finding.claims.length || !finding.summary.startsWith("This sub-agent failed") ? "done" : "failed") : span ? (span.status === "error" ? "failed" : "running") : "queued";
    const steps = span ? [...s.spans.values()].filter((x) => x.parent === span.id).sort((a, b) => a.start - b.start) : [];
    return { task, status, sources: s.sourcesBy.get(task.id)?.length ?? 0, claims: finding?.claims.length ?? 0, steps };
  });
}

/** Running totals from model-call spans, for live display before the row is final. */
export function liveUsage(s: RunState) {
  let input = 0, output = 0, calls = 0, cost = 0, priced = true, tools = 0;
  for (const x of s.spans.values()) {
    if (x.kind === "tool") tools++;
    if (x.kind !== "llm" || x.end === undefined) continue;
    calls++;
    input += Number(x.attrs.input ?? 0);
    output += Number(x.attrs.output ?? 0) + Number(x.attrs.thinking ?? 0);
    if (x.attrs.cost === undefined) priced = false;
    else cost += Number(x.attrs.cost);
  }
  return { input, output, calls, tools, cost: priced ? cost : undefined };
}
