'use client';

import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatAge, formatDateTime, relativeTime } from '@/lib/format';
import { useIncidents, useNow, usePendingApprovals } from '@/lib/hooks';
import { riskMeta } from '@/lib/meta';
import { approvalsHref, incidentHref, incidentsHref } from '@/lib/route';
import { computeKpis, incidentsPerDay, statusBreakdown, time, topServices } from '@/lib/stats';
import type { Incident, PendingApproval } from '@/lib/types';
import { IncidentsPerDayChart, IncidentsPerDayLegend } from '../charts/IncidentsPerDayChart';
import { StatusBreakdown } from '../charts/StatusBreakdown';
import { Dot, SeverityBadge, StatusLabel } from '../ui/Badge';
import { EmptyState, Section, TextButton } from '../ui/Card';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Skeleton } from '../ui/Skeleton';

export function OverviewView({ navigate }: { navigate: (href: string) => void }) {
  const incidents = useIncidents();
  const approvals = usePendingApprovals();
  const now = useNow();
  const list = incidents.data;
  const loading = !list && !incidents.error;
  const retry = () => void incidents.mutate();

  const kpis = useMemo(() => (list ? computeKpis(list, now) : null), [list, now]);
  const perDay = useMemo(() => (list ? incidentsPerDay(list, now) : []), [list, now]);
  const byStatus = useMemo(() => (list ? statusBreakdown(list) : []), [list]);
  const services = useMemo(() => (list ? topServices(list) : []), [list]);
  const recent = useMemo(
    () => (list ? [...list].sort((a, b) => time(b.received_at) - time(a.received_at)).slice(0, 8) : []),
    [list],
  );
  const failed = useMemo(
    () =>
      (list ?? [])
        .filter((i) => i.status === 'failed')
        .sort((a, b) => time(b.received_at) - time(a.received_at))
        .slice(0, 5),
    [list],
  );

  return (
    <div className="space-y-8">
      {incidents.error && (
        <ErrorNotice error={incidents.error} prefix={list ? 'Live updates paused' : 'Could not load incidents'} onRetry={retry} />
      )}

      <section aria-label="Key metrics">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3 lg:grid-cols-5">
          <Kpi label="Open incidents" value={kpis?.open} href={incidentsHref({ status: 'open' })} context={kpis ? `of ${kpis.total} total` : undefined} />
          <Kpi
            label="Awaiting approval"
            value={kpis?.awaiting}
            href={incidentsHref({ status: 'awaiting_approval' })}
            context={approvals.data ? `${approvals.data.length} ${approvals.data.length === 1 ? 'action' : 'actions'} pending` : undefined}
          />
          <Kpi
            label="Critical open"
            value={kpis?.criticalOpen}
            href={incidentsHref({ status: 'open', sev: ['sev1', 'sev2'] })}
            context={kpis ? `SEV1 ${kpis.criticalSev1} · SEV2 ${kpis.criticalOpen - kpis.criticalSev1}` : undefined}
          />
          <Kpi label="Reported or resolved" value={kpis?.doneLast24h} href={incidentsHref({ status: 'done', since: '24h' })} context="Last 24 hours" />
          <Kpi
            label="Failed runs"
            value={kpis?.failedLast24h}
            href={incidentsHref({ status: 'failed', since: '24h' })}
            context="Last 24 hours"
            className="max-md:col-span-2"
          />
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        <Section id="per-day-heading" title="Incidents per day" className="lg:col-span-2" boxed boxClassName="p-4">
          <div className="mb-3 flex justify-end">
            <IncidentsPerDayLegend />
          </div>
          {incidents.error && !list ? (
            <EmptyState title="Chart data is unavailable." action={<TextButton onClick={retry}>Retry</TextButton>} />
          ) : (
            <IncidentsPerDayChart buckets={perDay} loading={loading} />
          )}
        </Section>

        <NeedsAttention approvals={approvals.data} approvalsError={approvals.error} failed={failed} loading={loading} now={now} />
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        <Section
          id="recent-heading"
          title="Recent incidents"
          action={<ViewAll href={incidentsHref()}>View all</ViewAll>}
          className="lg:col-span-2"
          boxed
          boxClassName="overflow-hidden"
        >
          <RecentIncidents incidents={recent} loading={loading} now={now} navigate={navigate} />
        </Section>

        <Section id="status-heading" title="By status" boxed>
          {incidents.error && !list ? (
            <EmptyState title="Unavailable." action={<TextButton onClick={retry}>Retry</TextButton>} />
          ) : (
            <StatusBreakdown rows={byStatus} loading={loading} />
          )}
        </Section>
      </div>

      <Section id="services-heading" title="Top services" boxed boxClassName="overflow-hidden">
        <TopServices rows={services} loading={loading} now={now} />
      </Section>
    </div>
  );
}

