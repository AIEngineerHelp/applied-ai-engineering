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
  revision: number;
  clarification: string;
  revision_reason: string;
}

export type SetName = "seeded" | "recorded";
export type CellSummaries = Record<string, Partial<Record<Version, { summary: Summary; recorded_at: string; models: Record<string, string> }>>>;

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
  recorded: CellSummaries;
  sets: Record<SetName, CellSummaries>;
  revisions: Record<string, Risk[]>;
  live: { available: boolean; attacks: number; models: Record<string, string>; busy: boolean; hosted?: boolean };
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

export interface Seed {
  question: string;
  persona: string;
  tactic: string;
  tactic_hint: string;
}

export interface Attack {
  index: number;
  seed?: Seed;
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
  rule_revision?: number;
  seeded?: boolean;
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
  status: string; // running, done, error, or interrupted (saved as running by a process that stopped)
  summary: Summary | null;
  scored: number;
}

// ---------- results/study/summary.json ----------

export interface Agreement {
  n: number;
  agree: number;
  agreement: number | null;
  both_pass: number;
  both_fail: number;
  false_pass: number;
  false_fail: number;
  label_fails: number;
  kappa: number | null;
}

export interface LabelledConversation {
  risk: string;
  version: Version;
  attack: number;
  label: "pass" | "fail";
  borderline: boolean;
  reason: string;
  judges: Record<string, { passed: boolean; reason: string }>;
  keyword: boolean | null;
  first_turn: string;
}

export interface DiversityMetrics {
  n?: number;
  trigram_overlap: number | null;
  distinct_2: number | null;
  shared_opening: number | null;
  embedding_similarity?: number | null;
}

export interface LoopResult {
  risk: string;
  version: Version;
  attack: number;
  rule_before: string;
  rule_after: string;
  clarification: string;
  reason: string;
  rejudged: { attack: number; before: string; status: string; reason: string }[] | null;
  rerun_summary: Summary | null;
  seeded_summary: Summary | null;
}

export interface Study {
  labels: { n: number; fail: number; borderline: number };
  raters: Record<string, { overall: Agreement; by_risk: Record<string, Agreement> }>;
  judge_models: string[];
  judge_disagreements: { risk: string; version: Version; attack: number; label: string; borderline: boolean }[];
  conversations: LabelledConversation[];
  keyword: {
    checks: Record<string, string>;
    half_refusals_passed: { risk: string; version: Version; attack: number; reason: string }[];
    vs_judge: Record<string, Agreement>;
  };
  diversity: { embedding_model: string; sets: Record<SetName, { cells: Record<string, DiversityMetrics>; mean: DiversityMetrics }> } | null;
  pass_rates: Record<SetName, Record<string, Summary>>;
  loop: LoopResult[];
  seeded_check: {
    cell: string;
    n: number;
    label_passed: number;
    raters: Record<string, Agreement>;
    conversations: (Omit<LabelledConversation, "judges" | "first_turn"> & { judges: Record<string, boolean>; seed: Seed | null })[];
  } | null;
  cost: { total: { calls: number; usd: number }; by_model: Record<string, { calls: number; usd: number }> };
  examples: { half_refusal: { risk: string; version: Version; attack: number; turn: number; phrases: string[] } };
  openings: Record<SetName, string[]>;
  openings_cell: string;
  stack: StackStudy | null;
  faceoff: Faceoff | null;
}

export type StackId = "judge" | "regex" | "judge_and_regex" | "judge_or_regex" | "two_judges";

/** results/study/stack.json: Giskard's RegexMatching combined with the judges via AllOf / AnyOf. */
export interface StackStudy {
  patterns: Record<string, { description: string; pattern: string }>;
  stacks: (Agreement & { id: StackId; name: string; meaning: string; giskard: string })[];
  conversations: {
    set: SetName;
    risk: string;
    version: Version;
    attack: number;
    label: "pass" | "fail";
    borderline: boolean;
    reason: string;
    verdicts: Record<StackId, boolean>;
  }[];
}

export type AttackStyle = "seeded" | "crescendo" | "goat";

export interface FaceoffCell {
  n: number;
  passed: number;
  failed: number;
  errored: number;
  mean_turns: number | null;
  max_turns: number;
  second_judge_failed: number | null;
  second_judge_agree: number | null;
  shared_opening: number | null;
}

/** results/faceoff/summary.json: Giskard's Crescendo and GOAT attackers next to our seeded attacker. */
export interface Faceoff {
  cells: string[];
  goals: Record<string, string>;
  styles: Record<AttackStyle, Record<string, FaceoffCell>>;
  openers: Record<AttackStyle, Record<string, string[]>>;
  second_judge: string | null;
}
