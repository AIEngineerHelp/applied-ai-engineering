export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export type Environment = 'prod' | 'staging' | 'dev';
export type IncidentStatus =
  | 'new'
  | 'cached'
  | 'queued'
  | 'investigating'
  | 'awaiting_approval'
  | 'remediating'
  | 'reported'
  | 'resolved'
  | 'failed'
  | 'rejected';

export interface Incident {
  id: string;
  source: string;
  external_id: string | null;
  title: string;
  description: string;
  service: string | null;
  environment: Environment;
  severity: Severity;
  labels: Record<string, string>;
  started_at: string;
  received_at: string;
  signature: string;
  signature_hash: string;
  status: IncidentStatus;
}

export type NodeRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface NodeRun {
  node: string;
  status: NodeRunStatus;
  started_at: string;
  duration_ms: number | null;
  error: string | null;
  iteration: number;
}

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  goal: string;
  tool: string;
  args: Record<string, unknown>;
  depends_on: string[];
  status: PlanStepStatus;
  iteration: number;
}

export interface Evidence {
  id: string;
  step_id: string;
  tool: string;
  summary: string;
  artifact_uri: string | null;
  pii_redacted: boolean;
  collected_at: string;
  ok: boolean;
}

export interface Hypothesis {
  root_cause_component: string;
  fault_type: string;
  description: string;
  evidence_ids: string[];
  confidence: number;
  alternatives: Hypothesis[];
}

export interface Approval {
  decision: 'approved' | 'rejected' | 'expired';
  by: string;
  at: string;
  comment: string | null;
}

export type ActionStatus =
  | 'proposed'
  | 'blocked'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'skipped';

export type Risk = 'read' | 'write' | 'destructive';

export interface ProposedAction {
  id: string;
  kind: string;
  args: Record<string, unknown>;
  risk: Risk;
  rationale: string;
  requires_approval: boolean;
  approval: Approval | null;
  /** 1, or 2 for two-person actions. */
  required_approvals: number;
  /** Individual approver decisions so far (distinct approvers). */
  approvals: Approval[];
  status: ActionStatus;
  result: string | null;
  iteration: number;
  guardrail_notes: string[];
}

export interface Report {
  incident_id: string;
  summary: string;
  markdown: string;
  timeline: { at: string; event: string }[];
  root_cause: Hypothesis | null;
  actions_taken: ProposedAction[];
  follow_ups: string[];
  links: Record<string, string>;
}

export type RunStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cached';

export interface RunCache {
  kind: 'exact' | 'semantic';
  score: number | null;
  source_incident_id: string | null;
}

/** One line of live narration of what the agent is doing (oldest first in `RunInfo.activity`). */
export interface ActivityEntry {
  at: string;
  node: string;
  message: string;
  iteration: number;
}

export interface RunInfo {
  status: RunStatus;
  current_node: string | null;
  nodes: string[];
  history: NodeRun[];
  iterations: number;
  error: string | null;
  cache: RunCache | null;
  /** LLM spend for this run so far, in USD (absent on older API versions). */
  budget_used_usd?: number;
  /** Live narration, oldest first, max 200 (absent on older API versions). */
  activity?: ActivityEntry[];
}

export interface Verification {
  verified: boolean;
  reason: string;
}

export interface IncidentDetail {
  incident: Incident;
  run: RunInfo;
  plan: PlanStep[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  actions: ProposedAction[];
  report: Report | null;
  verification: Verification | null;
}

export interface PendingApproval {
  action_id: string;
  incident_id: string;
  incident_title: string;
  severity: Severity;
  service: string | null;
  kind: string;
  args: Record<string, unknown>;
  risk: Risk;
  rationale: string;
  created_at: string;
  required_approvals: number;
  approvals: Approval[];
}

export interface CreateIncidentInput {
  source: string;
  title: string;
  description: string;
  service?: string;
  environment: Environment;
  severity: Severity;
  labels: Record<string, string>;
  external_id?: string;
}

export type Decision = 'approved' | 'rejected';

export interface DecisionInput {
  decision: Decision;
  comment?: string;
}

/** `recorded` = first of two approvals; the action is still pending. */
export interface DecisionResponse {
  status: 'accepted' | 'recorded';
  decision: Approval;
}

/* ---------------------------------------------------------------- auth */

export type Role = 'viewer' | 'responder' | 'approver' | 'admin';

export interface AuthConfig {
  mode: 'oidc' | 'disabled';
  issuer: string | null;
  client_id: string | null;
  scopes: string;
  audience: string | null;
}

export interface Me {
  sub: string;
  name: string | null;
  email: string | null;
  roles: Role[];
}

export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  incident_id: string | null;
  details: Record<string, unknown>;
}

/* ---------------------------------------------------------------- datasets (Loghub samples) */

