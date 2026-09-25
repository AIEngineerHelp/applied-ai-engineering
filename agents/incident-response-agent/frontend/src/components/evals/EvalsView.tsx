'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime, formatUsd, relativeTime } from '@/lib/format';
import { useEvalRun, useEvals, useNow } from '@/lib/hooks';
import type { CaseFilter, EvalsState, EvalsTab } from '@/lib/route';
import type { EvalCase, EvalMetrics, EvalRunDetail, EvalRunSummary } from '@/lib/types';
import { Dot } from '../ui/Badge';
import { EmptyState, Section, TextButton } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Markdown } from '../ui/Markdown';
import { Skeleton } from '../ui/Skeleton';
import { Tabs, type TabItem } from '../ui/Tabs';

const RUN_COMMAND = 'uv run python -m evals.loghub.evaluate --n 28 --seed 7';

/* ---------------------------------------------------------------- helpers */

/** Run ids/timestamps look like 2026-09-24T15-04-35Z: dashes in the time part. */
export function parseEvalTime(value: string | null | undefined): string | null {
  if (!value) return null;
  // Some values carry a run-name suffix ("…Z-seed7-graph"): keep only the timestamp.
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})(?:\.\d+)?Z/);
  const iso = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : value;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

function metric(run: EvalRunSummary | undefined, key: keyof EvalMetrics): number | null {
  const v = run?.metrics?.[key];
  return typeof v === 'number' ? v : null;
}

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function conf(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(2);
}

/** Label from runs.yaml, else a readable fallback ("Seed 7 · hold-out"); the run id stays in titles. */
function runName(r: EvalRunSummary): string {
  if (r.label) return r.label;
  const parts = [r.seed != null ? `Seed ${r.seed}` : 'Unlabelled run'];
  if (r.holdout) parts.push('hold-out');
  return parts.join(' · ');
}

function runDate(r: EvalRunSummary): string {
  const iso = parseEvalTime(r.started_at);
  return iso ? formatDateTime(iso) : r.run_id;
}

const th = 'h-9 px-3 text-[12px] font-medium text-fg-muted whitespace-nowrap';

/* ---------------------------------------------------------------- view */

