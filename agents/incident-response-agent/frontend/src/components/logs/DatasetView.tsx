'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useSWRConfig } from 'swr';
import { createIncident, errorMessage, keys } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useDatasetLogs, useDatasets, useDatasetTemplates, useMe, useRole } from '@/lib/hooks';
import { highestRole, roleLabel } from '@/lib/roles';
import { incidentHref, logsHref, type LogsFilters, type LogsTab } from '@/lib/route';
import type { DatasetSuggestedIncident, DatasetSummary, DatasetTemplate } from '@/lib/types';
import { useUrlDraft } from '@/lib/useUrlDraft';
import { SeverityBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState, PageTitle, TextButton } from '../ui/Card';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Skeleton } from '../ui/Skeleton';
import { Tabs, type TabItem } from '../ui/Tabs';
import { useToast } from '../ui/Toast';
import { timeRange } from './LogsIndex';

const PAGE = 100;

const inputClass =
  'h-8 rounded-md border border-border-strong bg-bg px-2.5 text-[13px] text-fg placeholder:text-fg-subtle transition-colors duration-150 focus-visible:border-link focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-link max-md:h-11 max-md:text-[16px]';

function levelClass(level: string | null): string {
  const l = (level ?? '').toUpperCase();
  if (l === 'ERROR' || l === 'FATAL' || l === 'SEVERE' || l === 'CRITICAL') return 'text-danger-fg';
  if (l === 'WARN' || l === 'WARNING') return 'text-warning-fg';
  return 'text-fg-subtle';
}

