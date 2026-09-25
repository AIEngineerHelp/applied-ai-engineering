'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { SEVERITIES } from './meta';
import type { Environment, IncidentStatus, Severity } from './types';

export type View = 'overview' | 'incidents' | 'logs' | 'graph' | 'evals' | 'approvals' | 'audit';

/* ---------------------------------------------------------------- incident list filters */

/** Status filter: a group or one status. "done" = reported or resolved. */
export type StatusFilter = 'all' | 'open' | 'closed' | 'done' | IncidentStatus;
export type SinceFilter = 'any' | '24h' | '7d' | '30d';
export type SortKey = 'severity' | 'title' | 'service' | 'environment' | 'status' | 'started';
export type SortDir = 'asc' | 'desc';

export interface IncidentFilters {
  q: string;
  status: StatusFilter;
  sev: Severity[];
  env: Environment | 'all';
  service: string | null;
  since: SinceFilter;
  sort: SortKey;
  dir: SortDir;
  page: number;
}

export const DEFAULT_FILTERS: IncidentFilters = {
  q: '',
  status: 'all',
  sev: [],
  env: 'all',
  service: null,
  since: 'any',
  sort: 'started',
  dir: 'desc',
  page: 1,
};

const STATUS_VALUES = new Set<string>([
  'all', 'open', 'closed', 'done',
  'new', 'cached', 'queued', 'investigating', 'awaiting_approval', 'remediating', 'reported', 'resolved', 'failed', 'rejected',
]);
const SORT_VALUES = new Set<string>(['severity', 'title', 'service', 'environment', 'status', 'started']);

