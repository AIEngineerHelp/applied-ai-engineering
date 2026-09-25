import { riskMeta } from '@/lib/meta';
import type { ProposedAction } from '@/lib/types';
import { ApprovalProgress } from '../approvals/ApprovalProgress';
import { DecisionControls } from '../approvals/DecisionControls';
import { Dot, ToneLabel } from '../ui/Badge';
import { JsonBlock } from '../ui/JsonBlock';

/** Shown at the top of the incident while the agent waits for a human decision. */
export function PendingApprovalCard({ action, incidentId }: { action: ProposedAction; incidentId: string }) {
  const risk = riskMeta[action.risk];
  const required = action.required_approvals ?? 1;
  const approvals = action.approvals ?? [];
  return (
    <div className="rounded-lg border border-border-strong">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <Dot tone="warning" />
        <span className="text-[13px] font-medium text-fg">{required > 1 ? 'Two approvals required' : 'Approval required'}</span>
        <span className="text-[13px] text-fg-muted">The agent is paused.</span>
      </div>
      <div className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-mono text-[13px] font-semibold text-fg">{action.kind}</span>
          <ToneLabel tone={risk.tone}>{risk.label}</ToneLabel>
          {required > 1 && <span className="text-[13px] text-fg-muted">Two-person</span>}
        </div>
        {action.rationale && <p className="text-[14px] leading-relaxed text-fg">{action.rationale}</p>}
        <JsonBlock value={action.args} />
        {action.guardrail_notes?.length > 0 && (
          <ul className="space-y-1 text-[13px] text-fg-muted">
            {action.guardrail_notes.map((note, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="text-fg-subtle">–</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}
        <ApprovalProgress required={required} approvals={approvals} className="border-t border-border pt-3" />
        <div className="border-t border-border pt-3">
          <DecisionControls
            actionId={action.id}
            incidentId={incidentId}
            risk={action.risk}
            kind={action.kind}
            requiredApprovals={required}
            approvals={approvals}
          />
        </div>
      </div>
    </div>
  );
}
