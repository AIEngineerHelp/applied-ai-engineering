import { getAccessToken, handleUnauthorized } from './auth';
import { API_BASE_URL, apiLocation } from './config';
import { roleLabel } from './roles';
import type {
  CreateIncidentInput,
  DecisionInput,
  DecisionResponse,
  Incident,
  Role,
} from './types';

export { API_BASE_URL };

export const keys = {
  me: '/v1/me',
  incidents: '/v1/incidents',
  /** The list every view shares (SWR key): newest first, API maximum page. */
  incidentList: '/v1/incidents?limit=500',
  incident: (id: string) => `/v1/incidents/${encodeURIComponent(id)}`,
  pendingApprovals: '/v1/approvals/pending',
  graphOverview: '/v1/graph/overview',
  graph: (dataset: string) => `/v1/graph?dataset=${encodeURIComponent(dataset)}`,
  graphNode: (key: string) => `/v1/graph/node?key=${encodeURIComponent(key)}`,
  graphSearch: (q: string) => `/v1/graph/search?q=${encodeURIComponent(q)}`,
  evals: '/v1/evals',
  evalRun: (id: string) => `/v1/evals/${encodeURIComponent(id)}`,
  datasets: '/v1/datasets',
  dataset: (name: string) => `/v1/datasets/${encodeURIComponent(name)}`,
  datasetLogs: (name: string, f: { q?: string; level?: string | null; eventId?: string | null; offset: number; limit: number }) => {
    const p = new URLSearchParams({ offset: String(f.offset), limit: String(f.limit) });
    if (f.q?.trim()) p.set('q', f.q.trim());
    if (f.level) p.set('level', f.level);
    if (f.eventId) p.set('event_id', f.eventId);
    return `/v1/datasets/${encodeURIComponent(name)}/logs?${p.toString()}`;
  },
  datasetTemplates: (name: string) => `/v1/datasets/${encodeURIComponent(name)}/templates`,
  audit: (incidentId: string | null, limit: number) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (incidentId) p.set('incident_id', incidentId);
    return `/v1/audit?${p.toString()}`;
  },
} as const;

/** Error carrying the HTTP status, the API `detail` message and, for 403s, the role the endpoint needs. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | null;
  readonly requiredRole: Role | null;

  constructor(status: number, message: string, opts: { detail?: string | null; requiredRole?: Role | null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = opts.detail ?? null;
    this.requiredRole = opts.requiredRole ?? null;
  }
}

/** Minimum role per endpoint, mirroring the RBAC table in docs/production-contract.md. */
function requiredRoleFor(path: string, method: string): Role | null {
  const p = path.split('?')[0];
  if (p === '/v1/me' || p === '/v1/auth/config') return null;
  if (p.startsWith('/v1/audit')) return 'admin';
  if (method === 'POST' && p.startsWith('/v1/approvals/')) return 'approver';
  if (method === 'POST' && p === '/v1/incidents') return 'responder';
  return 'viewer';
}

const actionDescription: Record<Role, string> = {
  viewer: 'view this',
  responder: 'open incidents',
  approver: 'approve or reject actions',
  admin: 'view the audit log',
};

function detailToMessage(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  // FastAPI validation errors: [{loc: [...], msg: '...'}]
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        if (d && typeof d === 'object' && 'msg' in d) {
          const loc = 'loc' in d && Array.isArray(d.loc) ? d.loc.filter((l: unknown) => l !== 'body').join('.') : '';
          return loc ? `${loc}: ${String(d.msg)}` : String(d.msg);
        }
        return null;
      })
      .filter((p): p is string => Boolean(p));
    return parts.length ? parts.join('; ') : null;
  }
  return null;
}

/** A promise that never settles: used while the browser navigates to the IdP, so no error flashes. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function request<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const token = await getAccessToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${apiLocation()}`);
  }

  if (res.status === 401) {
    const outcome = await handleUnauthorized(attempt === 0);
    if (outcome === 'retry') return request<T>(path, init, attempt + 1);
    if (outcome === 'redirecting') return pending<T>();
    throw new ApiError(401, 'Your session is no longer valid. Sign in again.');
  }

  if (!res.ok) {
    let detail: string | null = null;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'detail' in body) detail = detailToMessage(body.detail);
    } catch {
      // Non-JSON error body; keep the status text.
    }
    if (res.status === 403) {
      const role = requiredRoleFor(path, method);
      const message = role
        ? `You don't have permission to ${actionDescription[role]} (needs the ${roleLabel[role]} role).`
        : "You don't have permission to do this.";
      throw new ApiError(403, message, { detail, requiredRole: role });
    }
    throw new ApiError(res.status, detail ?? `${res.status} ${res.statusText}`.trim(), { detail });
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function fetcher<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function createIncident(input: CreateIncidentInput): Promise<Incident> {
  return request<Incident>(keys.incidents, { method: 'POST', body: JSON.stringify(input) });
}

export function decideApproval(actionId: string, input: DecisionInput): Promise<DecisionResponse> {
  return request<DecisionResponse>(`/v1/approvals/${encodeURIComponent(actionId)}/decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function isForbidden(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 403;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
