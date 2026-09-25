'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatAge, formatDateTime, relativeTime, shortId } from '@/lib/format';
import { useIncidents, useNow } from '@/lib/hooks';
import { ENVIRONMENTS, SEVERITIES, envLabel, incidentStatusMeta, incidentStatusOrder, severityMeta, toneDot } from '@/lib/meta';
import { DEFAULT_FILTERS, incidentHref, type IncidentFilters, type SortKey, type StatusFilter } from '@/lib/route';
import { filterIncidents, sortIncidents } from '@/lib/stats';
import type { Environment, Severity } from '@/lib/types';
import { SeverityBadge, StatusLabel } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState, TextButton } from '../ui/Card';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Skeleton } from '../ui/Skeleton';

const PAGE_SIZE = 50;

const statusGroups: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'done', label: 'Reported or resolved' },
];

const sinceOptions: { value: IncidentFilters['since']; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const controlClass =
  'h-8 rounded-md border border-border-strong bg-bg px-2.5 text-[13px] text-fg transition-colors duration-150 hover:bg-hover focus-visible:border-link focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-link max-md:h-11 max-md:text-[16px]';

export function IncidentsView({
  filters,
  setFilters,
  openIncident,
}: {
  filters: IncidentFilters;
  setFilters: (patch: Partial<IncidentFilters>) => void;
  openIncident: (id: string) => void;
}) {
  const { data, error, isLoading, mutate } = useIncidents();
  const now = useNow();

  const filtered = useMemo(() => filterIncidents(data ?? [], filters, now), [data, filters, now]);
  const sorted = useMemo(() => sortIncidents(filtered, filters.sort, filters.dir), [filtered, filters.sort, filters.dir]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const active = activeFilterCount(filters);

  function sortBy(key: SortKey) {
    if (filters.sort === key) setFilters({ dir: filters.dir === 'asc' ? 'desc' : 'asc', page });
    else setFilters({ sort: key, dir: key === 'started' ? 'desc' : 'asc', page });
  }

  return (
    <div className="space-y-4">
      <FilterBar filters={filters} setFilters={setFilters} activeCount={active} />

      {error && (
        <ErrorNotice error={error} prefix={data ? 'Live updates paused' : 'Could not load incidents'} onRetry={() => void mutate()} />
      )}

      <div className="rounded-lg border border-border bg-surface">
        {/* No overflow clipping at md+, so the header can stick to the page scroller. */}
        <div className="max-md:overflow-x-auto">
          <table className="w-full table-fixed text-left text-[13px]">
            <caption className="sr-only">
              Incidents, sorted by {filters.sort} {filters.dir === 'asc' ? 'ascending' : 'descending'}
            </caption>
            <thead className="sticky top-0 z-10 text-[12px] text-fg-muted [&_th]:bg-subtle [&_th:first-child]:rounded-tl-lg [&_th:last-child]:rounded-tr-lg [&_th]:shadow-[inset_0_-1px_0_var(--border)]">
              <tr className="h-9">
                <SortHeader label="Severity" k="severity" filters={filters} onSort={sortBy} className="w-[76px] pl-4 sm:w-[88px]" />
                <SortHeader label="Title" k="title" filters={filters} onSort={sortBy} />
                <SortHeader label="Service" k="service" filters={filters} onSort={sortBy} className="w-44 max-lg:hidden" />
                <SortHeader label="Environment" k="environment" filters={filters} onSort={sortBy} className="w-32 max-xl:hidden" />
                <SortHeader label="Status" k="status" filters={filters} onSort={sortBy} className="w-44 max-sm:hidden" />
                <SortHeader label="Started" k="started" filters={filters} onSort={sortBy} className="w-28 max-md:hidden" />
                <th scope="col" className="w-[72px] pr-4 pl-2 text-right font-medium sm:w-[88px]">
                  Age
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && !data ? (
                Array.from({ length: 8 }, (_, i) => <SkeletonRow key={i} />)
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    {data && data.length === 0 ? (
                      <EmptyState title="No incidents yet." />
                    ) : data ? (
                      <EmptyState
                        title="No incidents match these filters."
                        action={<TextButton onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</TextButton>}
                      />
                    ) : (
                      <EmptyState title="Incidents are unavailable." />
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((i) => (
                  <tr
                    key={i.id}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      openIncident(i.id);
                    }}
                    className="h-10 cursor-pointer border-t border-border transition-colors duration-150 first:border-t-0 hover:bg-hover"
                  >
                    <td className="py-2 pr-2 pl-4">
                      <SeverityBadge severity={i.severity} />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <Link
                          href={incidentHref(i.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="truncate rounded text-fg hover:underline"
                          title={i.title}
                        >
                          {i.title}
                        </Link>
                        <span className="shrink-0 font-mono text-[12px] text-fg-subtle max-sm:hidden">{shortId(i.id)}</span>
                      </div>
                      {/* Columns hidden at narrow widths surface here instead. */}
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted lg:hidden">
                        <span className="min-w-0 truncate font-mono">{i.service ?? 'no service'}</span>
                        <span aria-hidden className="shrink-0 max-sm:hidden">·</span>
                        <span className="shrink-0 max-sm:hidden">{i.environment}</span>
                        <span className="shrink-0 sm:hidden" aria-hidden>·</span>
                        <span className="shrink-0 sm:hidden">{incidentStatusMeta[i.status]?.label ?? i.status}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 font-mono text-[12px] text-fg-muted max-lg:hidden">
                      <span className="block truncate">{i.service ?? '—'}</span>
                    </td>
                    <td className="px-2 py-2 text-fg-muted max-xl:hidden">{envLabel[i.environment] ?? i.environment}</td>
                    <td className="px-2 py-2 max-sm:hidden">
                      <StatusLabel status={i.status} />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-fg-muted tabular-nums max-md:hidden">
                      <time dateTime={i.started_at} title={formatDateTime(i.started_at)}>
                        {relativeTime(i.started_at, now)}
                      </time>
                    </td>
                    <td className="py-2 pr-4 pl-2 text-right whitespace-nowrap text-fg-muted tabular-nums">
                      {formatAge(i.started_at, now)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data && sorted.length > 0 && sorted.length <= PAGE_SIZE && (
          <p className="border-t border-border px-4 py-2 text-[12px] text-fg-subtle tabular-nums">
            {sorted.length === data.length ? `${data.length} ${data.length === 1 ? 'incident' : 'incidents'}` : `${sorted.length} of ${data.length} incidents`}
          </p>
        )}
        {sorted.length > PAGE_SIZE && (
          <Pagination
            page={page}
            pageCount={pageCount}
            total={sorted.length}
            onPage={(p) => setFilters({ page: p })}
          />
        )}
      </div>
    </div>
  );
}

function activeFilterCount(f: IncidentFilters): number {
  return (
    (f.q.trim() ? 1 : 0) +
    (f.status !== 'all' ? 1 : 0) +
    (f.sev.length ? 1 : 0) +
    (f.env !== 'all' ? 1 : 0) +
    (f.service ? 1 : 0) +
    (f.since !== 'any' ? 1 : 0)
  );
}

/* ---------------------------------------------------------------- filters */

function FilterBar({
  filters,
  setFilters,
  activeCount,
}: {
  filters: IncidentFilters;
  setFilters: (patch: Partial<IncidentFilters>) => void;
  activeCount: number;
}) {
  // Local draft so typing isn't throttled by URL updates; synced (debounced) to the URL.
  const [draft, setDraft] = useState(filters.q);
  const [synced, setSynced] = useState(filters.q);
  if (filters.q !== synced) {
    // The URL changed from elsewhere (global search, back button): adopt it.
    setSynced(filters.q);
    setDraft(filters.q);
  }
  useEffect(() => {
    if (draft === filters.q) return;
    const t = window.setTimeout(() => {
      setSynced(draft);
      setFilters({ q: draft });
    }, 200);
    return () => window.clearTimeout(t);
  }, [draft, filters.q, setFilters]);

  function toggleSev(s: Severity) {
    const next = filters.sev.includes(s) ? filters.sev.filter((x) => x !== s) : [...filters.sev, s];
    setFilters({ sev: SEVERITIES.filter((x) => next.includes(x)) });
  }

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <div className="relative min-w-0 flex-1 basis-56 sm:max-w-72">
        <label htmlFor="incident-filter-q" className="sr-only">
          Search incidents
        </label>
        <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <input
          id="incident-filter-q"
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Filter by title, service or id"
          autoComplete="off"
          spellCheck={false}
          className={cn(controlClass, 'w-full pl-8')}
        />
      </div>
      <LabeledSelect id="incident-filter-status" label="Status" value={filters.status} onChange={(v) => setFilters({ status: v as StatusFilter })}>
        {statusGroups.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <optgroup label="Status">
          {incidentStatusOrder.map((s) => (
            <option key={s} value={s}>
              {incidentStatusMeta[s].label}
            </option>
          ))}
        </optgroup>
      </LabeledSelect>
      <LabeledSelect id="incident-filter-env" label="Environment" value={filters.env} onChange={(v) => setFilters({ env: v as Environment | 'all' })}>
        <option value="all">All environments</option>
        {ENVIRONMENTS.map((e) => (
          <option key={e} value={e}>
            {envLabel[e]}
          </option>
        ))}
      </LabeledSelect>
      <LabeledSelect id="incident-filter-since" label="Started" value={filters.since} onChange={(v) => setFilters({ since: v as IncidentFilters['since'] })}>
        {sinceOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </LabeledSelect>

      <div role="group" aria-label="Severity" className="flex flex-wrap gap-1">
        {SEVERITIES.map((s) => {
          const on = filters.sev.includes(s);
          const meta = severityMeta[s];
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              title={meta.name}
              onClick={() => toggleSev(s)}
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors duration-150 max-md:h-11',
                on ? 'border-fg bg-hover font-medium text-fg' : 'border-border-strong text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              <span aria-hidden className={cn('h-2 w-2 rounded-[1px]', toneDot[meta.tone])} />
              {meta.label}
            </button>
          );
        })}
      </div>

      {filters.service && (
        <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border-strong pr-1 pl-2.5 text-[13px] text-fg max-md:h-11">
          Service <span className="font-mono text-[12px]">{filters.service}</span>
          <button
            type="button"
            onClick={() => setFilters({ service: null })}
            aria-label={`Remove filter service ${filters.service}`}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-fg max-md:h-9 max-md:w-9"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
      {activeCount > 0 && (
        <TextButton
          onClick={() => {
            setDraft('');
            setSynced('');
            setFilters({ ...DEFAULT_FILTERS, sort: filters.sort, dir: filters.dir });
          }}
          className="px-1 text-fg-muted hover:text-fg"
        >
          Clear
        </TextButton>
      )}
    </div>
  );
}

function LabeledSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cn(controlClass, 'cursor-pointer pr-7 max-sm:flex-1')}>
        {children}
      </select>
    </>
  );
}

/* ---------------------------------------------------------------- table bits */

function SortHeader({
  label,
  k,
  filters,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  filters: IncidentFilters;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = filters.sort === k;
  const Icon = filters.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (filters.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('px-2 font-medium', className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          '-mx-1.5 inline-flex h-7 cursor-pointer items-center gap-1 rounded px-1.5 whitespace-nowrap transition-colors duration-150 hover:text-fg',
          active && 'text-fg',
        )}
      >
        {label}
        {active && <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />}
      </button>
    </th>
  );
}

function SkeletonRow() {
  return (
    <tr className="h-10 border-t border-border first:border-t-0" aria-hidden>
      <td className="pr-2 pl-4"><Skeleton className="h-4 w-12" /></td>
      <td className="px-2"><Skeleton className="h-4 w-4/5" /></td>
      <td className="px-2 max-lg:hidden"><Skeleton className="h-4 w-24" /></td>
      <td className="px-2 max-xl:hidden"><Skeleton className="h-4 w-20" /></td>
      <td className="px-2 max-sm:hidden"><Skeleton className="h-4 w-24" /></td>
      <td className="px-2 max-md:hidden"><Skeleton className="h-4 w-16" /></td>
      <td className="pr-4 pl-2"><Skeleton className="ml-auto h-4 w-12" /></td>
    </tr>
  );
}

function Pagination({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-border px-4 py-1.5 text-[12px] text-fg-muted">
      <span className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2 tabular-nums" aria-current="page">
          Page {page} of {pageCount}
        </span>
        <Button variant="ghost" size="icon" onClick={() => onPage(page + 1)} disabled={page >= pageCount} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
