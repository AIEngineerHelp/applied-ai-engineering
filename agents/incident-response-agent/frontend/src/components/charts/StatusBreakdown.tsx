'use client';

import Link from 'next/link';
import { statusMeta } from '@/lib/meta';
import { incidentsHref } from '@/lib/route';
import type { IncidentStatus } from '@/lib/types';
import { Dot } from '../ui/Badge';
import { EmptyState } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

/**
 * Horizontal bars, one per status present. A single series, so one neutral
 * gray; the status dot + label carries identity and the value sits at the
 * bar end. Every row links to the Incidents view filtered to that status.
 */
export function StatusBreakdown({
  rows,
  loading,
}: {
  rows: { status: IncidentStatus; count: number }[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-3 p-4" aria-hidden>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) return <EmptyState title="No incidents yet." />;
  const max = Math.max(...rows.map((r) => r.count));
  const total = rows.reduce((a, r) => a + r.count, 0);

  return (
    <ul className="p-1.5" aria-label={`Incidents by status, ${total} total`}>
      {rows.map(({ status, count }) => {
        const meta = statusMeta(status);
        const pct = Math.round((count / total) * 100);
        return (
          <li key={status}>
            <Link
              href={incidentsHref({ status })}
              aria-label={`${meta.label}: ${count} (${pct}%). Show these incidents`}
              className="grid min-h-9 grid-cols-[8rem_1fr_2.5rem] items-center gap-3 rounded-md px-2.5 transition-colors duration-150 hover:bg-hover max-md:min-h-11"
            >
              <span className="flex min-w-0 items-center gap-2 text-[13px] text-fg">
                <Dot tone={meta.tone} />
                <span className="truncate">{meta.label}</span>
              </span>
              <span className="h-1.5 min-w-0" aria-hidden>
                <span className="block h-full bg-chart-bar" style={{ width: `${Math.max(2, (count / max) * 100)}%` }} />
              </span>
              <span className="text-right text-[13px] text-fg tabular-nums">{count}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
