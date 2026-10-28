// The shapes the FastAPI app (riskdemo/web.py) returns. Recorded and live runs share one format.

export type Version = "naive" | "hardened";
export type AttackStatus = "queued" | "running" | "passed" | "failed" | "error";

export interface Agent {
  id: string;
  name: string;
  industry: string;
  description: string;
  context: string;
  prompts: Record<Version, string>;
}

export interface Risk {
  id: string;
  agent: string;
  domain: string;
  category: string;
  risk: string;
  owner: string;
  basis: string;
  prohibited: string;
  allowed_alternative: string;
  expected_behavior: string;
  example_questions: string[];
  rule: string;
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
}

export interface ReviewNote {
  verdict: string;
  note: string;
}

export interface Catalog {
  agents: Record<string, Agent>;
  risks: Record<string, Risk>;
  versions: Version[];
  recorded: Record<string, Partial<Record<Version, { summary: Summary; recorded_at: string; models: Record<string, string> }>>>;
  live: { available: boolean; attacks: number; models: Record<string, string>; busy: boolean };
  attacker_template: string;
  judge_template: string;
  // "<risk>--<version>" -> attack number (1-based) -> note
  review_notes: Record<string, Record<string, ReviewNote>>;
}

export interface Turn {
  user: string;
  agent: string | null;
  ms?: number;
}

export interface Check {
  name: string;
  kind: string | null;
  status: string;
  reason: string;
}

export interface Attack {
  index: number;
  status: AttackStatus;
  turns: Turn[];
  checks: Check[];
  error: string | null;
  duration_ms: number | null;
  // Set while a replay or live run is in progress: who is "typing" next.
  pending?: "attacker" | "agent" | "judge" | null;
}

export interface Run {
  id: string;
  mode: "recorded" | "live";
  agent: string;
  risk: string;
  version: Version;
  models: Record<string, string>;
  rule: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  attacks: Attack[];
  summary: Summary | null;
  error?: string;
}

export interface RunListing {
  id: string;
  risk: string;
  version: Version;
  started_at: string;
  status: string;
  summary: Summary | null;
}
