import type {
  ActionStatus,
  Environment,
  IncidentStatus,
  PlanStepStatus,
  Risk,
  RunStatus,
  Severity,
} from './types';

/** Signal tones from MASTER.md v2: a dot/square color plus a text color. No backgrounds. */
export type Tone = 'danger' | 'high' | 'warning' | 'neutral' | 'success' | 'info';

export const toneDot: Record<Tone, string> = {
  danger: 'bg-danger',
  high: 'bg-high',
  warning: 'bg-warning',
  neutral: 'bg-neutral',
  success: 'bg-success',
  info: 'bg-info',
};

export const toneText: Record<Tone, string> = {
  danger: 'text-danger-fg',
  high: 'text-high-fg',
  warning: 'text-warning-fg',
  neutral: 'text-neutral-fg',
  success: 'text-success-fg',
  info: 'text-info-fg',
};

export const severityMeta: Record<Severity, { label: string; tone: Tone; name: string; rank: number }> = {
  sev1: { label: 'SEV1', tone: 'danger', name: 'Critical', rank: 1 },
  sev2: { label: 'SEV2', tone: 'high', name: 'High', rank: 2 },
  sev3: { label: 'SEV3', tone: 'warning', name: 'Medium', rank: 3 },
  sev4: { label: 'SEV4', tone: 'neutral', name: 'Low', rank: 4 },
};

export const SEVERITIES: Severity[] = ['sev1', 'sev2', 'sev3', 'sev4'];

/** Chart fill per severity (CVD-validated chart steps, see globals.css). */
export const severityChartFill: Record<Severity, string> = {
  sev1: 'var(--chart-sev1)',
  sev2: 'var(--chart-sev2)',
  sev3: 'var(--chart-sev3)',
  sev4: 'var(--chart-sev4)',
};

export const envLabel: Record<Environment, string> = {
  prod: 'Production',
  staging: 'Staging',
  dev: 'Development',
};

export const ENVIRONMENTS: Environment[] = ['prod', 'staging', 'dev'];

interface StatusMeta {
  label: string;
  tone: Tone;
  /** Work in progress: the dot pulses gently (off under reduced motion). */
  live?: boolean;
}

export const incidentStatusMeta: Record<IncidentStatus, StatusMeta> = {
  new: { label: 'New', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'info' },
  investigating: { label: 'Investigating', tone: 'info', live: true },
  awaiting_approval: { label: 'Awaiting approval', tone: 'warning' },
  remediating: { label: 'Remediating', tone: 'info', live: true },
  reported: { label: 'Reported', tone: 'success' },
  resolved: { label: 'Resolved', tone: 'success' },
  cached: { label: 'Cached', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'neutral' },
};

export const incidentStatusOrder: IncidentStatus[] = [
  'new',
  'queued',
  'investigating',
  'awaiting_approval',
  'remediating',
  'reported',
  'resolved',
  'cached',
  'failed',
  'rejected',
];

/** Non-terminal statuses: the incident still needs the agent or a human. */
export const OPEN_STATUSES: IncidentStatus[] = ['new', 'queued', 'investigating', 'awaiting_approval', 'remediating'];

export function isOpenStatus(status: IncidentStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function statusMeta(status: string): StatusMeta {
  return incidentStatusMeta[status as IncidentStatus] ?? { label: status, tone: 'neutral' };
}

export const runStatusMeta: Record<RunStatus, StatusMeta> = {
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Running', tone: 'info', live: true },
  awaiting_approval: { label: 'Awaiting approval', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cached: { label: 'Cached', tone: 'neutral' },
};

export const actionStatusMeta: Record<ActionStatus, { label: string; tone: Tone }> = {
  proposed: { label: 'Proposed', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'danger' },
  pending_approval: { label: 'Pending approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  executed: { label: 'Executed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const planStatusMeta: Record<PlanStepStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const riskMeta: Record<Risk, { label: string; tone: Tone }> = {
  read: { label: 'Read', tone: 'neutral' },
  write: { label: 'Write', tone: 'warning' },
  destructive: { label: 'Destructive', tone: 'danger' },
};

export const nodeLabels: Record<string, string> = {
  load_context: 'Load context',
  plan: 'Plan',
  gather: 'Gather evidence',
  analyze: 'Analyze',
  propose_actions: 'Propose actions',
  guardrails: 'Guardrails',
  approval: 'Approval',
  execute: 'Execute',
  verify: 'Verify',
  report: 'Report',
  memory_update: 'Update memory',
};

/** Short step names for dense places (activity feed prefixes). */
export const nodeShortLabels: Record<string, string> = {
  load_context: 'Context',
  plan: 'Plan',
  gather: 'Gather',
  analyze: 'Analyze',
  propose_actions: 'Propose',
  guardrails: 'Guardrails',
  approval: 'Approval',
  execute: 'Execute',
  verify: 'Verify',
  report: 'Report',
  memory_update: 'Memory',
};
