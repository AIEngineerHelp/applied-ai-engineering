import { OPEN_STATUSES, SEVERITIES, incidentStatusOrder, severityMeta } from './meta';
import type { IncidentFilters, SinceFilter, SortDir, SortKey } from './route';
import type { Incident, IncidentStatus, Severity } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function time(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const SINCE_MS: Record<Exclude<SinceFilter, 'any'>, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/* ---------------------------------------------------------------- filtering */

export function matchesStatus(status: IncidentStatus, filter: IncidentFilters['status']): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'open':
      return OPEN_STATUSES.includes(status);
    case 'closed':
      return !OPEN_STATUSES.includes(status);
    case 'done':
      return status === 'reported' || status === 'resolved';
    default:
      return status === filter;
  }
}

export function matchesQuery(i: Incident, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    i.title.toLowerCase().includes(q) ||
    (i.service ?? '').toLowerCase().includes(q) ||
    i.id.toLowerCase().includes(q) ||
    (i.external_id ?? '').toLowerCase().includes(q) ||
    i.source.toLowerCase().includes(q)
  );
}

/** `now` = 0 (server render) disables the time window instead of hiding everything. */
export function filterIncidents(list: Incident[], f: IncidentFilters, now: number): Incident[] {
  const since = f.since !== 'any' && now ? now - SINCE_MS[f.since] : null;
  return list.filter(
    (i) =>
      matchesStatus(i.status, f.status) &&
      (f.sev.length === 0 || f.sev.includes(i.severity)) &&
      (f.env === 'all' || i.environment === f.env) &&
      (!f.service || i.service === f.service) &&
      (since === null || time(i.started_at) >= since) &&
      matchesQuery(i, f.q),
  );
}

const statusRank = new Map(incidentStatusOrder.map((s, n) => [s, n]));

function compare(a: Incident, b: Incident, key: SortKey): number {
  switch (key) {
    case 'severity':
      return severityMeta[a.severity].rank - severityMeta[b.severity].rank;
    case 'title':
      return a.title.localeCompare(b.title);
    case 'service':
      return (a.service ?? '').localeCompare(b.service ?? '');
    case 'environment':
      return a.environment.localeCompare(b.environment);
    case 'status':
      return (statusRank.get(a.status) ?? 99) - (statusRank.get(b.status) ?? 99);
    case 'started':
      return time(a.started_at) - time(b.started_at);
  }
}

/** Stable sort; ties fall back to newest first so rows never jump between polls. */
export function sortIncidents(list: Incident[], key: SortKey, dir: SortDir): Incident[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...list].sort(
    (a, b) => sign * compare(a, b, key) || time(b.started_at) - time(a.started_at) || a.id.localeCompare(b.id),
  );
}

/* ---------------------------------------------------------------- overview */

export interface Kpis {
  open: number;
  awaiting: number;
  criticalOpen: number;
  criticalSev1: number;
  doneLast24h: number;
  failedLast24h: number;
  total: number;
}

function receivedWithin(i: Incident, now: number, ms: number): boolean {
  // "Last 24h" is keyed on when we received the incident: the API has no
  // per-status transition timestamps.
  return now > 0 && time(i.received_at) >= now - ms;
}

export function computeKpis(list: Incident[], now: number): Kpis {
  let open = 0;
  let awaiting = 0;
  let criticalOpen = 0;
  let criticalSev1 = 0;
  let doneLast24h = 0;
  let failedLast24h = 0;
  for (const i of list) {
    const isOpen = OPEN_STATUSES.includes(i.status);
    if (isOpen) open++;
    if (i.status === 'awaiting_approval') awaiting++;
    if (isOpen && (i.severity === 'sev1' || i.severity === 'sev2')) {
      criticalOpen++;
      if (i.severity === 'sev1') criticalSev1++;
    }
    if ((i.status === 'reported' || i.status === 'resolved') && receivedWithin(i, now, DAY)) doneLast24h++;
    if (i.status === 'failed' && receivedWithin(i, now, DAY)) failedLast24h++;
  }
  return { open, awaiting, criticalOpen, criticalSev1, doneLast24h, failedLast24h, total: list.length };
}

export interface DayBucket {
  /** Local midnight, ms. */
  start: number;
  counts: Record<Severity, number>;
  total: number;
}

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Incidents received per local calendar day for the last `days` days (oldest first). */
export function incidentsPerDay(list: Incident[], now: number, days = 14): DayBucket[] {
  if (!now) return [];
  const today = localMidnight(now);
  const buckets: DayBucket[] = [];
  for (let n = days - 1; n >= 0; n--) {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    buckets.push({ start: d.getTime(), counts: { sev1: 0, sev2: 0, sev3: 0, sev4: 0 }, total: 0 });
  }
  const first = buckets[0].start;
  for (const i of list) {
    const t = time(i.received_at);
    if (t < first) continue;
    const day = localMidnight(t);
    const b = buckets.find((x) => x.start === day);
    if (!b) continue;
    b.counts[i.severity]++;
    b.total++;
  }
  return buckets;
}

export function statusBreakdown(list: Incident[]): { status: IncidentStatus; count: number }[] {
  const counts = new Map<IncidentStatus, number>();
  for (const i of list) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  return incidentStatusOrder.filter((s) => counts.has(s)).map((s) => ({ status: s, count: counts.get(s) ?? 0 }));
}

export interface ServiceRow {
  service: string;
  total: number;
  open: number;
  critical: number;
  worst: Severity;
  last: string;
}

export function topServices(list: Incident[], limit = 6): ServiceRow[] {
  const rows = new Map<string, ServiceRow>();
  for (const i of list) {
    const key = i.service ?? '';
    const row = rows.get(key) ?? { service: key, total: 0, open: 0, critical: 0, worst: 'sev4' as Severity, last: i.received_at };
    row.total++;
    if (OPEN_STATUSES.includes(i.status)) row.open++;
    if (i.severity === 'sev1' || i.severity === 'sev2') row.critical++;
    if (severityMeta[i.severity].rank < severityMeta[row.worst].rank) row.worst = i.severity;
    if (time(i.received_at) > time(row.last)) row.last = i.received_at;
    rows.set(key, row);
  }
  return [...rows.values()]
    .sort((a, b) => b.open - a.open || b.total - a.total || a.service.localeCompare(b.service))
    .slice(0, limit);
}

/** Clean axis ticks from 0 to a rounded max (at least 1). */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? mag * 10;
  const niceStep = Math.max(1, step);
  const top = Math.ceil(max / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += niceStep) ticks.push(v);
  return ticks;
}

export { SEVERITIES };