export function DatasetView({
  name,
  filters,
  setFilters,
  navigate,
}: {
  name: string;
  filters: LogsFilters;
  setFilters: (patch: Partial<LogsFilters>) => void;
  navigate: (href: string) => void;
}) {
  const index = useDatasets();
  const dataset = index.data?.datasets.find((d) => d.name === name) ?? null;
  const templates = useDatasetTemplates(name);

  if (index.error && !index.data) {
    return <ErrorNotice error={index.error} prefix="Could not load datasets" onRetry={() => void index.mutate()} />;
  }
  if (!index.data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!dataset) {
    return (
      <EmptyState
        title={`No dataset named “${name}”.`}
        action={<TextButton onClick={() => navigate(logsHref())}>All datasets</TextButton>}
        className="px-0 text-left"
      />
    );
  }

  const tabs: TabItem<LogsTab>[] = [
    { id: 'logs', label: 'Logs', count: dataset.lines },
    { id: 'events', label: 'Event types', count: dataset.event_types },
    { id: 'try', label: 'Try it', count: dataset.suggested_incidents.length },
  ];

  return (
    <div className="space-y-6">
      <DatasetHeader dataset={dataset} />
      <section aria-label="Dataset contents">
        <Tabs tabs={tabs} value={filters.tab} onChange={(tab) => setFilters({ tab })} idPrefix="dataset" label="Dataset contents" />
        <div role="tabpanel" id={`dataset-panel-${filters.tab}`} aria-labelledby={`dataset-tab-${filters.tab}`} className="pt-4">
          {filters.tab === 'logs' && <LogsTabPanel dataset={dataset} filters={filters} setFilters={setFilters} />}
          {filters.tab === 'events' && (
            <EventsTabPanel
              templates={templates.data}
              error={templates.error}
              onRetry={() => void templates.mutate()}
              onPick={(event) => setFilters({ tab: 'logs', event, q: '', level: null })}
            />
          )}
          {filters.tab === 'try' && <TryItPanel dataset={dataset} navigate={navigate} />}
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- header */

function DatasetHeader({ dataset: d }: { dataset: DatasetSummary }) {
  const levels = Object.entries(d.levels);
  return (
    <header>
      <PageTitle>{d.title}</PageTitle>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-muted">
        <span className="font-mono text-[12px] text-fg">{d.name}</span>
        {d.category && <span>{d.category}</span>}
        <a href={d.source_url} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
          Source ↗
        </a>
      </p>
      <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-fg">{d.description}</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-3 sm:grid-cols-4">
        <Fact label="Lines">{d.lines.toLocaleString()}</Fact>
        <Fact label="Event types">{d.event_types.toLocaleString()}</Fact>
        <Fact label="Time range" wide>
          <span className="truncate" title={timeRange(d)}>
            {timeRange(d)}
          </span>
        </Fact>
        {levels.length > 0 && (
          <Fact label="Levels" wide>
            <span className="truncate">
              {levels.map(([level, count], i) => (
                <span key={level}>
                  {i > 0 && <span className="text-fg-subtle"> · </span>}
                  <span className={levelClass(level)}>{level}</span> <span className="text-fg-muted tabular-nums">{count.toLocaleString()}</span>
                </span>
              ))}
            </span>
          </Fact>
        )}
      </dl>
    </header>
  );
}

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 text-[13px] text-fg tabular-nums">{children}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------- logs */

function LogsTabPanel({
  dataset,
  filters,
  setFilters,
}: {
  dataset: DatasetSummary;
  filters: LogsFilters;
  setFilters: (patch: Partial<LogsFilters>) => void;
}) {
  const commitQ = useCallback((q: string) => setFilters({ q }), [setFilters]);
  const [draft, setDraft] = useUrlDraft(filters.q, commitQ);
  const offset = (filters.page - 1) * PAGE;
  const { data, error, isLoading, isValidating, mutate } = useDatasetLogs(dataset.name, {
    q: filters.q,
    level: filters.level,
    eventId: filters.event,
    offset,
    limit: PAGE,
  });
  const levels = Object.keys(dataset.levels);
  const hasLevels = levels.length > 0;
  const cols = hasLevels
    ? 'grid-cols-[3.5rem_10rem_4.5rem_8rem_3.5rem_1fr]'
    : 'grid-cols-[3.5rem_10rem_8rem_3.5rem_1fr]';
  const eventTemplate =
    filters.event && (data?.lines.find((l) => l.event_id === filters.event)?.template ?? dataset.top_templates.find((t) => t.event_id === filters.event)?.template);
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-80">
          <label htmlFor="logs-q" className="sr-only">
            Search log lines
          </label>
          <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            id="logs-q"
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search log lines"
            autoComplete="off"
            spellCheck={false}
            className={cn(inputClass, 'w-full pl-8')}
          />
        </div>
        {levels.length > 0 && (
          <>
            <label htmlFor="logs-level" className="sr-only">
              Level
            </label>
            <select
              id="logs-level"
              value={filters.level ?? ''}
              onChange={(e) => setFilters({ level: e.target.value || null })}
              className={cn(inputClass, 'cursor-pointer pr-7')}
            >
              <option value="">All levels</option>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </>
        )}
        {filters.event && (
          <span className="inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border-strong pr-1 pl-2.5 text-[12px] max-md:h-11">
            <span className="shrink-0 text-fg-muted">Event</span>
            <span className="shrink-0 font-mono text-fg">{filters.event}</span>
            {eventTemplate && (
              <span className="truncate font-mono text-fg-subtle" title={eventTemplate}>
                {eventTemplate}
              </span>
            )}
            <button
              type="button"
              onClick={() => setFilters({ event: null })}
              aria-label={`Remove event filter ${filters.event}`}
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-fg max-md:h-9 max-md:w-9"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        <span className="ml-auto text-[12px] text-fg-subtle">PII-scrubbed as the agent sees it</span>
      </div>

      {error && <ErrorNotice error={error} prefix="Could not load log lines" onRetry={() => void mutate()} />}

      <div className="rounded-lg border border-border">
        {/* Horizontal scroll inside the viewer on small screens only; lines wrap on desktop. */}
        <div className={cn('max-md:overflow-x-auto', isValidating && data && 'opacity-70 transition-opacity')}>
          <div
            role="table"
            aria-label={`${dataset.title} log lines`}
            aria-rowcount={total}
            className="font-mono text-[12px] leading-5 max-md:min-w-[720px]"
          >
            <div role="rowgroup" className="border-b border-border bg-subtle font-sans text-fg-muted">
              <div role="row" className={cn('grid gap-3 px-3 py-2', cols)}>
                <span role="columnheader" className="text-right">#</span>
                <span role="columnheader">Time</span>
                {hasLevels && <span role="columnheader">Level</span>}
                <span role="columnheader">Component</span>
                <span role="columnheader">Event</span>
                <span role="columnheader">Content</span>
              </div>
            </div>
            <div role="rowgroup" className="divide-y divide-border">
              {isLoading && !data ? (
                Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="px-3 py-2" aria-hidden>
                    <Skeleton className="h-3.5 w-full" />
                  </div>
                ))
              ) : data && data.lines.length === 0 ? (
                <EmptyState
                  title="No log lines match."
                  action={
                    <TextButton onClick={() => setFilters({ q: '', level: null, event: null })}>Clear filters</TextButton>
                  }
                />
              ) : (
                data?.lines.map((l) => (
                  <div
                    key={l.line_id}
                    role="row"
                    className={cn('grid gap-3 px-3 py-1 hover:bg-hover', cols)}
                  >
                    <span role="cell" className="text-right text-fg-subtle tabular-nums">
                      {l.line_id}
                    </span>
                    <span role="cell" className="truncate text-fg-muted" title={l.time}>
                      {l.time}
                    </span>
                    {hasLevels && (
                      <span role="cell" className={cn('truncate', levelClass(l.level))}>
                        {l.level ?? ''}
                      </span>
                    )}
                    <span role="cell" className="truncate text-fg-muted" title={l.component ?? undefined}>
                      {l.component ?? ''}
                    </span>
                    <span role="cell">
                      <button
                        type="button"
                        onClick={() => setFilters({ event: l.event_id })}
                        title={`Show only ${l.event_id}: ${l.template}`}
                        className="cursor-pointer rounded text-fg-subtle hover:text-fg hover:underline"
                      >
                        {l.event_id}
                      </button>
                    </span>
                    <span role="cell" className="min-w-0 text-fg max-md:whitespace-nowrap md:break-words" title={l.template}>
                      {l.content}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        {data && total > 0 && (
          <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-[12px] text-fg-muted">
            <span className="tabular-nums">
              {(offset + 1).toLocaleString()}–{Math.min(total, offset + PAGE).toLocaleString()} of {total.toLocaleString()} lines
            </span>
            {pageCount > 1 && (
              <span className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={() => setFilters({ page: filters.page - 1 })} disabled={filters.page <= 1} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <span className="px-1 tabular-nums" aria-current="page">
                  {filters.page} / {pageCount}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setFilters({ page: filters.page + 1 })}
                  disabled={filters.page >= pageCount}
                  aria-label="Next page"
                >
                  <ChevronRight />
                </Button>
              </span>
            )}
          </nav>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- event types */

function EventsTabPanel({
  templates,
  error,
  onRetry,
  onPick,
}: {
  templates: DatasetTemplate[] | undefined;
  error: unknown;
  onRetry: () => void;
  onPick: (eventId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (templates ?? []).filter((t) => !q || t.template.toLowerCase().includes(q) || t.event_id.toLowerCase() === q);
  }, [templates, query]);
  const max = Math.max(0.0001, ...(templates ?? []).map((t) => t.share));
  const th = 'h-9 px-3 text-[12px] font-medium text-fg-muted';

  return (
    <div className="space-y-3">
      <div className="relative sm:max-w-80">
        <label htmlFor="events-q" className="sr-only">
          Search event types
        </label>
        <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <input
          id="events-q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search event types"
          autoComplete="off"
          spellCheck={false}
          className={cn(inputClass, 'w-full pl-8')}
        />
      </div>

      {error != null && !templates && <ErrorNotice error={error} prefix="Could not load event types" onRetry={onRetry} />}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full table-fixed text-left text-[13px]">
          <caption className="sr-only">Event types (log templates) with counts</caption>
          <thead className="border-b border-border bg-subtle">
            <tr>
              <th scope="col" className={cn(th, 'w-16 pl-4')}>Event</th>
              <th scope="col" className={th}>Template</th>
              <th scope="col" className={cn(th, 'w-20 text-right')}>Count</th>
              <th scope="col" className={cn(th, 'w-40 max-sm:hidden')}>Share</th>
              <th scope="col" className={cn(th, 'w-32 pr-4 max-lg:hidden')}>Levels</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {!templates && error == null ? (
              Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="h-10" aria-hidden>
                  <td className="pl-4" colSpan={5}>
                    <Skeleton className="h-4 w-3/4" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <EmptyState title="No event types match." />
                </td>
              </tr>
            ) : (
              rows.map((t) => (
                <tr key={t.event_id} onClick={() => onPick(t.event_id)} className="cursor-pointer align-top transition-colors duration-150 hover:bg-hover">
                  <td className="py-2 pr-3 pl-4">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPick(t.event_id);
                      }}
                      aria-label={`Show log lines for ${t.event_id}`}
                      className="cursor-pointer rounded font-mono text-[12px] text-fg hover:underline"
                    >
                      {t.event_id}
                    </button>
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] break-words text-fg">{t.template}</td>
                  <td className="px-3 py-2 text-right text-fg tabular-nums">{t.count.toLocaleString()}</td>
                  <td className="px-3 py-2 max-sm:hidden">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-1.5 flex-1">
                        <span className="block h-full bg-chart-bar" style={{ width: `${Math.max(1, (t.share / max) * 100)}%` }} />
                      </span>
                      <span className="w-12 text-right text-[12px] text-fg-muted tabular-nums">{(t.share * 100).toFixed(1)}%</span>
                    </span>
                  </td>
                  <td className="py-2 pr-4 pl-3 text-[12px] max-lg:hidden">
                    {t.levels.length ? (
                      t.levels.map((l, i) => (
                        <span key={l}>
                          {i > 0 && ', '}
                          <span className={levelClass(l)}>{l}</span>
                        </span>
                      ))
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- try it */

function TryItPanel({ dataset, navigate }: { dataset: DatasetSummary; navigate: (href: string) => void }) {
  const hints = dataset.top_templates.slice(0, 3).map((t) => (t.template.length > 48 ? `${t.template.slice(0, 47)}…` : t.template));
  return (
    <div className="space-y-4">
      {hints.length > 0 && (
        <p className="max-w-3xl text-[14px] leading-relaxed text-fg-muted">
          Ask about anything these logs show — e.g.{' '}
          {hints.map((h, i) => (
            <span key={h}>
              {i > 0 && (i === hints.length - 1 ? ' or ' : ', ')}
              <span className="font-mono text-[12px] text-fg">“{h}”</span>
            </span>
          ))}
          .
        </p>
      )}
      {dataset.suggested_incidents.length === 0 ? (
        <EmptyState title="No suggested incidents for this dataset." className="px-0 text-left" />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {dataset.suggested_incidents.map((s) => (
            <li key={s.title}>
              <SuggestedIncident dataset={dataset.name} incident={s} navigate={navigate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SuggestedIncident({
  dataset,
  incident,
  navigate,
}: {
  dataset: string;
  incident: DatasetSuggestedIncident;
  navigate: (href: string) => void;
}) {
  const { allowed, ready } = useRole('responder');
  const { data: me } = useMe();
  const [busy, setBusy] = useState(false);
  const { mutate } = useSWRConfig();
  const { toast } = useToast();
  const role = highestRole(me);
  const gateReason = `Raising incidents needs the Responder role. You are signed in as ${role ? roleLabel[role] : 'a user with no role'}.`;

  async function raise() {
    setBusy(true);
    try {
      const created = await createIncident({
        source: 'manual',
        title: incident.title,
        description: incident.description,
        service: incident.service,
        severity: incident.severity,
        environment: 'prod',
        labels: { dataset },
      });
      await mutate(keys.incidentList);
      toast({ kind: 'success', title: 'Incident raised', description: created.title });
      navigate(incidentHref(created.id));
    } catch (err) {
      toast({ kind: 'error', title: 'Could not raise incident', description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <SeverityBadge severity={incident.severity} />
          <span className="text-[14px] font-medium text-fg">{incident.title}</span>
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{incident.description}</p>
        <p className="mt-1 font-mono text-[12px] text-fg-subtle">{incident.service}</p>
      </div>
      {ready && !allowed ? (
        <Button
          variant="secondary"
          aria-disabled="true"
          title={gateReason}
          aria-label={`Raise incident (${gateReason})`}
          onClick={(e) => e.preventDefault()}
          className="cursor-not-allowed opacity-50 hover:bg-bg"
        >
          Raise incident
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => void raise()} loading={busy} disabled={!ready}>
          Raise incident
        </Button>
      )}
    </div>
  );
}
