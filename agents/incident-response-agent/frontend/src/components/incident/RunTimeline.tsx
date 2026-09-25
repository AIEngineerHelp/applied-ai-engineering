'use client';

import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatDuration, formatTime, formatUsd, humanize } from '@/lib/format';
import { nodeLabels, nodeShortLabels, type Tone } from '@/lib/meta';
import { incidentHref } from '@/lib/route';
import type { ActivityEntry, NodeRun, RunInfo, Verification } from '@/lib/types';
import { Dot, RunStatusLabel } from '../ui/Badge';
import { Section } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

type NodeState = NodeRun['status'] | 'not_reached';

interface NodeSummary {
  node: string;
  state: NodeState;
  latest: NodeRun | null;
  runs: number;
  totalMs: number;
}

const stateLabel: Record<NodeState, string> = {
  completed: 'Completed',
  running: 'Running',
  failed: 'Failed',
  interrupted: 'Interrupted (waiting)',
  not_reached: 'Not reached',
};

function summarize(run: RunInfo): NodeSummary[] {
  return run.nodes.map((node) => {
    const runs = run.history.filter((h) => h.node === node);
    const latest = runs.length ? runs[runs.length - 1] : null;
    return {
      node,
      latest,
      runs: runs.length,
      totalMs: runs.reduce((a, r) => a + (r.duration_ms ?? 0), 0),
      state: latest?.status ?? 'not_reached',
    };
  });
}

/** Right-rail run section: status, key numbers and the pipeline as a vertical timeline. */
export function RunTimeline({ run }: { run: RunInfo }) {
  const nodes = summarize(run);
  const total = run.history.reduce((acc, h) => acc + (h.duration_ms ?? 0), 0);
  const done = nodes.filter((n) => n.state === 'completed').length;
  const activity = run.activity ?? [];

  return (
    <Section id="run-heading" title="Agent run" action={<RunStatusLabel status={run.status} />} boxed>
      <dl className="grid grid-cols-3 divide-x divide-border border-b border-border">
        <Stat label="Steps" value={`${done}/${nodes.length}`} />
        <Stat label="Duration" value={total > 0 ? formatDuration(total) : '—'} />
        <Stat label={run.budget_used_usd !== undefined ? 'Cost' : 'Iterations'} value={run.budget_used_usd !== undefined ? formatUsd(run.budget_used_usd) : String(run.iterations)} />
      </dl>

      {run.error && (
        <div role="alert" className="border-b border-border px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <Dot tone="danger" />
            Run failed
          </p>
          <p className="mt-1 font-mono text-[12px] break-words whitespace-pre-wrap text-fg-muted">{run.error}</p>
        </div>
      )}

      <ol className="px-4 py-3" aria-label="Pipeline steps">
        {nodes.map((n, i) => (
          <Step key={n.node} summary={n} last={i === nodes.length - 1} latestActivity={latestFor(activity, n.node)} />
        ))}
      </ol>

      {(run.history.length > 0 || activity.length > 0) && <History history={run.history} activity={activity} />}
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-2.5">
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-semibold text-fg tabular-nums">{value}</dd>
    </div>
  );
}

const stepTone: Record<Exclude<NodeState, 'not_reached'>, Tone> = {
  completed: 'success',
  running: 'info',
  failed: 'danger',
  interrupted: 'warning',
};

function latestFor(activity: ActivityEntry[], node: string): ActivityEntry | null {
  for (let i = activity.length - 1; i >= 0; i--) if (activity[i].node === node) return activity[i];
  return null;
}

