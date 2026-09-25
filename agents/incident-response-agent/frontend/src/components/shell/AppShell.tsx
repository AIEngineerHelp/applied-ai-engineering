'use client';

import { useEffect, useRef, useState } from 'react';
import { usePendingApprovals, useRole } from '@/lib/hooks';
import { evalsHref, graphHref, lastIncidentsHref, logsHref, useAppRoute } from '@/lib/route';
import { shortId } from '@/lib/format';
import { Dialog } from '../ui/Dialog';
import { Skeleton } from '../ui/Skeleton';
import { SideNav } from './SideNav';
import { TopBar, type Crumb } from './TopBar';
import { NewIncidentDialog } from './NewIncidentDialog';
import { OverviewView } from '../overview/OverviewView';
import { IncidentsView } from '../incidents/IncidentsView';
import { IncidentView } from '../incident/IncidentView';
import { ApprovalsView } from '../approvals/ApprovalsView';
import { AuditView } from '../audit/AuditView';
import { LogsIndex } from '../logs/LogsIndex';
import { EvalsView } from '../evals/EvalsView';
import { GraphView } from '../graph/GraphView';
import { DatasetView } from '../logs/DatasetView';

export function AppShell() {
  const route = useAppRoute();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const { data: pending } = usePendingApprovals();
  const pendingCount = pending?.length ?? 0;
  const { allowed: canCreate } = useRole('responder');
  const { allowed: isAdmin } = useRole('admin');
  const mainRef = useRef<HTMLElement>(null);

  // The incident detail belongs to the Incidents section.
  const section = route.incidentId ? 'incidents' : route.view;
  const pageKey = `${route.view}:${route.incidentId ?? ''}:${route.dataset ?? ''}`;

  // New page → start at the top (filters/tabs use replaceState and keep scroll).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pageKey]);

  let crumbs: Crumb[];
  let main;
  if (route.incidentId) {
    crumbs = [{ label: 'Incidents', href: lastIncidentsHref() }, { label: shortId(route.incidentId) }];
    main = <IncidentView key={route.incidentId} id={route.incidentId} tab={route.tab} onTabChange={route.setTab} navigate={route.navigate} />;
  } else if (route.view === 'incidents') {
    crumbs = [{ label: 'Incidents' }];
    main = <IncidentsView filters={route.filters} setFilters={route.setFilters} openIncident={route.openIncident} />;
  } else if (route.view === 'logs' && route.dataset) {
    crumbs = [{ label: 'Logs', href: logsHref() }, { label: route.dataset }];
    main = (
      <DatasetView
        key={route.dataset}
        name={route.dataset}
        filters={route.logsFilters}
        setFilters={route.setLogsFilters}
        navigate={route.navigate}
      />
    );
  } else if (route.view === 'logs') {
    crumbs = [{ label: 'Logs' }];
    main = <LogsIndex navigate={route.navigate} />;
  } else if (route.view === 'graph') {
    crumbs = [{ label: 'Knowledge graph', href: graphHref() }, ...(route.graph.dataset ? [{ label: route.graph.dataset }] : [])];
    if (crumbs.length === 1) crumbs = [{ label: 'Knowledge graph' }];
    main = <GraphView state={route.graph} setState={route.setGraph} />;
  } else if (route.view === 'evals') {
    crumbs = route.evals.run ? [{ label: 'Evals', href: evalsHref() }, { label: route.evals.run }] : [{ label: 'Evals' }];
    main = <EvalsView state={route.evals} setState={route.setEvals} />;
  } else if (route.view === 'approvals') {
    crumbs = [{ label: 'Approvals' }];
    main = <ApprovalsView />;
  } else if (route.view === 'audit') {
    crumbs = [{ label: 'Audit log' }];
    main = (
      <AuditView
        key={route.auditIncidentId ?? 'all'}
        incidentId={route.auditIncidentId}
        onFilterChange={route.setAuditFilter}
      />
    );
  } else {
    crumbs = [{ label: 'Overview' }];
    main = <OverviewView navigate={route.navigate} />;
  }

  return (
    <div className="flex h-full">
      <aside className="relative z-20 hidden w-14 shrink-0 border-r border-border md:block xl:w-[220px]">
        <SideNav active={section} pendingCount={pendingCount} isAdmin={isAdmin} variant="rail" />
      </aside>

      <Dialog
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Navigation"
        variant="drawer"
        hideHeader
        className="md:hidden"
      >
        <SideNav
          active={section}
          pendingCount={pendingCount}
          isAdmin={isAdmin}
          variant="drawer"
          onNavigate={() => setDrawerOpen(false)}
        />
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          crumbs={crumbs}
          navigate={route.navigate}
          onOpenNav={() => setDrawerOpen(true)}
          onNewIncident={canCreate ? () => setCreating(true) : undefined}
        />
        <main ref={mainRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6 xl:px-8 xl:py-8">{main}</div>
        </main>
      </div>

      <NewIncidentDialog
        open={creating && canCreate}
        onClose={() => setCreating(false)}
        onCreated={(incident) => {
          setCreating(false);
          route.openIncident(incident.id);
        }}
      />
    </div>
  );
}

export function AppShellFallback() {
  return (
    <div className="flex h-full" aria-busy="true">
      <aside className="hidden w-14 shrink-0 border-r border-border bg-subtle md:block xl:w-[220px]" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center border-b border-border px-6">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="mx-auto w-full max-w-[1280px] px-4 py-8 md:px-8">
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
