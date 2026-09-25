'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useIncidentDetail, useRole } from '@/lib/hooks';
import { auditHref, graphHref, lastIncidentsHref } from '@/lib/route';
import { EmptyState } from '../ui/Card';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Tabs, type TabItem } from '../ui/Tabs';
import { IncidentHeader } from './IncidentHeader';
import { CacheBanner, RunTimeline, VerificationCard } from './RunTimeline';
import { PendingApprovalCard } from './PendingApprovalCard';
import { RootCause } from './RootCause';
import { ActivityFeed } from './ActivityFeed';
import { PlanPanel } from './PlanPanel';
import { EvidencePanel } from './EvidencePanel';
import { ActionsPanel } from './ActionsPanel';
import { ReportPanel } from './ReportPanel';
import { DetailSkeleton } from './DetailSkeleton';

type TabId = 'plan' | 'evidence' | 'actions' | 'report';
const TAB_IDS: TabId[] = ['plan', 'evidence', 'actions', 'report'];

function isTab(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as string[]).includes(value);
}

function BackLink({ navigate }: { navigate: (href: string) => void }) {
  // Back to the list as the user left it (filters, sort, page).
  const href = lastIncidentsHref();
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(href);
      }}
      className="inline-flex items-center gap-1.5 rounded text-[13px] text-fg-muted transition-colors hover:text-fg max-md:min-h-11 sm:hidden"
    >
      <ArrowLeft aria-hidden className="h-4 w-4" strokeWidth={1.5} />
      Incidents
    </a>
  );
}

export function IncidentView({
  id,
  tab,
  onTabChange,
  navigate,
}: {
  id: string;
  tab: string | null;
  onTabChange: (tab: string) => void;
  navigate: (href: string) => void;
}) {
  const { data, error, isLoading, mutate } = useIncidentDetail(id);
  const [highlight, setHighlight] = useState<{ id: string; n: number } | null>(null);
  const { allowed: isAdmin } = useRole('admin');

  if (error && !data) {
    if (error.status === 404) {
      return (
        <div className="space-y-4">
          <BackLink navigate={navigate} />
          <EmptyState title={`No incident with id ${id}.`} className="text-left" />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <BackLink navigate={navigate} />
        <ErrorNotice error={error} prefix="Could not load incident" onRetry={() => void mutate()} />
      </div>
    );
  }

  if (!data || (isLoading && !data)) return <DetailSkeleton />;

  const pending = data.actions.filter((a) => a.status === 'pending_approval');
  const active = data.run.status === 'running' || data.run.status === 'queued';
  const awaiting = data.run.status === 'awaiting_approval';
  const activity = data.run.activity ?? [];
  const current: TabId = isTab(tab) ? tab : data.report ? 'report' : 'plan';

  const tabs: TabItem<TabId>[] = [
    { id: 'plan', label: 'Plan', count: data.plan.length },
    { id: 'evidence', label: 'Evidence', count: data.evidence.length },
    { id: 'actions', label: 'Actions', count: data.actions.length },
    { id: 'report', label: 'Report' },
  ];

  function showEvidence(evidenceId: string) {
    onTabChange('evidence');
    setHighlight((h) => ({ id: evidenceId, n: (h?.n ?? 0) + 1 }));
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
      <BackLink navigate={navigate} />
      <IncidentHeader
        incident={data.incident}
        costUsd={data.run.budget_used_usd}
        actions={
          <>
            <Link
              href={graphHref({ node: `global:Incident:${data.incident.id}` })}
              className="inline-flex h-8 items-center rounded-md px-2 text-[13px] text-fg-muted transition-colors hover:bg-hover hover:text-fg max-md:h-11"
            >
              View in knowledge graph
            </Link>
            {isAdmin && (
              <Link
                href={auditHref(data.incident.id)}
                className="inline-flex h-8 items-center rounded-md border border-border-strong px-3 text-[13px] font-medium text-fg transition-colors hover:bg-hover max-md:h-11"
              >
                Audit log
              </Link>
            )}
          </>
        }
      />
      </div>

      {error && <ErrorNotice error={error} prefix="Live updates paused" onRetry={() => void mutate()} />}

      {pending.length > 0 && (
        <section aria-label="Pending approvals" className="space-y-3">
          {pending.map((action) => (
            <PendingApprovalCard key={action.id} action={action} incidentId={data.incident.id} />
          ))}
        </section>
      )}

      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-8">
          {/* Live narration outside the root-cause box once a hypothesis exists (or while paused for approval). */}
          {((active && data.hypotheses.length > 0) || awaiting) && (
            <section aria-label="Agent activity">
              <ActivityFeed entries={activity} live={active} />
            </section>
          )}
          <RootCause
            hypotheses={data.hypotheses}
            evidence={data.evidence}
            active={active}
            live={<ActivityFeed entries={activity} live />}
            onEvidenceClick={showEvidence}
          />

          <section aria-label="Investigation details">
            <Tabs tabs={tabs} value={current} onChange={onTabChange} idPrefix="detail" label="Investigation details" />
            <div
              role="tabpanel"
              id={`detail-panel-${current}`}
              aria-labelledby={`detail-tab-${current}`}
              tabIndex={0}
              className="pt-4 focus-visible:outline-offset-2"
            >
              {current === 'plan' && <PlanPanel plan={data.plan} active={active} />}
              {current === 'evidence' && <EvidencePanel evidence={data.evidence} active={active} highlight={highlight} />}
              {current === 'actions' && <ActionsPanel actions={data.actions} />}
              {current === 'report' && <ReportPanel report={data.report} active={active} />}
            </div>
          </section>
        </div>

        <aside aria-label="Run" className="min-w-0 space-y-6">
          <RunTimeline run={data.run} />
          {data.run.cache && <CacheBanner cache={data.run.cache} />}
          {data.verification && <VerificationCard verification={data.verification} />}
        </aside>
      </div>
    </div>
  );
}