export function EvalsView({ state, setState }: { state: EvalsState; setState: (patch: Partial<EvalsState>, push?: boolean) => void }) {
  const { data, error, isLoading, mutate } = useEvals();
  const runs = data?.runs ?? [];
  const selected = state.run ? runs.find((r) => r.run_id === state.run) ?? null : null;

  const tabs: TabItem<EvalsTab>[] = [
    { id: 'results', label: 'Results', count: data ? runs.length : undefined },
    ...(state.run ? [{ id: 'run' as const, label: selected ? `Run: ${runName(selected)}` : 'Run' }] : []),
    { id: 'method', label: 'How it works' },
  ];

  return (
    <div className="space-y-4">
      {error && <ErrorNotice error={error} prefix={data ? 'Could not refresh eval results' : 'Could not load eval results'} onRetry={() => void mutate()} />}
      <Tabs tabs={tabs} value={state.tab} onChange={(tab) => setState({ tab })} idPrefix="evals" label="Evals" />
      <div role="tabpanel" id={`evals-panel-${state.tab}`} aria-labelledby={`evals-tab-${state.tab}`} className="pt-2">
        {isLoading && !data ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        ) : state.tab === 'method' ? (
          data ? <HowItWorks methodology={data.methodology} /> : null
        ) : state.tab === 'run' && state.run ? (
          <RunDetail id={state.run} filter={state.cases} setFilter={(cases) => setState({ cases })} onBack={() => setState({ tab: 'results', run: null }, true)} />
        ) : !data ? null : runs.length === 0 ? (
          <p className="text-[13px] text-fg-muted">
            No eval runs yet. Run{' '}
            <code className="rounded border border-border px-1 font-mono text-[12px] text-fg">{RUN_COMMAND}</code>{' '}
            <CopyButton value={RUN_COMMAND} label="Copy command" className="inline-flex align-middle" /> — see{' '}
            <TextButton onClick={() => setState({ tab: 'method' })}>How it works</TextButton>.
          </p>
        ) : (
          <Results
            runs={runs}
            details={state.details}
            setDetails={(details) => setState({ details })}
            onHowItWorks={() => setState({ tab: 'method' })}
            onOpen={(run) => setState({ run, tab: 'run', cases: 'all' }, true)}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- results */

function Results({
  runs,
  details,
  setDetails,
  onHowItWorks,
  onOpen,
}: {
  runs: EvalRunSummary[];
  details: boolean;
  setDetails: (open: boolean) => void;
  onHowItWorks: () => void;
  onOpen: (id: string) => void;
}) {
  const latest = runs[0];
  return (
    <div className="space-y-6">
      <Summary runs={runs} onHowItWorks={onHowItWorks} onOpen={onOpen} />
      <details
        open={details}
        onToggle={(e) => {
          const open = (e.currentTarget as HTMLDetailsElement).open;
          if (open !== details) setDetails(open);
        }}
        className="rounded-lg border border-border"
      >
        <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[14px] font-medium text-fg select-none hover:bg-hover">
          Details for engineers
        </summary>
        <div className="space-y-8 border-t border-border p-4 md:p-5">
          <Headline run={latest} />
          <RunHistory runs={runs} onOpen={onOpen} />
          {runs.length >= 2 && <Compare runs={runs} />}
        </div>
      </details>
    </div>
  );
}

/* ---------------------------------------------------------------- plain summary */

function countOf(run: EvalRunSummary | undefined, key: keyof EvalMetrics): { n: number; of: number } | null {
  const rate = metric(run, key);
  const cases = metric(run, 'cases');
  if (rate == null || cases == null) return null;
  return { n: Math.round(rate * cases), of: cases };
}

function Summary({ runs, onHowItWorks, onOpen }: { runs: EvalRunSummary[]; onHowItWorks: () => void; onOpen: (id: string) => void }) {
  const now = useNow();
  const main = runs.find((r) => !r.holdout) ?? runs[0];
  const holdout = runs.find((r) => r.holdout) ?? null;
  const right = countOf(main, 'fault_top1_lenient');
  const machine = countOf(main, 'node_top1');
  const unseen = holdout ? countOf(holdout, 'fault_top1_lenient') : null;
  const score = metric(main, 'fault_top1_lenient');
  const pass = metric(main, 'target_fault_accuracy') ?? 0.7;
  const lazy = metric(main, 'baseline_lenient');
  const wrongConf = metric(main, 'mean_confidence_wrong');
  const started = parseEvalTime(main.started_at);
  const cost = metric(main, 'total_cost_usd');
  const passes = score != null && score >= pass;

  return (
    <section aria-labelledby="summary-heading" className="rounded-lg border border-border p-5 md:p-6">
      <h2 id="summary-heading" className="text-[15px] font-semibold text-fg">
        How good is the agent?
      </h2>

      <p className="mt-4 text-[22px] leading-snug font-semibold tracking-[-0.01em] text-fg md:text-[24px]">
        Found the right problem in{' '}
        <span className="tabular-nums">{right ? `${right.n} of ${right.of}` : '—'}</span> test incidents
        {score != null && <span className="ml-2 text-[15px] font-normal text-fg-muted tabular-nums">{pct(score)}</span>}
      </p>
      <ul className="mt-2 space-y-1 text-[14px] text-fg">
        {machine && (
          <li>
            Named the right machine in <strong className="font-semibold tabular-nums">{`${machine.n} of ${machine.of}`}</strong>.
          </li>
        )}
        {unseen && (
          <li>
            On <strong className="font-semibold tabular-nums">{unseen.of}</strong> incidents it had never seen:{' '}
            <strong className="font-semibold tabular-nums">{`${unseen.n} of ${unseen.of}`}</strong> right.
          </li>
        )}
      </ul>

      {score != null && (
        <div className="mt-5 max-w-xl">
          <PassTrack score={score} pass={pass} lazy={lazy} />
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-muted">
            <span className="flex items-center gap-1.5 font-medium text-fg">
              <Dot tone={passes ? 'success' : 'danger'} />
              {passes ? 'Passes' : 'Below the pass mark'}
            </span>
            <span className="tabular-nums">
              Pass mark {pct(pass)}
              {lazy != null && ` · Lazy guess ${pct(lazy)}`} · Agent {pct(score)}
            </span>
          </p>
        </div>
      )}

      {wrongConf != null && wrongConf >= 0.8 && (
        <p className="mt-4 flex max-w-2xl items-start gap-2 text-[14px] text-fg">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" strokeWidth={1.75} />
          <span>
            When it&rsquo;s wrong, it still sounds sure of itself ({pct(wrongConf)} confident). Treat its answers as strong suggestions.
          </span>
        </p>
      )}

      <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-[13px] text-fg-muted">
        <span className="tabular-nums">
          Last tested{' '}
          {started ? (
            <time dateTime={started} title={formatDateTime(started)}>
              {relativeTime(started, now)}
            </time>
          ) : (
            '—'
          )}
          {metric(main, 'cases') != null && ` · ${metric(main, 'cases')} incidents`}
          {cost != null && ` · cost ${formatUsd(cost)}`}
        </span>
        <TextButton onClick={onHowItWorks}>How is it marked?</TextButton>
        <TextButton onClick={() => onOpen(main.run_id)} className="text-fg-muted hover:text-fg">
          See every answer
        </TextButton>
      </p>
    </section>
  );
}

/** Track 0–100% with the agent's score, the pass mark and the lazy-guess marker. */
function PassTrack({ score, pass, lazy }: { score: number; pass: number; lazy: number | null }) {
  return (
    <div
      role="img"
      aria-label={`Agent ${pct(score)}, pass mark ${pct(pass)}${lazy != null ? `, lazy guess ${pct(lazy)}` : ''}`}
      className="relative h-6"
    >
      <span className="absolute inset-x-0 top-2.5 h-1.5 bg-hover" />
      <span className="absolute top-2.5 left-0 h-1.5 bg-fg" style={{ width: `${Math.round(score * 100)}%` }} />
      {lazy != null && <span className="absolute top-1 h-4 w-0.5 bg-fg-subtle" style={{ left: `calc(${lazy * 100}% - 1px)` }} title={`Lazy guess ${pct(lazy)}`} />}
      <span className="absolute top-0 h-6 w-0.5 bg-link" style={{ left: `calc(${pass * 100}% - 1px)` }} title={`Pass mark ${pct(pass)}`} />
    </div>
  );
}

/* ---------------------------------------------------------------- how it works */

const FULL_MARKER = '## What we measure';

function HowItWorks({ methodology }: { methodology: string }) {
  const at = methodology.indexOf(FULL_MARKER);
  const short = at >= 0 ? methodology.slice(0, at) : methodology;
  const full = at >= 0 ? methodology.slice(at) : '';
  return (
    <div className="max-w-3xl space-y-6">
      <article>
        <Markdown source={short} />
      </article>
      {full && (
        <details className="rounded-lg border border-border">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[14px] font-medium text-fg select-none hover:bg-hover">
            Full methodology (for engineers)
          </summary>
          <article className="border-t border-border px-4 py-5 md:px-6">
            <Markdown source={full} />
          </article>
        </details>
      )}
    </div>
  );
}

function Headline({ run }: { run: EvalRunSummary }) {
  const now = useNow();
  const target = metric(run, 'target_fault_accuracy') ?? 0.7;
  const lenient = metric(run, 'fault_top1_lenient');
  const pass = lenient != null && lenient >= target;
  const started = parseEvalTime(run.started_at);
  const cost = metric(run, 'total_cost_usd');
  const secs = metric(run, 'mean_seconds');
  return (
    <section aria-labelledby="latest-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="latest-heading" className="text-[15px] font-semibold text-fg">
          Latest run
          <span className="ml-2 text-[13px] font-normal text-fg-muted">
            {runName(run)}
            {started && (
              <time dateTime={started} title={formatDateTime(started)}>
                {' · '}
                {relativeTime(started, now)}
              </time>
            )}
            {run.holdout && ' · hold-out'}
          </span>
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Fault type (lenient)"
          value={pct(lenient)}
          context={
            <>
              <TargetBar value={lenient} target={target} />
              <span className="mt-1.5 flex items-center gap-1.5">
                <Dot tone={lenient == null ? 'neutral' : pass ? 'success' : 'danger'} />
                {lenient == null ? 'No data' : pass ? `Meets ${pct(target)} target` : `Below ${pct(target)} target`}
              </span>
              <Baseline value={metric(run, 'baseline_lenient')} />
            </>
          }
          className="max-md:col-span-2"
        />
        <Kpi label="Fault type (strict)" value={pct(metric(run, 'fault_top1_strict'))} context={<Baseline value={metric(run, 'baseline_strict')} />} />
        <Kpi label="Fault type, top-3" value={pct(metric(run, 'fault_top3_lenient'))} />
        <Kpi label="Node localisation" value={pct(metric(run, 'node_top1'))} />
        <Kpi
          label="Precision when confident"
          value={pct(metric(run, 'precision_when_confident'))}
          context={metric(run, 'confident_cases') != null ? `${metric(run, 'confident_cases')} confident cases` : undefined}
        />
        <Kpi
          label="Cost"
          value={cost == null ? '—' : formatUsd(cost)}
          context={[metric(run, 'cases') != null ? `${metric(run, 'cases')} cases` : null, secs != null ? `${Math.round(secs)}s avg` : null]
            .filter(Boolean)
            .join(' · ')}
        />
      </div>
    </section>
  );
}

function Kpi({ label, value, context, className }: { label: string; value: string; context?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-[92px] flex-col bg-bg px-4 py-3.5', className)}>
      <span className="text-[13px] font-medium text-fg-muted">{label}</span>
      <span className="mt-1 text-[24px] leading-8 font-semibold tracking-[-0.01em] text-fg tabular-nums">{value}</span>
      {context && <span className="mt-auto pt-1 text-[12px] text-fg-subtle">{context}</span>}
    </div>
  );
}

function Baseline({ value }: { value: number | null }) {
  if (value == null) return null;
  return <span className="block">baseline {pct(value)}</span>;
}

/** Thin meter with a tick at the target. */
function TargetBar({ value, target }: { value: number | null; target: number }) {
  return (
    <span
      role="meter"
      aria-label="Lenient fault accuracy against target"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : Math.round(value * 100)}
      aria-valuetext={value == null ? 'No data' : `${pct(value)}, target ${pct(target)}`}
      className="relative mt-1 block h-1.5 bg-hover"
    >
      <span className="absolute inset-y-0 left-0 bg-fg" style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      <span aria-hidden className="absolute -top-1 -bottom-1 w-px bg-fg-muted" style={{ left: `${target * 100}%` }} title={`Target ${pct(target)}`} />
    </span>
  );
}

function RunHistory({ runs, onOpen }: { runs: EvalRunSummary[]; onOpen: (id: string) => void }) {
  const now = useNow();
  return (
    <Section id="history-heading" title="Run history" boxed boxClassName="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-[13px]">
          <caption className="sr-only">Eval runs, newest first. Select a run to see its cases.</caption>
          <thead className="border-b border-border bg-subtle">
            <tr>
              <th scope="col" className={cn(th, 'pl-4')} title="When the run began">Started</th>
              <th scope="col" className={th} title="Name from runs.yaml">Run</th>
              <th scope="col" className={cn(th, 'text-right')} title="Which set of test incidents (same seed = same questions)">Seed</th>
              <th scope="col" className={cn(th, 'text-right')} title="Number of test incidents">Cases</th>
              <th scope="col" className={cn(th, 'text-right')} title="Right problem, any accepted answer">Lenient</th>
              <th scope="col" className={cn(th, 'text-right')} title="Right problem, exact expected answer">Strict</th>
              <th scope="col" className={cn(th, 'text-right')} title="Right answer anywhere in its top three guesses">Top-3</th>
              <th scope="col" className={cn(th, 'text-right')} title="Named the right machine">Node</th>
              <th scope="col" className={cn(th, 'text-right')} title="How sure it sounded when right / when wrong">
                Conf. ✓ / ✗
              </th>
              <th scope="col" className={cn(th, 'text-right')} title="LLM spend for the whole run">Cost</th>
              <th scope="col" className={cn(th, 'pr-4')} title="Code version that was tested">Commit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runs.map((r) => {
              const started = parseEvalTime(r.started_at);
              const lenient = metric(r, 'fault_top1_lenient');
              const target = metric(r, 'target_fault_accuracy') ?? 0.7;
              const cost = metric(r, 'total_cost_usd');
              return (
                <tr key={r.run_id} onClick={() => onOpen(r.run_id)} className="h-10 cursor-pointer transition-colors duration-150 hover:bg-hover">
                  <td className="py-2 pr-3 pl-4 whitespace-nowrap text-fg-muted tabular-nums">
                    {started ? (
                      <time dateTime={started} title={formatDateTime(started)}>
                        {relativeTime(started, now)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(r.run_id);
                      }}
                      className="cursor-pointer rounded text-left text-fg hover:underline"
                      title={r.run_id}
                    >
                      {runName(r)}
                    </button>
                    {r.holdout && <span className="ml-2 text-[12px] text-fg-muted">hold-out</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-fg-muted tabular-nums">
                    {r.seed ?? '—'}
                    {r.exclude_seed != null && <span className="text-fg-subtle"> −{r.exclude_seed}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{metric(r, 'cases') ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      {lenient != null && <Dot tone={lenient >= target ? 'success' : 'danger'} />}
                      {pct(lenient)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(metric(r, 'fault_top1_strict'))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(metric(r, 'fault_top3_lenient'))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(metric(r, 'node_top1'))}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-fg-muted tabular-nums">
                    {conf(metric(r, 'mean_confidence_correct'))} / {conf(metric(r, 'mean_confidence_wrong'))}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{cost == null ? '—' : formatUsd(cost)}</td>
                  <td className="py-2 pr-4 pl-3 font-mono text-[12px] text-fg-subtle">{r.git_commit?.slice(0, 7) ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- compare */

const compareMetrics: { key: keyof EvalMetrics; label: string }[] = [
  { key: 'fault_top1_lenient', label: 'Fault type (lenient)' },
  { key: 'fault_top1_strict', label: 'Fault type (strict)' },
  { key: 'fault_top3_lenient', label: 'Fault type, top-3' },
  { key: 'node_top1', label: 'Node localisation' },
  { key: 'precision_when_confident', label: 'Precision when confident' },
];

function Compare({ runs }: { runs: EvalRunSummary[] }) {
  const latest = runs[0];
  const baseline = runs.find((r, i) => i > 0 && r.label?.toLowerCase() === 'baseline') ?? runs[1];
  const [aId, setA] = useState(baseline.run_id);
  const [bId, setB] = useState(latest.run_id);
  const a = runs.find((r) => r.run_id === aId) ?? baseline;
  const b = runs.find((r) => r.run_id === bId) ?? latest;
  const select = 'h-8 max-w-full rounded-md border border-border-strong bg-bg px-2 text-[13px] text-fg max-md:h-11 max-md:text-[16px]';

  return (
    <Section id="compare-heading" title="Compare runs">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
        <label htmlFor="compare-a" className="sr-only">
          Base run
        </label>
        <select id="compare-a" value={a.run_id} onChange={(e) => setA(e.target.value)} className={cn(select, 'cursor-pointer')}>
          {runs.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {runName(r)} · {runDate(r)}
            </option>
          ))}
        </select>
        <span aria-hidden>→</span>
        <label htmlFor="compare-b" className="sr-only">
          Compared run
        </label>
        <select id="compare-b" value={b.run_id} onChange={(e) => setB(e.target.value)} className={cn(select, 'cursor-pointer')}>
          {runs.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {runName(r)} · {runDate(r)}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-[13px]">
          <caption className="sr-only">
            Metric changes from {runName(a)} to {runName(b)}
          </caption>
          <thead className="border-b border-border bg-subtle">
            <tr>
              <th scope="col" className={cn(th, 'pl-4')}>Metric</th>
              <th scope="col" className={cn(th, 'text-right')}>{runName(a)}</th>
              <th scope="col" className={cn(th, 'text-right')}>{runName(b)}</th>
              <th scope="col" className={cn(th, 'pr-4 text-right')}>Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {compareMetrics.map(({ key, label }) => {
              const va = metric(a, key);
              const vb = metric(b, key);
              const delta = va != null && vb != null ? Math.round((vb - va) * 100) : null;
              return (
                <tr key={key} className="h-9">
                  <th scope="row" className="py-1.5 pr-3 pl-4 font-normal text-fg">{label}</th>
                  <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{pct(va)}</td>
                  <td className="px-3 py-1.5 text-right text-fg tabular-nums">{pct(vb)}</td>
                  <td
                    className={cn(
                      'py-1.5 pr-4 pl-3 text-right font-medium tabular-nums',
                      delta == null || delta === 0 ? 'text-fg-subtle' : delta > 0 ? 'text-success-fg' : 'text-danger-fg',
                    )}
                  >
                    {delta == null ? '—' : delta === 0 ? '±0 pp' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} pp`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- run detail */

function RunDetail({
  id,
  filter,
  setFilter,
  onBack,
}: {
  id: string;
  filter: CaseFilter;
  setFilter: (f: CaseFilter) => void;
  onBack: () => void;
}) {
  const { data, error, isLoading, mutate } = useEvalRun(id);
  if (error && !data) {
    if (error.status === 404) {
      return <EmptyState title={`No eval run with id ${id}.`} action={<TextButton onClick={onBack}>All runs</TextButton>} className="px-0 text-left" />;
    }
    return <ErrorNotice error={error} prefix="Could not load the run" onRetry={() => void mutate()} />;
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return (
    <div className="space-y-8">
      <PlainLine run={data} />
      <RunHeader run={data} />
      <Cases run={data} filter={filter} setFilter={setFilter} />
      <PerLabel run={data} />
    </div>
  );
}

/** "27 of 28 right · 28 of 28 right machine · cost $1.98" */
function PlainLine({ run }: { run: EvalRunDetail }) {
  const right = run.cases.filter((c) => c.fault_lenient).length;
  const machine = run.cases.filter((c) => c.node_top1).length;
  const cost = metric(run, 'total_cost_usd');
  return (
    <p className="text-[18px] font-semibold tracking-[-0.01em] text-fg tabular-nums">
      {right} of {run.cases.length} right
      <span className="font-normal text-fg-muted">
        {' · '}
        {machine} of {run.cases.length} right machine
        {cost != null && ` · cost ${formatUsd(cost)}`}
      </span>
    </p>
  );
}

function RunHeader({ run }: { run: EvalRunDetail }) {
  const started = parseEvalTime(run.started_at);
  const models = Object.entries(run.models ?? {});
  const lenient = metric(run, 'fault_top1_lenient');
  const target = metric(run, 'target_fault_accuracy') ?? 0.7;
  return (
    <header>
      <h2 className="text-[20px] font-semibold text-fg">{runName(run)}</h2>
      <p className="mt-1 font-mono text-[12px] text-fg-subtle">{run.run_id}</p>
      {run.notes && <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-fg">{run.notes}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Started">{started ? formatDateTime(started) : '—'}</Fact>
        <Fact label="Dataset">{run.dataset}</Fact>
        <Fact label="Seed">
          {run.seed ?? '—'}
          {run.exclude_seed != null && <span className="text-fg-muted">&nbsp;(excludes {run.exclude_seed})</span>}
        </Fact>
        <Fact label="Sample">{run.holdout ? 'Hold-out' : 'Standard'}</Fact>
        <Fact label="Right problem">
          <span className="inline-flex items-center gap-1.5">
            {lenient != null && <Dot tone={lenient >= target ? 'success' : 'danger'} />}
            {pct(lenient)}
            <span className="text-fg-muted">
              · {metric(run, 'cases') ?? '—'} cases · {metric(run, 'total_cost_usd') != null ? formatUsd(metric(run, 'total_cost_usd') ?? 0) : '—'}
            </span>
          </span>
        </Fact>
        <Fact label="Commit">
          <span className="font-mono text-[12px]">{run.git_commit?.slice(0, 7) ?? '—'}</span>
        </Fact>
      </dl>
      {models.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-fg-muted">
          {models.map(([role, model]) => (
            <span key={role}>
              {role} <span className="font-mono text-fg">{model}</span>
            </span>
          ))}
        </p>
      )}
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-fg tabular-nums">{children}</dd>
    </div>
  );
}

function PerLabel({ run }: { run: EvalRunDetail }) {
  const rows = Object.entries(run.per_label ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!rows.length) return null;
  return (
    <Section id="per-label-heading" title="By answer-key label" boxed boxClassName="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <caption className="sr-only">Accuracy per BGL alert label</caption>
          <thead className="border-b border-border bg-subtle">
            <tr>
              <th scope="col" className={cn(th, 'pl-4')}>Label</th>
              <th scope="col" className={cn(th, 'text-right')}>Cases</th>
              <th scope="col" className={cn(th, 'text-right')} title="Right problem, any accepted answer">Lenient ✓</th>
              <th scope="col" className={cn(th, 'pr-4 text-right')} title="Exact expected answer">Strict ✓</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(([label, v]) => (
              <tr key={label} className="h-9">
                <th scope="row" className="py-1.5 pr-3 pl-4 font-mono text-[12px] font-normal text-fg">{label}</th>
                <td className="px-3 py-1.5 text-right tabular-nums">{v.n}</td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums', v.lenient < v.n ? 'text-fg' : 'text-fg-muted')}>
                  {v.lenient}/{v.n}
                </td>
                <td className="py-1.5 pr-4 pl-3 text-right text-fg-muted tabular-nums">
                  {v.strict}/{v.n}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Mark({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn('relative font-medium', ok ? 'text-success-fg' : 'text-danger-fg')} title={`${label}: ${ok ? 'hit' : 'miss'}`}>
      <span aria-hidden>{ok ? '✓' : '✗'}</span>
      <span className="sr-only">{ok ? 'hit' : 'miss'}</span>
    </span>
  );
}

function Cases({ run, filter, setFilter }: { run: EvalRunDetail; filter: CaseFilter; setFilter: (f: CaseFilter) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [allCols, setAllCols] = useState(false);
  const misses = run.cases.filter((c) => !c.fault_lenient).length;
  const rows = useMemo(() => {
    const list = run.cases.filter((c) => (filter === 'misses' ? !c.fault_lenient : filter === 'hits' ? c.fault_lenient : true));
    // Wrong answers first: they are what you read when changing the agent.
    return [...list].sort((a, b) => Number(a.fault_lenient) - Number(b.fault_lenient) || a.label.localeCompare(b.label));
  }, [run.cases, filter]);
  const colCount = allCols ? 8 : 5;

  const options: { id: CaseFilter; label: string }[] = [
    { id: 'all', label: `All ${run.cases.length}` },
    { id: 'misses', label: `Wrong ${misses}` },
    { id: 'hits', label: `Right ${run.cases.length - misses}` },
  ];

  return (
    <Section
      id="cases-heading"
      title="Every answer"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter answers" className="flex gap-1">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                aria-pressed={filter === o.id}
                onClick={() => setFilter(o.id)}
                className={cn(
                  'h-7 cursor-pointer rounded-md border px-2.5 text-[12px] tabular-nums transition-colors duration-150 max-md:h-11',
                  filter === o.id ? 'border-fg bg-hover font-medium text-fg' : 'border-border-strong text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <TextButton onClick={() => setAllCols((v) => !v)} className="text-fg-muted hover:text-fg">
            {allCols ? 'Fewer columns' : 'Show all columns'}
          </TextButton>
        </div>
      }
      boxed
      boxClassName="overflow-hidden"
    >
      <div className="overflow-x-auto">
        <table className={cn('w-full text-left text-[13px]', allCols && 'min-w-[860px]')}>
          <caption className="sr-only">Every test incident with the agent&rsquo;s answer; select one to see its reasoning</caption>
          <thead className="border-b border-border bg-subtle">
            <tr>
              <th scope="col" className={cn(th, 'w-8 pl-4')}>
                <span className="sr-only">Details</span>
              </th>
              <th scope="col" className={th} title="The machine named in the alert">Machine</th>
              {allCols && (
                <th scope="col" className={th} title="Expert label from the BGL logs">
                  Label
                </th>
              )}
              <th scope="col" className={th} title="The problem type the answer key expects">Answer key</th>
              <th scope="col" className={th} title="The problem type the agent concluded">Agent said</th>
              {allCols && (
                <th scope="col" className={cn(th, 'text-right')} title="How sure the agent said it was">
                  Confidence
                </th>
              )}
              <th scope="col" className={cn(th, 'text-center', !allCols && 'pr-4')} title="Is the agent's answer one the answer key accepts?">
                Right?
              </th>
              {allCols && (
                <th scope="col" className={cn(th, 'pr-4 text-center')} title="Did it name the right machine?">
                  Machine ✓
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={colCount}>
                  <EmptyState title="No answers match." />
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <CaseRow
                  key={c.case_id}
                  c={c}
                  allCols={allCols}
                  colCount={colCount}
                  open={open === c.case_id}
                  onToggle={() => setOpen((o) => (o === c.case_id ? null : c.case_id))}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function CaseRow({ c, open, allCols, colCount, onToggle }: { c: EvalCase; open: boolean; allCols: boolean; colCount: number; onToggle: () => void }) {
  const detailsId = `case-${c.case_id}`;
  return (
    <Fragment>
      <tr onClick={onToggle} className={cn('h-10 cursor-pointer border-t border-border transition-colors duration-150 first:border-t-0 hover:bg-hover', open && 'bg-hover')}>
        <td className="py-1.5 pl-4">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? 'Hide' : 'Show'} details for ${c.node}`}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:text-fg max-md:h-11 max-md:w-11"
          >
            <ChevronRight aria-hidden className={cn('h-4 w-4 transition-transform duration-150', open && 'rotate-90')} strokeWidth={1.5} />
          </button>
        </td>
        <td className="px-3 py-1.5 font-mono text-[12px] whitespace-nowrap text-fg" title={c.case_id}>
          {c.node}
        </td>
        {allCols && <td className="px-3 py-1.5 font-mono text-[12px] text-fg-muted">{c.label}</td>}
        <td className="px-3 py-1.5 text-fg">{c.expected}</td>
        <td className={cn('px-3 py-1.5', c.predicted ? 'text-fg' : 'text-fg-subtle')}>{c.predicted ?? (c.error ? 'error' : 'no answer')}</td>
        {allCols && <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{conf(c.confidence)}</td>}
        <td className={cn('py-1.5 text-center', allCols ? 'px-3' : 'pr-4 pl-3')}>
          <Mark ok={c.fault_lenient} label="Right problem" />
        </td>
        {allCols && (
          <td className="py-1.5 pr-4 pl-3 text-center">
            <Mark ok={c.node_top1} label="Right machine" />
          </td>
        )}
      </tr>
      {open && (
        <tr id={detailsId} className="bg-subtle">
          <td />
          <td colSpan={colCount - 1} className="px-3 pt-2 pb-4">
            <dl className="grid max-w-4xl gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[11rem_1fr]">
              <dt className="text-fg-muted">What the agent concluded</dt>
              <dd className="leading-relaxed text-fg">{c.description ?? <span className="text-fg-subtle">No conclusion</span>}</dd>
              <dt className="text-fg-muted">Blamed component</dt>
              <dd className="font-mono text-[12px] text-fg">
                {c.component ?? '—'}
                <span className="ml-2 font-sans text-fg-muted">
                  <Mark ok={c.node_top1} label="Right machine" /> right machine
                </span>
              </dd>
              <dt className="text-fg-muted">Its top 3 guesses</dt>
              <dd className="text-fg">
                {c.top3.length ? c.top3.join(', ') : '—'}
                <span className="ml-2 text-fg-muted">
                  <Mark ok={c.fault_top3_lenient} label="Right answer in top 3" /> right answer in top 3
                </span>
              </dd>
              <dt className="text-fg-muted">Answer key accepts</dt>
              <dd className="text-fg">
                {c.accepted.join(', ')}
                <span className="ml-2 text-fg-muted">
                  <Mark ok={c.fault_strict} label="Exact expected answer" /> exact answer ({c.expected})
                </span>
              </dd>
              <dt className="text-fg-muted">Confidence</dt>
              <dd className="text-fg tabular-nums">{c.confidence == null ? '—' : `${Math.round(c.confidence * 100)}%`}</dd>
              <dt className="text-fg-muted">Effort</dt>
              <dd className="text-fg tabular-nums">
                {c.iterations} {c.iterations === 1 ? 'pass' : 'passes'} · {c.seconds.toFixed(1)}s · {formatUsd(c.cost_usd)}
              </dd>
              {c.error && (
                <>
                  <dt className="text-fg-muted">Error</dt>
                  <dd className="font-mono text-[12px] break-words whitespace-pre-wrap text-danger-fg">{c.error}</dd>
                </>
              )}
              <dt className="text-fg-muted">Case id · label</dt>
              <dd className="font-mono text-[12px] text-fg-subtle">
                {c.case_id} · {c.label}
              </dd>
            </dl>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
