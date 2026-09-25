'use client';

import { Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useMe, useNow } from '@/lib/hooks';
import { isOwnApproval } from '@/lib/roles';
import type { Approval } from '@/lib/types';

/**
 * Progress of a (possibly two-person) approval: "1 of 2 approvals", then who
 * approved and when. Renders nothing for single-approver actions nobody has
 * decided yet.
 */
export function ApprovalProgress({
  required,
  approvals,
  className,
}: {
  required: number;
  approvals: Approval[];
  className?: string;
}) {
  const now = useNow();
  const { data: me } = useMe();
  const needed = Math.max(1, required || 1);
  const approved = approvals.filter((a) => a.decision === 'approved').length;
  if (needed <= 1 && approvals.length === 0) return null;

  return (
    <div className={cn('space-y-2', className)}>
      {needed > 1 && (
        <div className="flex items-center gap-3">
          <p className="text-[13px] text-fg-muted">
            <span className="font-medium text-fg tabular-nums">
              {Math.min(approved, needed)} of {needed}
            </span>{' '}
            approvals
            <span className="text-fg-subtle"> · two-person rule</span>
          </p>
          <div
            className="flex flex-1 gap-1"
            role="progressbar"
            aria-label="Approvals"
            aria-valuemin={0}
            aria-valuemax={needed}
            aria-valuenow={Math.min(approved, needed)}
          >
            {Array.from({ length: needed }, (_, i) => (
              <span
                key={i}
                className={cn('h-1.5 max-w-10 flex-1', i < approved ? 'bg-fg' : 'bg-hover')}
              />
            ))}
          </div>
        </div>
      )}
      {approvals.length > 0 && (
        <ul className="space-y-1.5 text-[13px] text-fg-muted">
          {approvals.map((a, i) => (
            <li key={`${a.by}-${a.at}-${i}`} className="flex gap-2">
              {a.decision === 'approved' ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.5} aria-hidden />
              ) : (
                <X className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" strokeWidth={1.5} aria-hidden />
              )}
              <div className="min-w-0">
                <span>
                  {a.decision === 'approved' ? 'Approved' : a.decision === 'rejected' ? 'Rejected' : 'Expired'} by{' '}
                  <span className="font-mono text-fg">{a.by}</span>
                  {isOwnApproval(a, me) && <span className="text-fg-subtle"> (you)</span>}
                  {a.at && (
                    <>
                      <span className="text-fg-subtle"> · </span>
                      <time dateTime={a.at} title={formatDateTime(a.at)} className="text-fg-subtle">
                        {relativeTime(a.at, now) || formatDateTime(a.at)}
                      </time>
                    </>
                  )}
                </span>
                {a.comment && <p className="mt-0.5 border-l-2 border-border-strong pl-2 break-words italic">{a.comment}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
