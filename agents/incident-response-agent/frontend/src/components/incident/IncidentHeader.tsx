'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { logsHref } from '@/lib/route';
import { formatDateTime, formatUsd, relativeTime, truncateMiddle } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { envLabel } from '@/lib/meta';
import type { Incident } from '@/lib/types';
import { SeverityBadge, StatusLabel, Tag } from '../ui/Badge';
import { CopyButton } from '../ui/CopyButton';

export function IncidentHeader({
  incident,
  costUsd,
  actions,
}: {
  incident: Incident;
  costUsd?: number;
  actions?: ReactNode;
}) {
  const now = useNow();
  const labels = Object.entries(incident.labels ?? {});

  return (
    <header>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[20px] font-semibold text-balance break-words text-fg">{incident.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <SeverityBadge severity={incident.severity} showName />
            <StatusLabel status={incident.status} />
          </div>
          {incident.description && (
            <p className="mt-3 max-w-3xl text-[14px] leading-relaxed whitespace-pre-line text-fg-muted">{incident.description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-4 sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="Service">
          <span className="font-mono text-[12px]">{incident.service ?? '—'}</span>
        </Fact>
        <Fact label="Environment">{envLabel[incident.environment] ?? incident.environment}</Fact>
        <Fact label="Source">
          <span className="font-mono text-[12px]">{incident.source}</span>
        </Fact>
        <Fact label="Started">
          <time dateTime={incident.started_at} title={formatDateTime(incident.started_at)}>
            {relativeTime(incident.started_at, now) || formatDateTime(incident.started_at)}
          </time>
        </Fact>
        <Fact label="Received">
          <time dateTime={incident.received_at} title={formatDateTime(incident.received_at)} className="tabular-nums">
            {formatDateTime(incident.received_at)}
          </time>
        </Fact>
        <Fact label="Incident id">
          <span className="inline-flex max-w-full items-center gap-0.5">
            <span className="truncate font-mono text-[12px]" title={incident.id}>
              {truncateMiddle(incident.id, 8, 4)}
            </span>
            <CopyButton value={incident.id} label="Copy incident id" />
          </span>
        </Fact>
        <Fact label="Signature">
          <span className="inline-flex max-w-full items-center gap-0.5">
            <span className="truncate font-mono text-[12px]" title={incident.signature || incident.signature_hash}>
              {truncateMiddle(incident.signature_hash, 8, 4)}
            </span>
            <CopyButton value={incident.signature_hash} label="Copy signature hash" />
          </span>
        </Fact>
        {costUsd !== undefined && (
          <Fact label="LLM cost">
            <span className="tabular-nums" title={`$${costUsd.toFixed(4)}`}>
              {formatUsd(costUsd)}
            </span>
          </Fact>
        )}
        {incident.external_id && (
          <Fact label="External id">
            <span className="truncate font-mono text-[12px]" title={incident.external_id}>
              {incident.external_id}
            </span>
          </Fact>
        )}
      </dl>

      {labels.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Labels">
          {labels.map(([k, v]) => (
            <li key={k}>
              {k === 'dataset' ? (
                <Link
                  href={logsHref(v)}
                  title={`Browse the ${v} logs`}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-border-strong px-1.5 font-mono text-[12px] text-fg transition-colors hover:bg-hover max-md:h-11"
                >
                  <span className="text-fg-subtle">{k}</span>
                  <span className="text-fg-subtle" aria-hidden>=</span>
                  <span className="underline decoration-border-strong underline-offset-2">{v}</span>
                </Link>
              ) : (
                <Tag>
                  <span className="text-fg-subtle">{k}</span>
                  <span className="text-fg-subtle" aria-hidden>=</span>
                  <span className="text-fg">{v}</span>
                </Tag>
              )}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="mt-0.5 flex min-h-7 min-w-0 items-center truncate text-[13px] text-fg">{children}</dd>
    </div>
  );
}