/* ---------------------------------------------------------------- KPI strip */

function Kpi({
  label,
  value,
  href,
  context,
  className,
}: {
  label: string;
  value: number | undefined;
  href: string;
  context?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-h-[92px] flex-col bg-bg px-4 py-3.5 transition-colors duration-150 hover:bg-hover focus-visible:outline-offset-[-2px]',
        className,
      )}
    >
      <span className="text-[13px] font-medium text-fg-muted">{label}</span>
      <span className="mt-1 text-[24px] leading-8 font-semibold tracking-[-0.01em] text-fg tabular-nums">
        {value === undefined ? <span aria-hidden className="mt-1 block h-6 w-10 animate-pulse rounded bg-hover" /> : value}
      </span>
      <span className={cn('mt-auto text-[12px] text-fg-subtle', !context && 'invisible')}>{context ?? '–'}</span>
    </Link>
  );
}

/* ---------------------------------------------------------------- needs attention */

function NeedsAttention({
  approvals,
  approvalsError,
  failed,
  loading,
  now,
}: {
  approvals: PendingApproval[] | undefined;
  approvalsError: unknown;
  failed: Incident[];
  loading: boolean;
  now: number;
}) {
  const count = approvals?.length ?? 0;
  const empty = !loading && approvals !== undefined && count === 0 && failed.length === 0;
  return (
    <Section
      id="attention-heading"
      title="Needs attention"
      action={count > 0 ? <ViewAll href={approvalsHref}>Approvals</ViewAll> : undefined}
      boxed
      boxClassName="overflow-hidden"
    >
      {approvalsError != null && !approvals ? (
        <div className="p-3">
          <ErrorNotice error={approvalsError} prefix="Could not load approvals" />
        </div>
      ) : null}
      {loading || (approvals === undefined && approvalsError == null) ? (
        <div className="space-y-3 p-4" aria-hidden>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState title="Nothing needs attention." />
      ) : (
        <ul className="divide-y divide-border">
          {(approvals ?? []).slice(0, 5).map((a) => (
            <li key={a.action_id}>
              <AttentionRow
                href={incidentHref(a.incident_id)}
                title={a.incident_title}
                meta={
                  <>
                    <Dot tone="warning" />
                    <span>Approve</span>
                    <span className="font-mono">{a.kind}</span>
                    <span className="text-fg-subtle">{riskMeta[a.risk].label.toLowerCase()}</span>
                    {a.required_approvals > 1 && (
                      <span className="text-fg-subtle tabular-nums">
                        {a.approvals.filter((x) => x.decision === 'approved').length}/{a.required_approvals}
                      </span>
                    )}
                  </>
                }
                time={a.created_at}
                now={now}
              />
            </li>
          ))}
          {failed.map((i) => (
            <li key={i.id}>
              <AttentionRow
                href={incidentHref(i.id)}
                title={i.title}
                meta={
                  <>
                    <Dot tone="danger" />
                    <span>Run failed</span>
                    <span className="font-mono text-fg-subtle">{i.service ?? 'no service'}</span>
                  </>
                }
                time={i.received_at}
                now={now}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AttentionRow({ href, title, meta, time: at, now }: { href: string; title: string; meta: ReactNode; time: string; now: number }) {
  return (
    <Link href={href} className="block px-4 py-2.5 transition-colors duration-150 hover:bg-hover focus-visible:outline-offset-[-2px]">
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[13px] font-medium text-fg">{title}</span>
        <time dateTime={at} title={formatDateTime(at)} className="shrink-0 text-[12px] text-fg-subtle tabular-nums">
          {relativeTime(at, now)}
        </time>
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">{meta}</span>
    </Link>
  );
}

/* ---------------------------------------------------------------- recent */

const th = 'h-9 px-3 text-[12px] font-medium text-fg-muted';

function RecentIncidents({
  incidents,
  loading,
  now,
  navigate,
}: {
  incidents: Incident[];
  loading: boolean;
  now: number;
  navigate: (href: string) => void;
}) {
  if (!loading && incidents.length === 0) return <EmptyState title="No incidents yet." />;
  return (
    <table className="w-full table-fixed text-left text-[13px]">
      <caption className="sr-only">Most recently received incidents</caption>
      <thead className="border-b border-border bg-subtle">
        <tr>
          <th scope="col" className={cn(th, 'w-[76px] pl-4')}>Severity</th>
          <th scope="col" className={th}>Incident</th>
          <th scope="col" className={cn(th, 'w-40 max-sm:hidden')}>Status</th>
          <th scope="col" className={cn(th, 'w-20 pr-4 text-right')}>Age</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {loading
          ? Array.from({ length: 6 }, (_, i) => (
              <tr key={i} className="h-10">
                <td className="pl-4"><Skeleton className="h-4 w-12" /></td>
                <td className="px-3"><Skeleton className="h-4 w-3/4" /></td>
                <td className="px-3 max-sm:hidden"><Skeleton className="h-4 w-20" /></td>
                <td className="pr-4"><Skeleton className="ml-auto h-4 w-10" /></td>
              </tr>
            ))
          : incidents.map((i) => (
              <tr key={i.id} onClick={() => navigate(incidentHref(i.id))} className="h-10 cursor-pointer transition-colors duration-150 hover:bg-hover">
                <td className="py-2 pr-3 pl-4">
                  <SeverityBadge severity={i.severity} />
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={incidentHref(i.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="block truncate rounded text-fg hover:underline"
                    title={i.title}
                  >
                    {i.title}
                  </Link>
                </td>
                <td className="px-3 py-2 max-sm:hidden">
                  <StatusLabel status={i.status} />
                </td>
                <td className="py-2 pr-4 pl-3 text-right whitespace-nowrap text-fg-muted tabular-nums">
                  <time dateTime={i.started_at} title={formatDateTime(i.started_at)}>
                    {formatAge(i.started_at, now)}
                  </time>
                </td>
              </tr>
            ))}
      </tbody>
    </table>
  );
}

/* ---------------------------------------------------------------- services */

function TopServices({ rows, loading, now }: { rows: ReturnType<typeof topServices>; loading: boolean; now: number }) {
  if (!loading && rows.length === 0) return <EmptyState title="No services have reported incidents yet." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-[13px]">
        <caption className="sr-only">Services with the most incidents</caption>
        <thead className="border-b border-border bg-subtle whitespace-nowrap">
          <tr>
            <th scope="col" className={cn(th, 'pl-4')}>Service</th>
            <th scope="col" className={cn(th, 'text-right')}>Open</th>
            <th scope="col" className={cn(th, 'text-right')}>SEV1–2</th>
            <th scope="col" className={cn(th, 'text-right')}>Total</th>
            <th scope="col" className={th}>Worst</th>
            <th scope="col" className={cn(th, 'pr-4 text-right')}>Last incident</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {loading
            ? Array.from({ length: 3 }, (_, i) => (
                <tr key={i} className="h-10">
                  <td className="px-4" colSpan={6}>
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            : rows.map((r) => (
                <tr key={r.service || '(none)'} className="h-10 transition-colors duration-150 hover:bg-hover">
                  <th scope="row" className="py-2 pr-3 pl-4 font-normal whitespace-nowrap">
                    {r.service ? (
                      <Link href={incidentsHref({ service: r.service })} className="rounded font-mono text-[12px] text-fg hover:underline">
                        {r.service}
                      </Link>
                    ) : (
                      <span className="text-fg-subtle">No service</span>
                    )}
                  </th>
                  <td className="px-3 py-2 text-right text-fg tabular-nums">{r.open}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', r.critical ? 'text-fg' : 'text-fg-subtle')}>{r.critical}</td>
                  <td className="px-3 py-2 text-right text-fg tabular-nums">{r.total}</td>
                  <td className="px-3 py-2">
                    <SeverityBadge severity={r.worst} />
                  </td>
                  <td className="py-2 pr-4 pl-3 text-right whitespace-nowrap text-fg-muted tabular-nums">
                    <time dateTime={r.last} title={formatDateTime(r.last)}>
                      {relativeTime(r.last, now)}
                    </time>
                  </td>
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

function ViewAll({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="rounded text-[13px] text-fg-muted hover:text-fg hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
      {children}
    </Link>
  );
}