function Step({ summary, last, latestActivity }: { summary: NodeSummary; last: boolean; latestActivity: ActivityEntry | null }) {
  const { node, state, latest, runs, totalMs } = summary;
  const reached = state !== 'not_reached';
  return (
    <li className="relative flex gap-3 pb-2 last:pb-0" aria-current={state === 'running' ? 'step' : undefined}>
      {!last && <span aria-hidden className="absolute top-[18px] bottom-0 left-[3px] w-px bg-border" />}
      <span className="flex h-5 w-[7px] shrink-0 items-center justify-center">
        {reached ? (
          <Dot tone={stepTone[state]} pulse={state === 'running'} />
        ) : (
          <span aria-hidden className="h-1.5 w-1.5 rounded-full border border-border-strong" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn('text-[13px]', reached ? 'text-fg' : 'text-fg-subtle', state === 'running' && 'font-medium')}>
            {nodeLabels[node] ?? humanize(node)}
            <span className="sr-only">: {stateLabel[state]}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-fg-subtle tabular-nums">
            {runs > 1 && <span title={`Ran ${runs} times`}>×{runs}</span>}
            {state === 'running' ? '' : totalMs > 0 || latest?.duration_ms != null ? formatDuration(totalMs) : ''}
          </span>
        </div>
        {state === 'running' && latestActivity && (
          <p className="truncate text-[12px] text-fg-muted" title={latestActivity.message}>
            {latestActivity.message}
          </p>
        )}
        {latest?.error && <p className="mt-0.5 font-mono text-[12px] break-words whitespace-pre-wrap text-danger-fg">{latest.error}</p>}
        {state === 'interrupted' && !latest?.error && <p className="text-[12px] text-fg-muted">Waiting for a human decision</p>}
      </div>
    </li>
  );
}

const historyTone: Record<NodeRun['status'], string> = {
  completed: 'text-fg-muted',
  running: 'text-info-fg',
  failed: 'text-danger-fg',
  interrupted: 'text-warning-fg',
};

function History({ history, activity }: { history: NodeRun[]; activity: ActivityEntry[] }) {
  return (
    <details className="border-t border-border">
      <summary className="flex min-h-10 cursor-pointer items-center px-4 text-[13px] text-fg-muted select-none hover:text-fg max-md:min-h-11">
        Execution log
      </summary>
      {activity.length > 0 && (
        <div className="border-t border-border">
          <h3 className="px-4 pt-3 pb-1 text-[12px] font-medium text-fg-muted">Activity · {activity.length}</h3>
          <ol className="max-h-80 space-y-1 overflow-auto px-4 pb-3 text-[12px]">
            {activity.map((e, i) => (
              <li key={`${e.at}-${i}`} className="grid grid-cols-[4.25rem_4rem_1fr] gap-2">
                <time dateTime={e.at} className="text-fg-subtle tabular-nums">
                  {formatTime(e.at)}
                </time>
                <span className="text-fg-muted">{nodeShortLabels[e.node] ?? e.node}</span>
                <span className="min-w-0 break-words text-fg">{e.message}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {history.length > 0 && (
        <div className="border-t border-border">
          <h3 className="px-4 pt-3 pb-1 text-[12px] font-medium text-fg-muted">Steps · {history.length}</h3>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 bg-subtle text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-1.5 font-medium">Node</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Iter</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Started</th>
                  <th scope="col" className="px-4 py-1.5 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={`${h.node}-${i}`} className="border-t border-border align-top">
                    <td className="px-4 py-1.5">
                      <span className="font-mono text-fg">{h.node}</span>
                      <span className={cn('block', historyTone[h.status])}>{stateLabel[h.status]}</span>
                      {h.error && <span className="mt-0.5 block whitespace-pre-wrap text-danger-fg">{h.error}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-fg-muted tabular-nums">{h.iteration}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-fg-muted tabular-nums">{formatTime(h.started_at)}</td>
                    <td className="px-4 py-1.5 text-right text-fg-muted tabular-nums">{formatDuration(h.duration_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </details>
  );
}

export function CacheBanner({ cache }: { cache: NonNullable<RunInfo['cache']> }) {
  return (
    <section aria-label="Cache" className="text-[13px]">
      <p className="font-medium text-fg">Served from cache</p>
      <p className="mt-0.5 text-fg-muted">
        {cache.kind === 'exact' ? 'Exact signature match' : 'Semantic match'}
        {cache.score != null && <span className="tabular-nums"> · score {cache.score.toFixed(2)}</span>}
      </p>
      {cache.source_incident_id && (
        <Link href={incidentHref(cache.source_incident_id)} className="mt-1 inline-flex rounded text-link hover:underline max-md:min-h-11 max-md:items-center">
          View source incident
        </Link>
      )}
    </section>
  );
}

export function VerificationCard({ verification }: { verification: Verification }) {
  const ok = verification.verified;
  return (
    <section aria-labelledby="verification-heading">
      <h2 id="verification-heading" className="text-[15px] font-semibold text-fg">
        Verification
      </h2>
      <p className="mt-2 flex items-center gap-2 text-[13px] text-fg">
        <Dot tone={ok ? 'success' : 'neutral'} />
        {ok ? 'Remediation verified' : 'Not verified'}
      </p>
      {verification.reason && <p className="mt-0.5 text-[13px] leading-relaxed text-fg-muted">{verification.reason}</p>}
    </section>
  );
}

export function RunTimelineSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" aria-hidden>
      <Skeleton className="h-4 w-24" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-3.5 w-full" />
      ))}
    </div>
  );
}
