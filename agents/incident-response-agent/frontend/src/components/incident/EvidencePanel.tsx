'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/cn';
import { formatDateTime, formatTime } from '@/lib/format';
import type { Evidence } from '@/lib/types';
import { Tag } from '../ui/Badge';
import { EmptyState } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { Skeleton } from '../ui/Skeleton';

export function EvidencePanel({
  evidence,
  active,
  highlight,
}: {
  evidence: Evidence[];
  active: boolean;
  highlight: { id: string; n: number } | null;
}) {
  useEffect(() => {
    if (!highlight) return;
    const el = document.getElementById(`evidence-${highlight.id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  }, [highlight]);

  if (evidence.length === 0) {
    return active ? (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-2.5 rounded-md border border-border p-4">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    ) : (
      <EmptyState title="No evidence collected." className="px-0 text-left" />
    );
  }

  return (
    <ul className="space-y-3">
      {evidence.map((item) => {
        const highlighted = highlight?.id === item.id;
        return (
          <li
            key={highlighted ? `${item.id}-${highlight.n}` : item.id}
            id={`evidence-${item.id}`}
            tabIndex={-1}
            className={cn('scroll-mt-24 rounded-md focus-visible:outline-none', highlighted && 'animate-flash')}
          >
            <EvidenceCard item={item} highlighted={highlighted} />
          </li>
        );
      })}
    </ul>
  );
}

function isHttp(uri: string) {
  return /^https?:\/\//i.test(uri);
}

function EvidenceCard({ item, highlighted }: { item: Evidence; highlighted: boolean }) {
  return (
    <div
      className={cn(
        'rounded-md border border-border p-4',
        !item.ok && 'border-dashed',
        highlighted && 'border-link',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-fg">{item.id}</span>
        <Tag>{item.tool}</Tag>
        <span className="font-mono text-[12px] text-fg-subtle">step {item.step_id}</span>
        {!item.ok && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-fg">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
            Tool call failed
          </span>
        )}
        {item.pii_redacted && (
          <span className="inline-flex items-center gap-1 text-[12px] text-fg-muted" title="Personally identifiable information was redacted">
            PII redacted
          </span>
        )}
        <time
          dateTime={item.collected_at}
          title={formatDateTime(item.collected_at)}
          className="ml-auto text-[12px] text-fg-subtle tabular-nums"
        >
          {formatTime(item.collected_at)}
        </time>
      </div>
      <p
        className={cn(
          'mt-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap',
          item.ok ? 'text-fg' : 'text-fg-muted',
        )}
      >
        {item.summary}
      </p>
      {item.artifact_uri && (
        <div className="mt-3 flex min-w-0 items-center gap-1 font-mono text-[12px] text-fg-subtle">
          <span className="shrink-0">artifact</span>
          {isHttp(item.artifact_uri) ? (
            <a
              href={item.artifact_uri}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate rounded text-link hover:underline"
            >
              {item.artifact_uri}
            </a>
          ) : (
            <span className="truncate text-fg-muted" title={item.artifact_uri}>
              {item.artifact_uri}
            </span>
          )}
          <CopyButton value={item.artifact_uri} label="Copy artifact URI" />
        </div>
      )}
    </div>
  );
}