function parseFilters(params: URLSearchParams): IncidentFilters {
  const status = params.get('status') ?? 'all';
  const sort = params.get('sort') ?? 'started';
  const env = params.get('env');
  const since = params.get('since');
  const page = Number(params.get('page') ?? 1);
  return {
    q: params.get('q') ?? '',
    status: (STATUS_VALUES.has(status) ? status : 'all') as StatusFilter,
    sev: (params.get('sev') ?? '')
      .split(',')
      .filter((s): s is Severity => (SEVERITIES as string[]).includes(s)),
    env: env === 'prod' || env === 'staging' || env === 'dev' ? env : 'all',
    service: params.get('service') || null,
    since: since === '24h' || since === '7d' || since === '30d' ? since : 'any',
    sort: (SORT_VALUES.has(sort) ? sort : 'started') as SortKey,
    dir: params.get('dir') === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

export function incidentsHref(filters: Partial<IncidentFilters> = {}): string {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const p = new URLSearchParams({ view: 'incidents' });
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.status !== 'all') p.set('status', f.status);
  if (f.sev.length) p.set('sev', f.sev.join(','));
  if (f.env !== 'all') p.set('env', f.env);
  if (f.service) p.set('service', f.service);
  if (f.since !== 'any') p.set('since', f.since);
  if (f.sort !== DEFAULT_FILTERS.sort || f.dir !== DEFAULT_FILTERS.dir) {
    p.set('sort', f.sort);
    p.set('dir', f.dir);
  }
  if (f.page > 1) p.set('page', String(f.page));
  return `/?${p.toString()}`;
}

/** The Incidents list URL the user last looked at, so "back" restores filters. */
let lastList: string | null = null;

export function lastIncidentsHref(): string {
  return lastList ?? incidentsHref();
}

/* ---------------------------------------------------------------- logs (datasets) */

export type LogsTab = 'logs' | 'events' | 'try';

export interface LogsFilters {
  tab: LogsTab;
  q: string;
  level: string | null;
  event: string | null;
  page: number;
}

export const DEFAULT_LOGS_FILTERS: LogsFilters = { tab: 'logs', q: '', level: null, event: null, page: 1 };

function parseLogsFilters(params: URLSearchParams): LogsFilters {
  const tab = params.get('tab');
  const page = Number(params.get('page') ?? 1);
  return {
    tab: tab === 'events' || tab === 'try' ? tab : 'logs',
    q: params.get('q') ?? '',
    level: params.get('level') || null,
    event: params.get('event') || null,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/** `/?view=logs` (index) or a dataset page with its tab and filters. */
export function logsHref(dataset?: string | null, filters: Partial<LogsFilters> = {}): string {
  const p = new URLSearchParams({ view: 'logs' });
  if (dataset) {
    const f = { ...DEFAULT_LOGS_FILTERS, ...filters };
    p.set('dataset', dataset);
    if (f.tab !== 'logs') p.set('tab', f.tab);
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.level) p.set('level', f.level);
    if (f.event) p.set('event', f.event);
    if (f.page > 1) p.set('page', String(f.page));
  }
  return `/?${p.toString()}`;
}

/* ---------------------------------------------------------------- knowledge graph */

export interface GraphState {
  dataset: string | null;
  /** Selected node key. */
  node: string | null;
  mode: 'graph' | 'table';
}

function parseGraphState(params: URLSearchParams): GraphState {
  return {
    dataset: params.get('dataset') || null,
    node: params.get('node') || null,
    mode: params.get('mode') === 'table' ? 'table' : 'graph',
  };
}

export function graphHref(state: Partial<GraphState> = {}): string {
  const p = new URLSearchParams({ view: 'graph' });
  if (state.dataset) p.set('dataset', state.dataset);
  if (state.node) p.set('node', state.node);
  if (state.mode === 'table') p.set('mode', 'table');
  return `/?${p.toString()}`;
}

/* ---------------------------------------------------------------- evals */

export type EvalsTab = 'results' | 'run' | 'method';
export type CaseFilter = 'all' | 'misses' | 'hits';

export interface EvalsState {
  tab: EvalsTab;
  run: string | null;
  cases: CaseFilter;
  /** "Details for engineers" disclosure open on the Results tab. */
  details: boolean;
}

function parseEvalsState(params: URLSearchParams): EvalsState {
  const run = params.get('run') || null;
  const tab = params.get('tab');
  const cases = params.get('cases');
  return {
    run,
    // A deep link to a run opens its detail unless another tab is named.
    tab: tab === 'method' ? 'method' : tab === 'results' ? 'results' : run ? 'run' : 'results',
    cases: cases === 'misses' || cases === 'hits' ? cases : 'all',
    details: params.get('details') === '1',
  };
}

export function evalsHref(state: Partial<EvalsState> = {}): string {
  const p = new URLSearchParams({ view: 'evals' });
  if (state.run) p.set('run', state.run);
  const tab = state.tab ?? (state.run ? 'run' : 'results');
  if (tab !== (state.run ? 'run' : 'results')) p.set('tab', tab);
  if (state.cases && state.cases !== 'all') p.set('cases', state.cases);
  if (state.details && !state.run) p.set('details', '1');
  return `/?${p.toString()}`;
}

/* ---------------------------------------------------------------- hrefs */

export const overviewHref = '/';
export const approvalsHref = '/?view=approvals';

export function incidentHref(id: string, tab?: string): string {
  const p = new URLSearchParams({ incident: id });
  if (tab) p.set('tab', tab);
  return `/?${p.toString()}`;
}

export function auditHref(incidentId?: string | null): string {
  const p = new URLSearchParams({ view: 'audit' });
  if (incidentId) p.set('incident', incidentId);
  return `/?${p.toString()}`;
}

function parseView(value: string | null): View {
  return value === 'incidents' || value === 'logs' || value === 'graph' || value === 'evals' || value === 'approvals' || value === 'audit'
    ? value
    : 'overview';
}

/**
 * URL-backed app state. Uses the native History API, which Next.js
 * integrates with useSearchParams, so every view, filter and selection is a
 * shareable deep link and back/forward work without a server round-trip.
 *
 * `?incident=<id>` opens the incident detail (except in the audit view, where
 * it filters the log to that incident).
 */
export function useAppRoute() {
  const params = useSearchParams();
  const view = parseView(params.get('view'));
  const incidentParam = params.get('incident');
  /** The incident whose detail page is open, if any. */
  const incidentId = view === 'audit' ? null : incidentParam;
  const auditIncidentId = view === 'audit' ? incidentParam : null;
  const tab = params.get('tab');
  const paramString = params.toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(paramString)), [paramString]);
  const dataset = view === 'logs' ? params.get('dataset') : null;
  const logsFilters = useMemo(() => parseLogsFilters(new URLSearchParams(paramString)), [paramString]);
  const evals = useMemo(() => parseEvalsState(new URLSearchParams(paramString)), [paramString]);
  const graph = useMemo(() => parseGraphState(new URLSearchParams(paramString)), [paramString]);
  const isList = view === 'incidents' && !incidentId;
  useEffect(() => {
    if (isList) lastList = `/?${paramString}`;
  }, [isList, paramString]);

  const navigate = useCallback((href: string) => {
    window.history.pushState(null, '', href);
  }, []);

  const openIncident = useCallback((id: string) => {
    window.history.pushState(null, '', incidentHref(id));
  }, []);

  const setAuditFilter = useCallback((filterIncidentId: string | null) => {
    window.history.replaceState(null, '', auditHref(filterIncidentId));
  }, []);

  /** Updates list filters in place (no new history entry); resets paging unless a page is given. */
  const setFilters = useCallback(
    (patch: Partial<IncidentFilters>) => {
      const next = { ...filters, page: 1, ...patch };
      window.history.replaceState(null, '', incidentsHref(next));
    },
    [filters],
  );

  /** Updates the dataset page's tab/filters in place; resets paging unless a page is given. */
  const setLogsFilters = useCallback(
    (patch: Partial<LogsFilters>) => {
      if (!dataset) return;
      window.history.replaceState(null, '', logsHref(dataset, { ...logsFilters, page: 1, ...patch }));
    },
    [dataset, logsFilters],
  );

  const setGraph = useCallback(
    (patch: Partial<GraphState>, push = false) => {
      const href = graphHref({ ...graph, ...patch });
      if (push) window.history.pushState(null, '', href);
      else window.history.replaceState(null, '', href);
    },
    [graph],
  );

  const setEvals = useCallback(
    (patch: Partial<EvalsState>, push = false) => {
      const href = evalsHref({ ...evals, ...patch });
      if (push) window.history.pushState(null, '', href);
      else window.history.replaceState(null, '', href);
    },
    [evals],
  );

  const setTab = useCallback(
    (next: string) => {
      if (!incidentId) return;
      window.history.replaceState(null, '', incidentHref(incidentId, next));
    },
    [incidentId],
  );

  return {
    view,
    incidentId,
    auditIncidentId,
    tab,
    filters,
    dataset,
    logsFilters,
    evals,
    setEvals,
    graph,
    setGraph,
    navigate,
    openIncident,
    setAuditFilter,
    setFilters,
    setLogsFilters,
    setTab,
  };
}
