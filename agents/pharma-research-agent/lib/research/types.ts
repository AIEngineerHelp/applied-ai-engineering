// Shared shapes for a research run: the plan, the sources, the findings, the
// report, the trace and the evals. Everything a run produces is one of these.

/** The knowledge bases a sub-agent can search. */
export type SourceKind = "pubmed" | "trials" | "fda" | "web";

/** One retrieved document, normalised across sources. */
export interface Source {
  /** Stable, citable id: PMID:123, NCT01234567, FDA:set-id, WEB:n. */
  id: string;
  kind: SourceKind;
  title: string;
  url: string;
  /** A short excerpt the agent read (abstract, outcome, label section). */
  text: string;
  /** Year, journal, phase, status, etc. */
  meta: Record<string, string | number | boolean | undefined>;
}

/** One question the orchestrator hands to one sub-agent. */
export interface Subtask {
  id: string;
  /** What to find out, in one sentence. */
  question: string;
  /** Which knowledge base to search. */
  source: SourceKind;
  /** Skills (by name) the sub-agent should load. */
  skills: string[];
  /** Why this subtask matters for the query. */
  why: string;
}

export interface Plan {
  /** The orchestrator's restatement of the query. */
  focus: string;
  subtasks: Subtask[];
}

/** A claim a sub-agent makes, with the sources that support it. */
export interface Claim {
  text: string;
  sources: string[];
}

export interface Finding {
  subtask: string;
  summary: string;
  claims: Claim[];
  /** What the sub-agent could not find. */
  gaps: string[];
}

export interface ReportSection {
  heading: string;
  /** Markdown paragraphs; citations as [PMID:123] style ids. */
  body: string;
}

export interface Report {
  title: string;
  /** Two to four sentences answering the query directly. */
  answer: string;
  sections: ReportSection[];
  /** Where the evidence is thin, conflicting or missing. */
  limitations: string[];
  /** Overall confidence the evidence supports the answer. */
  confidence: "low" | "moderate" | "high";
}

/** A span in the trace: one model call, tool call, agent or step. */
export interface Span {
  id: string;
  parent?: string;
  kind: "run" | "agent" | "llm" | "tool" | "vfs" | "eval";
  name: string;
  /** ms since the run started. */
  start: number;
  end?: number;
  status: "running" | "ok" | "error";
  attrs: Record<string, string | number | boolean | undefined>;
}

export interface Usage {
  input: number;
  output: number;
  thinking: number;
  /** USD, when prices are configured; otherwise undefined. */
  cost?: number;
}

export interface EvalResult {
  name: string;
  /** 0..1 */
  score: number;
  /** One line a reader can understand. */
  detail: string;
  /** Deterministic checks need no model; judged ones do. */
  method: "check" | "judge";
  /** The judge's verdict on each sentence it checked. */
  items?: { text: string; verdict: string; reason: string }[];
}

/** Everything the UI and the saved run file contain. */
export type RunEvent =
  | { type: "run"; id: string; query: string; model: string; mode: "live" | "offline"; at: string }
  | { type: "skills"; available: { name: string; description: string }[] }
  | { type: "plan"; plan: Plan; loaded: string[] }
  | { type: "span"; span: Span }
  | { type: "file"; path: string; bytes: number; by: string; content: string }
  | { type: "sources"; subtask: string; sources: Source[] }
  | { type: "finding"; finding: Finding }
  | { type: "report"; report: Report; markdown: string }
  | { type: "evals"; evals: EvalResult[] }
  | { type: "usage"; usage: Usage; calls: number; toolCalls: number }
  /** The model's thought summary for one call, as it streams (text so far). */
  | { type: "thought"; key: string; agent: string; text: string; done?: boolean }
  /** The report as it is being written (markdown so far). */
  | { type: "draft"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; ms: number };
