import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { actionStatusMeta, riskMeta } from '@/lib/meta';
import type { ProposedAction } from '@/lib/types';
import { ToneLabel } from '../ui/Badge';
import { EmptyState } from '../ui/Card';
import { JsonBlock } from '../ui/JsonBlock';
import { ApprovalProgress } from '../approvals/ApprovalProgress';

export function ActionsPanel({ actions }: { actions: ProposedAction[] }) {
  if (actions.length === 0) {
    return <EmptyState title="No actions proposed." className="px-0 text-left" />;
  }
  return (
    <ul className="space-y-3">
      {actions.map((a) => (
        <li key={a.id}>
          <ActionCard action={a} />
        </li>
      ))}
    </ul>
  );
}

function ActionCard({ action }: { action: ProposedAction }) {
  const status = actionStatusMeta[action.status] ?? { label: action.status, tone: 'neutral' as const };
  const risk = riskMeta[action.risk];
  const notes = action.guardrail_notes ?? [];
  const blocked = action.status === 'blocked';
  const required = action.required_approvals ?? 1;
  const approvals = action.approvals ?? [];
  const showProgress = approvals.length > 0 || (required > 1 && action.status === 'pending_approval');
  // The final decision is already listed among individual approvals unless
  // it came from elsewhere (policy auto-approval, timeout expiry).
  const finalDecision =
    action.approval && !approvals.some((a) => a.by === action.approval?.by && a.decision === action.approval?.decision)
      ? action.approval
      : null;

  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-mono text-[13px] font-semibold text-fg">{action.kind}</span>
        <ToneLabel tone={risk.tone}>{risk.label}</ToneLabel>
        {required > 1 && (
          <span className="text-[13px] text-fg-muted">Two-person</span>
        )}
        <ToneLabel tone={status.tone}>{status.label}</ToneLabel>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-fg-subtle">
          {action.iteration != null && <span>Iteration {action.iteration}</span>}
          <span className="font-mono">{action.id}</span>
        </span>
      </div>

      {action.rationale && <p className="mt-2.5 text-[14px] leading-relaxed text-fg-muted">{action.rationale}</p>}

      {notes.length > 0 && (
        blocked ? (
          <div className="mt-3 rounded-md border border-border px-3 py-2.5">
            <p className="flex items-center gap-2 text-[13px] font-medium text-fg"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />Blocked by guardrails</p>
            <GuardrailNotes notes={notes} />
          </div>
        ) : (
          <details className="mt-3">
            <summary className="inline-flex cursor-pointer items-center text-[13px] text-fg-muted select-none hover:text-fg max-md:min-h-11">
              Guardrail checks · {notes.length}
            </summary>
            <GuardrailNotes notes={notes} />
          </details>
        )
      )}

      {Object.keys(action.args ?? {}).length > 0 && (
        <details className="mt-3">
          <summary className="inline-flex cursor-pointer items-center text-[13px] text-fg-muted select-none hover:text-fg max-md:min-h-11">Arguments</summary>
          <JsonBlock value={action.args} className="mt-2" />
        </details>
      )}

      {(showProgress || finalDecision || action.result) && (
        <dl className="mt-4 space-y-2.5 border-t border-border pt-3 text-[13px]">
          {showProgress && (
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
              <dt className="w-24 shrink-0 text-fg-muted">Approvals</dt>
              <dd className="min-w-0 flex-1">
                <ApprovalProgress required={required} approvals={approvals} />
              </dd>
            </div>
          )}
          {finalDecision && (
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
              <dt className="w-24 shrink-0 text-fg-muted">Decision</dt>
              <dd className="min-w-0 text-fg-muted">
                <span
                  className={cn(
                    'font-medium',
                    finalDecision.decision === 'approved' ? 'text-fg' : 'text-danger-fg',
                  )}
                >
                  {finalDecision.decision.charAt(0).toUpperCase() + finalDecision.decision.slice(1)}
                </span>{' '}
                by <span className="font-mono">{finalDecision.by}</span>
                {finalDecision.at && (
                  <>
                    {' · '}
                    <time dateTime={finalDecision.at}>{formatDateTime(finalDecision.at)}</time>
                  </>
                )}
                {finalDecision.comment && (
                  <p className="mt-1 border-l-2 border-border-strong pl-2 text-fg-muted italic">{finalDecision.comment}</p>
                )}
              </dd>
            </div>
          )}
          {action.result && (
            <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
              <dt className="w-24 shrink-0 text-fg-muted">Result</dt>
              <dd className="min-w-0 flex-1">
                <JsonBlock value={action.result} className="max-h-48" />
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

function GuardrailNotes({ notes }: { notes: string[] }) {
  return (
    <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-fg-muted">
      {notes.map((n, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="text-fg-subtle">
            –
          </span>
          <span className="min-w-0 break-words">{n}</span>
        </li>
      ))}
    </ul>
  );
}