export interface DatasetSuggestedIncident {
  title: string;
  description: string;
  service: string;
  severity: Severity;
}

export interface DatasetSummary {
  /** Value for the incident label `dataset=<name>`. */
  name: string;
  title: string;
  category: string | null;
  description: string;
  source_url: string;
  lines: number;
  event_types: number;
  /** Raw timestamps as they appear in the log (formats differ per dataset). */
  time_start: string | null;
  time_end: string | null;
  columns: string[];
  /** Line count per level; empty when the dataset has no level column. */
  levels: Record<string, number>;
  top_templates: { event_id: string; template: string; count: number }[];
  suggested_incidents: DatasetSuggestedIncident[];
}

export interface DatasetIndex {
  citation: { text: string; url: string; repository: string };
  datasets: DatasetSummary[];
}

export interface DatasetLogLine {
  line_id: number;
  time: string;
  level: string | null;
  component: string | null;
  event_id: string;
  template: string;
  content: string;
}

export interface DatasetLogs {
  dataset: string;
  total: number;
  offset: number;
  limit: number;
  pii_redacted: boolean;
  lines: DatasetLogLine[];
}

export interface DatasetTemplate {
  event_id: string;
  template: string;
  count: number;
  share: number;
  levels: string[];
  first_line: number;
}

/* ---------------------------------------------------------------- evals */

/** Older runs may lack some metrics; treat every value as possibly null. */
export interface EvalMetrics {
  cases: number | null;
  fault_top1_strict: number | null;
  fault_top1_lenient: number | null;
  fault_top3_lenient: number | null;
  node_top1: number | null;
  precision_when_confident: number | null;
  confident_cases: number | null;
  mean_confidence_correct: number | null;
  mean_confidence_wrong: number | null;
  baseline_majority_class: string | null;
  baseline_strict: number | null;
  baseline_lenient: number | null;
  total_cost_usd: number | null;
  mean_seconds: number | null;
  mean_iterations: number | null;
  errors: number | null;
  no_hypothesis: number | null;
  target_fault_accuracy: number | null;
}

export interface EvalRunSummary {
  run_id: string;
  dataset: string;
  /** e.g. "2026-09-24T15-04-35Z" (dashes in the time part); see parseEvalTime. */
  started_at: string | null;
  seed: number | null;
  holdout: boolean;
  exclude_seed: number | null;
  git_commit: string | null;
  label: string | null;
  notes: string | null;
  models: Record<string, string>;
  metrics: Partial<EvalMetrics>;
}

export interface EvalCase {
  case_id: string;
  node: string;
  label: string;
  expected: string;
  accepted: string[];
  predicted: string | null;
  component: string | null;
  confidence: number | null;
  top3: string[];
  fault_strict: boolean;
  fault_lenient: boolean;
  fault_top3_lenient: boolean;
  node_top1: boolean;
  iterations: number;
  cost_usd: number;
  seconds: number;
  error: string | null;
  description: string | null;
}

export interface EvalRunDetail extends EvalRunSummary {
  per_label: Record<string, { n: number; lenient: number; strict: number }>;
  cases: EvalCase[];
}

export interface EvalIndex {
  methodology: string;
  runs: EvalRunSummary[];
}

/* ---------------------------------------------------------------- knowledge graph */

export type GraphKind =
  | 'Dataset' | 'Rack' | 'Midplane' | 'NodeCard' | 'Host' | 'Component' | 'EventType' | 'IP' | 'User' | 'Service'
  | 'Instance' | 'RemoteHost' | 'Incident' | 'FaultType';

export type GraphEdgeType =
  | 'CONTAINS' | 'HAS_COMPONENT' | 'RUNS' | 'EMITS' | 'CONNECTS_TO' | 'MANAGES' | 'FAILED_LOGIN' | 'ACCEPTED_LOGIN'
  | 'SENDS_BLOCKS' | 'ABOUT' | 'ALERTED_ON' | 'ROOT_CAUSE' | 'HAS_FAULT';

export interface GraphNode {
  /** "<dataset>:<kind>:<name>", or "global:<kind>:<name>" for datasets, incidents and fault types. */
  key: string;
  kind: GraphKind;
  name: string;
  dataset: string | null;
  degree: number | null;
  props: {
    lines?: number;
    errors?: number;
    template?: string;
    card_type?: 'compute' | 'io' | 'other';
    incident_id?: string;
    severity?: string;
    status?: string;
    verified?: boolean;
    instance_id?: string;
    [k: string]: unknown;
  };
}

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
  count: number | null;
  confidence: number | null;
}

export interface GraphOverview {
  datasets: { dataset: string; kinds: Record<string, number>; nodes: number; edges: number; incidents: number }[];
}

export interface GraphSlice {
  dataset: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total_nodes: number;
}

export interface GraphNeighbourhood {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
