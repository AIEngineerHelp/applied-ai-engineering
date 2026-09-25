'use client';

import { useSyncExternalStore } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';
import { ApiError, fetcher, keys } from './api';
import { hasRole } from './roles';
import type {
  AuditEvent,
  DatasetIndex,
  DatasetLogs,
  DatasetTemplate,
  EvalIndex,
  GraphNeighbourhood,
  GraphNode,
  GraphOverview,
  GraphSlice,
  EvalRunDetail,
  Incident,
  IncidentDetail,
  Me,
  PendingApproval,
  Role,
} from './types';

/* ---------------------------------------------------------------- identity */

/** Don't hammer the API with retries for errors a retry can't fix. */
function shouldRetry(error: Error): boolean {
  return !(error instanceof ApiError && [401, 403, 404].includes(error.status));
}

export function useMe() {
  return useSWR<Me, ApiError>(keys.me, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 5 * 60_000,
    shouldRetryOnError: shouldRetry,
  });
}

/**
 * Role check for the current user. `ready` is false until /v1/me has loaded,
 * so callers can avoid flashing controls the user may not be allowed to use.
 */
export function useRole(required: Role): { allowed: boolean; ready: boolean } {
  const { data } = useMe();
  return { allowed: hasRole(data, required), ready: data !== undefined };
}

/* ---------------------------------------------------------------- data */

export function useIncidents() {
  return useSWR<Incident[], ApiError>(keys.incidentList, fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
    shouldRetryOnError: shouldRetry,
  });
}

export function usePendingApprovals() {
  return useSWR<PendingApproval[], ApiError>(keys.pendingApprovals, fetcher, {
    refreshInterval: 5000,
    shouldRetryOnError: shouldRetry,
  });
}

export function useAudit(incidentId: string | null, limit: number, enabled: boolean) {
  return useSWR<AuditEvent[], ApiError>(enabled ? keys.audit(incidentId, limit) : null, fetcher, {
    refreshInterval: 15000,
    keepPreviousData: true,
    shouldRetryOnError: shouldRetry,
  });
}

/* ---------------------------------------------------------------- datasets (static sample data) */

const staticData = { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: shouldRetry } as const;

export function useDatasets() {
  return useSWR<DatasetIndex, ApiError>(keys.datasets, fetcher, staticData);
}

export function useDatasetLogs(
  name: string | null,
  f: { q: string; level: string | null; eventId: string | null; offset: number; limit: number },
) {
  return useSWR<DatasetLogs, ApiError>(name ? keys.datasetLogs(name, f) : null, fetcher, { ...staticData, keepPreviousData: true });
}

export function useDatasetTemplates(name: string | null) {
  return useSWR<DatasetTemplate[], ApiError>(name ? keys.datasetTemplates(name) : null, fetcher, staticData);
}

/* ---------------------------------------------------------------- knowledge graph */

/** 503 = graph switched off: a config state, not a transient error, so don't retry. */
function graphRetry(error: Error): boolean {
  return shouldRetry(error) && !(error instanceof ApiError && error.status === 503);
}

const graphConfig = { revalidateOnFocus: false, shouldRetryOnError: graphRetry, keepPreviousData: true } as const;

export function useGraphOverview() {
  return useSWR<GraphOverview, ApiError>(keys.graphOverview, fetcher, graphConfig);
}

export function useGraphSlice(dataset: string | null) {
  return useSWR<GraphSlice, ApiError>(dataset ? keys.graph(dataset) : null, fetcher, graphConfig);
}

export function useGraphNeighbourhood(key: string | null) {
  return useSWR<GraphNeighbourhood, ApiError>(key ? keys.graphNode(key) : null, fetcher, { ...graphConfig, keepPreviousData: false });
}

export function useGraphSearch(q: string) {
  const term = q.trim();
  return useSWR<GraphNode[], ApiError>(term.length >= 2 ? keys.graphSearch(term) : null, fetcher, graphConfig);
}

/* ---------------------------------------------------------------- evals */

/** New eval runs appear as result files are written, so re-check occasionally. */
export function useEvals() {
  return useSWR<EvalIndex, ApiError>(keys.evals, fetcher, { refreshInterval: 30_000, keepPreviousData: true, shouldRetryOnError: shouldRetry });
}

export function useEvalRun(id: string | null) {
  return useSWR<EvalRunDetail, ApiError>(id ? keys.evalRun(id) : null, fetcher, staticData);
}

const ACTIVE_RUN = new Set(['running', 'queued']);

const detailConfig: SWRConfiguration<IncidentDetail, ApiError> = {
  refreshInterval: (data) => (data && !ACTIVE_RUN.has(data.run.status) ? 10000 : 2000),
  onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
    if (!shouldRetry(error) || retryCount >= 5) return;
    setTimeout(() => revalidate({ retryCount }), 2000 * (retryCount + 1));
  },
};

export function useIncidentDetail(id: string | null) {
  return useSWR<IncidentDetail, ApiError>(id ? keys.incident(id) : null, fetcher, detailConfig);
}

/* ---------------------------------------------------------------- clock */

const TICK_MS = 15000;

function subscribeClock(cb: () => void) {
  const id = window.setInterval(cb, TICK_MS);
  return () => window.clearInterval(id);
}

function clockSnapshot() {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

/** A coarse "now" that re-renders every 15s; 0 on the server. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, clockSnapshot, () => 0);
}
