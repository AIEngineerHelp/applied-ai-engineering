'use client';

import { Fragment, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime, shortId, truncateMiddle } from '@/lib/format';
import { useAudit, useRole } from '@/lib/hooks';
import { incidentHref } from '@/lib/route';
import type { AuditEvent } from '@/lib/types';
import { Button } from '../ui/Button';
import { Card, EmptyState } from '../ui/Card';
import { ErrorNotice, PermissionNotice } from '../ui/ErrorNotice';
import { JsonBlock } from '../ui/JsonBlock';
import { Skeleton } from '../ui/Skeleton';

const PAGE = 100;

/** Admin-only view of `GET /v1/audit`, optionally filtered to one incident (from `?incident=`). */
export function AuditView({
  incidentId,
  onFilterChange,
}: {
  incidentId: string | null;
  onFilterChange: (incidentId: string | null) => void;
}) {
  const { allowed: isAdmin, ready } = useRole('admin');
  const [limit, setLimit] = useState(PAGE);
  const [draft, setDraft] = useState(incidentId ?? '');
  const { data, error, isLoading, isValidating, mutate } = useAudit(incidentId, limit, ready && isAdmin);

  function applyFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onFilterChange(draft.trim() || null);
  }

  function clearFilter() {
    setDraft('');
    onFilterChange(null);
  }

  return (
    <div className="space-y-4">
      {!ready ? (
        <AuditSkeleton />
      ) : !isAdmin ? (
        <PermissionNotice message="You don't have permission to view the audit log (needs the Admin role)." />
      ) : (
        <>
          <form onSubmit={applyFilter} role="search" className="flex flex-wrap items-center gap-2">
            <label htmlFor="audit-incident" className="sr-only">
              Filter by incident id
            </label>
            <input
              id="audit-incident"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Filter by incident id"
              spellCheck={false}
              autoComplete="off"
              className="h-8 min-w-0 flex-1 basis-56 rounded-md border border-border-strong bg-bg px-2.5 font-mono text-[12px] text-fg placeholder:font-sans placeholder:text-[13px] placeholder:text-fg-subtle focus-visible:border-link focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-link max-md:h-11 max-md:text-[16px] sm:max-w-80"
            />
            <Button type="submit" variant="secondary" disabled={(draft.trim() || null) === incidentId}>
              Apply
            </Button>
            {incidentId && (
              <Button variant="ghost" onClick={clearFilter}>
                Clear
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              onClick={() => void mutate()}
              disabled={isValidating}
              aria-label="Refresh audit log"
              title="Refresh"
            >
              <RefreshCw className={cn(isValidating && 'animate-spin')} />
            </Button>
          </form>

          {incidentId && (
            <p className="text-[13px] text-fg-muted">
              Showing events for incident{' '}
              <Link href={incidentHref(incidentId)} className="rounded font-mono text-[12px] text-link hover:underline">
                {truncateMiddle(incidentId, 10, 4)}
              </Link>
            </p>
          )}

          {error && <ErrorNotice error={error} onRetry={() => void mutate()} />}

          {isLoading && !data ? (
            <AuditSkeleton />
          ) : !data ? null : data.length === 0 ? (
            <EmptyState title={incidentId ? 'No audit events for this incident.' : 'No audit events yet.'} className="px-0 text-left" />
          ) : (
            <>
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-[13px]">
                    <caption className="sr-only">Audit events, newest first</caption>
                    <thead className="border-b border-border bg-subtle text-[12px] text-fg-muted">
                      <tr className="h-9">
                        <th scope="col" className="w-10 pl-4" aria-label="Details" />
                        <th scope="col" className="px-2 font-medium">Time</th>
                        <th scope="col" className="px-2 font-medium">Action</th>
                        <th scope="col" className="px-2 font-medium">Actor</th>
                        <th scope="col" className="px-2 pr-4 font-medium">Incident</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((event) => (
                        <AuditRow key={event.id} event={event} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <div className="flex items-center justify-between text-[12px] text-fg-subtle">
                <span className="tabular-nums">
                  {data.length} event{data.length === 1 ? '' : 's'}
                </span>
                {data.length >= limit && (
                  <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE)} loading={isValidating}>
                    Load more
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function AuditRow({ event }: { event: AuditEvent }) {
  const [open, setOpen] = useState(false);
  const hasDetails = event.details && Object.keys(event.details).length > 0;
  const detailsId = `audit-details-${event.id}`;
  return (
    <Fragment>
      <tr className="h-10 border-t border-border align-middle transition-colors duration-150 first:border-t-0 hover:bg-hover">
        <td className="pl-4">
          {hasDetails && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={open ? 'Hide details' : 'Show details'}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg max-md:h-11 max-md:w-11"
            >
              <ChevronRight aria-hidden className={cn('h-4 w-4 transition-transform duration-150', open && 'rotate-90')} />
            </button>
          )}
        </td>
        <td className="px-2 py-1.5 text-[13px] whitespace-nowrap text-fg-muted tabular-nums">
          <time dateTime={event.at} title={event.at}>
            {formatDateTime(event.at)}
          </time>
        </td>
        <td className="px-2 py-1.5">
          <span className="font-mono text-[12px] font-medium break-all text-fg">{event.action}</span>
          {hasDetails && !open && (
            <span className="block max-w-md truncate font-mono text-[12px] text-fg-subtle">{compactJson(event.details)}</span>
          )}
        </td>
        <td className="max-w-56 px-2 py-1.5">
          <span className="block truncate text-fg" title={event.actor}>
            {event.actor}
          </span>
        </td>
        <td className="px-2 py-1.5 pr-4">
          {event.incident_id ? (
            <Link
              href={incidentHref(event.incident_id)}
              title={event.incident_id}
              className="rounded font-mono text-[12px] text-link hover:underline"
            >
              {shortId(event.incident_id)}
            </Link>
          ) : (
            <span className="text-fg-subtle">—</span>
          )}
        </td>
      </tr>
      {hasDetails && open && (
        <tr id={detailsId}>
          <td />
          <td colSpan={4} className="px-2 pt-1 pr-4 pb-3">
            <JsonBlock value={event.details} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function AuditSkeleton() {
  return (
    <Card className="divide-y divide-border" aria-busy="true" aria-label="Loading audit log">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3.5 w-1/4" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </Card>
  );
}
