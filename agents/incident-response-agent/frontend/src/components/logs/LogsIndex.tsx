'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { useDatasets } from '@/lib/hooks';
import { logsHref } from '@/lib/route';
import type { DatasetSummary } from '@/lib/types';
import { EmptyState } from '../ui/Card';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Skeleton } from '../ui/Skeleton';

const th = 'h-9 px-3 text-[12px] font-medium text-fg-muted';

export function timeRange(d: Pick<DatasetSummary, 'time_start' | 'time_end'>): string {
  if (!d.time_start && !d.time_end) return '—';
  return `${d.time_start ?? '?'} – ${d.time_end ?? '?'}`;
}

/** Index of the Loghub sample datasets the agent investigates. */
export function LogsIndex({ navigate }: { navigate: (href: string) => void }) {
  const { data, error, isLoading, mutate } = useDatasets();

  const rows = useMemo(
    () =>
      [...(data?.datasets ?? [])].sort(
        (a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name),
      ),
    [data],
  );

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[14px] leading-relaxed text-fg-muted">
        The agent investigates these public Loghub sample logs; label an incident{' '}
        <code className="rounded border border-border px-1 font-mono text-[12px] text-fg">dataset=&lt;name&gt;</code> to point it at
        one.{' '}
        {data && (
          <a
            href={data.citation.url}
            target="_blank"
            rel="noopener noreferrer"
            title={data.citation.text}
            className="whitespace-nowrap text-link hover:underline"
          >
            Loghub, ISSRE 2023 ↗
          </a>
        )}
      </p>

      {error && <ErrorNotice error={error} prefix="Could not load datasets" onRetry={() => void mutate()} />}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full table-fixed text-left text-[13px]">
          <caption className="sr-only">Log datasets, grouped by category</caption>
          <thead className="border-b border-border bg-subtle">
            <tr>
              <th scope="col" className={cn(th, 'pl-4 md:w-64')}>Dataset</th>
              <th scope="col" className={cn(th, 'w-44 max-lg:hidden')}>Category</th>
              <th scope="col" className={cn(th, 'w-20 text-right max-sm:hidden')}>Lines</th>
              <th scope="col" className={cn(th, 'w-24 text-right')}>Event types</th>
              <th scope="col" className={cn(th, 'w-64 max-xl:hidden')}>Time range</th>
              <th scope="col" className={cn(th, 'pr-4 max-md:hidden')}>Most frequent event</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading && !data ? (
              Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="h-12" aria-hidden>
                  <td className="pl-4" colSpan={6}>
                    <Skeleton className="h-4 w-2/3" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState title={data ? 'No datasets are loaded.' : 'Datasets are unavailable.'} />
                </td>
              </tr>
            ) : (
              rows.map((d) => {
                const top = d.top_templates[0];
                return (
                  <tr
                    key={d.name}
                    onClick={() => navigate(logsHref(d.name))}
                    className="cursor-pointer align-top transition-colors duration-150 hover:bg-hover"
                  >
                    <td className="py-2.5 pr-3 pl-4">
                      <Link
                        href={logsHref(d.name)}
                        onClick={(e) => e.stopPropagation()}
                        className="block truncate rounded text-fg hover:underline"
                      >
                        {d.title}
                      </Link>
                      <span className="block truncate text-[12px] text-fg-subtle">
                        <span className="font-mono">{d.name}</span>
                        <span className="lg:hidden"> · {d.category ?? 'Uncategorized'}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-fg-muted max-lg:hidden">{d.category ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right text-fg tabular-nums max-sm:hidden">{d.lines.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-fg tabular-nums">{d.event_types.toLocaleString()}</td>
                    <td className="truncate px-3 py-2.5 text-[12px] text-fg-muted tabular-nums max-xl:hidden" title={timeRange(d)}>
                      {timeRange(d)}
                    </td>
                    <td className="py-2.5 pr-4 pl-3 max-md:hidden">
                      {top ? (
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate font-mono text-[12px] text-fg" title={top.template}>
                            {top.template}
                          </span>
                          <span className="shrink-0 text-[12px] text-fg-subtle tabular-nums">×{top.count.toLocaleString()}</span>
                        </span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
