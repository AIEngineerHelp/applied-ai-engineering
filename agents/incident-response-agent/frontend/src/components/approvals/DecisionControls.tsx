'use client';

import { useId, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { useSWRConfig } from 'swr';
import { ApiError, decideApproval, errorMessage, isForbidden, keys } from '@/lib/api';
import { useMe, useRole } from '@/lib/hooks';
import { highestRole, isOwnApproval, roleLabel } from '@/lib/roles';
import type { Approval, Decision, Risk } from '@/lib/types';
import { Button, type ButtonProps } from '../ui/Button';
import { PermissionNotice } from '../ui/ErrorNotice';
import { useToast } from '../ui/Toast';

const SECOND_APPROVER_HINT = 'You already approved this action. Two-person approval needs a different approver.';

export function DecisionControls({
  actionId,
  incidentId,
  risk,
  kind,
  requiredApprovals,
  approvals,
}: {
  actionId: string;
  incidentId: string;
  risk: Risk;
  kind: string;
  requiredApprovals: number;
  approvals: Approval[];
}) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<Decision | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const { data: me } = useMe();
  const { allowed: canDecide, ready } = useRole('approver');
  const { mutate } = useSWRConfig();
  const { toast } = useToast();
  const commentId = useId();
  const hintId = useId();

  const needed = Math.max(1, requiredApprovals || 1);
  const approvedCount = approvals.filter((a) => a.decision === 'approved').length;
  const alreadyApproved = approvals.some((a) => a.decision === 'approved' && isOwnApproval(a, me));

  async function revalidate() {
    await Promise.all([mutate(keys.incident(incidentId)), mutate(keys.pendingApprovals), mutate(keys.incidentList)]);
  }

  async function decide(decision: Decision) {
    if (decision === 'approved' && risk === 'destructive' && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(decision);
    setForbidden(null);
    try {
      const res = await decideApproval(actionId, { decision, comment: comment.trim() || undefined });
      if (res.status === 'recorded') {
        toast({
          kind: 'info',
          title: 'Approval recorded',
          description: `${kind}: ${Math.min(approvedCount + 1, needed)} of ${needed} approvals. Waiting for a second approver.`,
        });
      } else {
        toast({
          kind: 'success',
          title: decision === 'approved' ? 'Action approved' : 'Action rejected',
          description: kind,
        });
      }
      setComment('');
      await revalidate();
    } catch (err) {
      if (isForbidden(err)) {
        const detail = err.detail ?? '';
        setForbidden(/already|different|two.person|second/i.test(detail) ? SECOND_APPROVER_HINT : err.message);
        // Roles may have changed at the IdP since /v1/me was loaded.
        await Promise.all([revalidate(), mutate(keys.me)]);
      } else if (err instanceof ApiError && err.status === 409) {
        toast({ kind: 'error', title: 'Already decided', description: err.message });
        await revalidate();
      } else {
        toast({ kind: 'error', title: 'Decision failed', description: errorMessage(err) });
      }
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  if (ready && !canDecide) {
    const role = highestRole(me);
    const hint = `Approving or rejecting needs the Approver role. You are signed in as ${role ? roleLabel[role] : 'a user with no role'}.`;
    return (
      <div className="space-y-2">
        <div className="flex justify-end gap-2">
          <GatedButton variant="danger" reason={hint} describedBy={hintId}>
            <X className="h-4 w-4" />
            Reject
          </GatedButton>
          <GatedButton variant="primary" reason={hint} describedBy={hintId}>
            <Check className="h-4 w-4" />
            Approve
          </GatedButton>
        </div>
        <p id={hintId} className="text-right text-[12px] text-fg-muted">
          {hint}
        </p>
      </div>
    );
  }

  const locked = busy !== null || !ready;

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <label htmlFor={commentId} className="sr-only">
          Decision comment (optional)
        </label>
        <textarea
          id={commentId}
          rows={1}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a comment (optional)"
          disabled={locked}
          className="min-h-8 flex-1 resize-y rounded-md border border-border-strong bg-bg px-2.5 py-1 text-[13px] text-fg placeholder:text-fg-subtle focus-visible:border-link focus-visible:outline-0 focus-visible:ring-1 focus-visible:ring-link max-md:min-h-11 max-md:text-[16px]"
        />
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button variant="danger" onClick={() => decide('rejected')} disabled={locked}>
            <X className="h-4 w-4" />
            {busy === 'rejected' ? 'Rejecting…' : 'Reject'}
          </Button>
          {alreadyApproved ? (
            <GatedButton variant="primary" reason={SECOND_APPROVER_HINT} describedBy={hintId}>
              <Check className="h-4 w-4" />
              Waiting for a second approver
            </GatedButton>
          ) : (
            <Button
              variant={confirming ? 'danger' : 'primary'}
              className={confirming ? 'border-danger' : undefined}
              onClick={() => decide('approved')}
              disabled={locked}
              aria-live="polite"
            >
              <Check className="h-4 w-4" />
              {busy === 'approved' ? 'Approving…' : confirming ? 'Confirm destructive action' : 'Approve'}
            </Button>
          )}
        </div>
      </div>
      {alreadyApproved && (
        <p id={hintId} className="text-[12px] text-fg-muted sm:text-right">
          {SECOND_APPROVER_HINT}
        </p>
      )}
      {forbidden && <PermissionNotice message={forbidden} />}
    </div>
  );
}

/**
 * A button that looks disabled but stays focusable, so keyboard and screen
 * reader users can still discover why (via title and aria-describedby).
 */
function GatedButton({
  reason,
  describedBy,
  children,
  ...props
}: Omit<ButtonProps, 'onClick' | 'disabled'> & { reason: string; describedBy: string; children: ReactNode }) {
  return (
    <Button
      {...props}
      aria-disabled="true"
      aria-describedby={describedBy}
      title={reason}
      onClick={(e) => e.preventDefault()}
      // Cancel the variant's hover color so it doesn't read as clickable.
      className="cursor-not-allowed opacity-50 hover:opacity-50"
    >
      {children}
    </Button>
  );
}
