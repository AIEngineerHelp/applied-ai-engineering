'use client';

import Link from 'next/link';
import { formatDateTime, relativeTime, shortId } from '@/lib/format';
import { useNow, usePendingApprovals } from '@/lib/hooks';
import { riskMeta } from '@/lib/meta';
import { incidentHref } from '@/lib/route';
import type { PendingApproval } from '@/lib/types';
import { SeverityBadge, ToneLabel } from '../ui/Badge';
import { EmptyState } from '../ui/Card';
import { ErrorNotice } from '../ui/ErrorNotice';
import { JsonBlock } from '../ui/JsonBlock';
import { Skeleton } from '../ui/Skeleton';
import { ApprovalProgress } from './ApprovalProgress';
import { DecisionControls } from './DecisionControls';

export function ApprovalsView() {
  const { data, error, isLoading, mutate } = usePendingApprovals();
  const twoPerson = data?.filter((a) => (a.required_approvals ?? 1) > 1).length ?? 0;
  const destructive = data?.filter((a) => a.risk === 'destructive').length ?? 0;

  return (
    <div className="max-w-4xl space-y-6">
      {data && data.length > 0 && (
        <p className="text-[13px] text-fg-muted tabular-nums">
          {data.length} pending · {twoPerson} two-person · {destructive} destructive
        </p>
      )}

      {error && <ErrorNotice error={error} onRetry={() => void mutate()} />}

      {isLoading && !data ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading approvals">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border p-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
      ) : !data ? null : data.length === 0 ? (
        <EmptyState title="No actions are waiting for approval." className="px-0 text-left" />
      ) : (
        <ul className="space-y-4">
          {[...data]
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
            .map((a) => (
              <li key={a.action_id}>
                <ApprovalItem approval={a} />
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalItem({ approval }: { approval: PendingApproval }) {
  const now = useNow();
  const risk = riskMeta[approval.risk];
  const required = approval.required_approvals ?? 1;
  const approvals = approval.approvals ?? [];

  return (
    <article className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <SeverityBadge severity={approval.severity} />
        <Link
          href={incidentHref(approval.incident_id)}
          className="min-w-0 flex-1 truncate rounded text-[13px] font-medium text-fg hover:underline max-md:min-h-11 max-md:content-center"
        >
          {approval.incident_title}
        </Link>
        <span className="flex items-center gap-3 text-[12px] text-fg-subtle">
          <span className="font-mono">{shortId(approval.incident_id)}</span>
          {approval.service && <span className="font-mono">{approval.service}</span>}
          <time dateTime={approval.created_at} title={formatDateTime(approval.created_at)} className="tabular-nums">
            {relativeTime(approval.created_at, now)}
          </time>
        </span>
      </div>

      <div className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-mono text-[13px] font-semibold text-fg">{approval.kind}</span>
          <ToneLabel tone={risk.tone}>{risk.label}</ToneLabel>
          {required > 1 && <span className="text-[13px] text-fg-muted">Two-person</span>}
        </div>
        {approval.rationale && <p className="text-[14px] leading-relaxed text-fg">{approval.rationale}</p>}

        <details>
          <summary className="inline-flex cursor-pointer items-center text-[13px] text-fg-muted select-none hover:text-fg max-md:min-h-11">
            Arguments
          </summary>
          <JsonBlock value={approval.args} className="mt-2" />
        </details>

        <ApprovalProgress required={required} approvals={approvals} />

        <div className="border-t border-border pt-3">
          <DecisionControls
            actionId={approval.action_id}
            incidentId={approval.incident_id}
            risk={approval.risk}
            kind={approval.kind}
            requiredApprovals={required}
            approvals={approvals}
          />
        </div>
      </div>
    </article>
  );
}
