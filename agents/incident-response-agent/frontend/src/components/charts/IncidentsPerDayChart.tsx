'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { formatDay, formatWeekday } from '@/lib/format';
import { SEVERITIES, severityChartFill, severityMeta } from '@/lib/meta';
import { niceTicks, type DayBucket } from '@/lib/stats';
import { useElementWidth } from '@/lib/useElementWidth';
import type { Severity } from '@/lib/types';
import { Skeleton } from '../ui/Skeleton';

const PLOT_H = 168;
const AXIS_H = 24;
const Y_AXIS_W = 28;
const TOP_PAD = 8;
const GAP = 2;
const MAX_BAR = 16;

/** Stack order from the baseline up: most severe sits on the axis. */
const STACK: Severity[] = ['sev1', 'sev2', 'sev3', 'sev4'];

function describeDay(b: DayBucket): string {
  const parts = SEVERITIES.filter((s) => b.counts[s] > 0).map((s) => `${severityMeta[s].label} ${b.counts[s]}`);
  return `${formatWeekday(b.start)}: ${b.total} ${b.total === 1 ? 'incident' : 'incidents'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

export function IncidentsPerDayLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Legend">
      {SEVERITIES.map((s) => (
        <li key={s} className="flex items-center gap-1.5 text-[12px] text-fg-muted">
          <span aria-hidden className="h-2 w-2 rounded-[1px]" style={{ background: severityChartFill[s] }} />
          <span>{severityMeta[s].label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Incidents received per day, stacked by severity. Hand-built SVG: thin
 * square columns (≤16px) with a 2px surface gap between segments, hairline
 * grid, per-column hover/focus tooltip, and a table view.
 */
export function IncidentsPerDayChart({ buckets, loading }: { buckets: DayBucket[]; loading: boolean }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const tableId = useId();
  const summaryId = useId();

  const total = buckets.reduce((acc, b) => acc + b.total, 0);
  const max = Math.max(0, ...buckets.map((b) => b.total));
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - Y_AXIS_W);
  const band = buckets.length ? plotW / buckets.length : 0;
  const barW = Math.max(4, Math.min(MAX_BAR, band * 0.4));
  const scale = (PLOT_H - TOP_PAD) / top;
  const labelEvery = band < 36 ? 3 : band < 64 ? 2 : 1;

  const peak = buckets.reduce<DayBucket | null>((best, b) => (b.total > (best?.total ?? 0) ? b : best), null);
  const summary = total
    ? `${total} ${total === 1 ? 'incident' : 'incidents'} in the last ${buckets.length} days. ` +
      `Busiest day: ${peak ? formatWeekday(peak.start) : ''} with ${peak?.total ?? 0}. ` +
      SEVERITIES.map((s) => `${severityMeta[s].label}: ${buckets.reduce((a, b) => a + b.counts[s], 0)}`).join(', ') +
      '.'
    : `No incidents in the last ${buckets.length || 14} days.`;

  function onKeyDown(e: KeyboardEvent<SVGGElement>, index: number) {
    let next = index;
    if (e.key === 'ArrowRight') next = Math.min(buckets.length - 1, index + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buckets.length - 1;
    else return;
    e.preventDefault();
    setFocusIndex(next);
    setActive(next);
    const el = (e.currentTarget.parentNode as SVGElement | null)?.querySelector<SVGGElement>(`[data-index="${next}"]`);
    el?.focus();
  }

  const activeBucket = active !== null ? buckets[active] : null;
  const tipLeft = active !== null ? Y_AXIS_W + band * active + band / 2 : 0;

  return (
    <div>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <div ref={ref} className="relative" style={{ height: PLOT_H + AXIS_H }}>
        {loading || !width ? (
          <div className="flex h-full items-end gap-3 pl-8" aria-hidden>
            {Array.from({ length: 14 }, (_, i) => (
              <Skeleton key={i} className="flex-1" />
            ))}
          </div>
        ) : (
          <svg
            width={width}
            height={PLOT_H + AXIS_H}
            role="group"
            aria-label="Incidents per day, last 14 days, stacked by severity"
            aria-describedby={summaryId}
            className="block overflow-visible"
          >
            {/* Grid + y ticks */}
            {ticks.map((t) => {
              const y = PLOT_H - t * scale;
              return (
                <g key={t} aria-hidden>
                  <line x1={Y_AXIS_W} x2={width} y1={y} y2={y} stroke="var(--chart-grid)" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={Y_AXIS_W - 8} y={y} dy="0.32em" textAnchor="end" className="fill-fg-subtle text-[12px] tabular-nums">
                    {t}
                  </text>
                </g>
              );
            })}

            {buckets.map((b, i) => {
              const cx = Y_AXIS_W + band * i + band / 2;
              const x = cx - barW / 2;
              const present = STACK.filter((s) => b.counts[s] > 0);
              let cursor = PLOT_H;
              const isToday = i === buckets.length - 1;
              const showLabel = isToday || (buckets.length - 1 - i) % labelEvery === 0;
              return (
                <g
                  key={b.start}
                  data-index={i}
                  role="img"
                  aria-label={describeDay(b)}
                  tabIndex={i === focusIndex ? 0 : -1}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => {
                    setActive(i);
                    setFocusIndex(i);
                  }}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  className="cursor-default outline-none [&:focus-visible>rect.hit]:stroke-link"
                >
                  {/* Hit target: the whole band, bigger than the mark. */}
                  <rect
                    className="hit"
                    x={Y_AXIS_W + band * i + 1}
                    y={0}
                    width={Math.max(0, band - 2)}
                    height={PLOT_H}
                    rx={4}
                    fill={active === i ? 'var(--hover)' : 'transparent'}
                    strokeWidth={2}
                  />
                  {present.map((s, n) => {
                    const h = b.counts[s] * scale;
                    const isTop = n === present.length - 1;
                    const segH = Math.max(1, isTop ? h : h - GAP);
                    const y = cursor - h;
                    cursor -= h;
                    return (
                      <rect key={s} x={x} y={isTop ? y : y + GAP} width={barW} height={segH} fill={severityChartFill[s]} />
                    );
                  })}
                  {showLabel && (
                    <text
                      x={cx}
                      y={PLOT_H + 17}
                      textAnchor="middle"
                      aria-hidden
                      className={cn('text-[12px] tabular-nums', isToday ? 'fill-fg-muted' : 'fill-fg-subtle')}
                    >
                      {isToday ? 'Today' : formatDay(b.start)}
                    </text>
                  )}
                </g>
              );
            })}
            <line
              x1={Y_AXIS_W}
              x2={width}
              y1={PLOT_H + 0.5}
              y2={PLOT_H + 0.5}
              stroke="var(--border-strong)"
              strokeWidth={1}
              aria-hidden
            />
          </svg>
        )}

        {!loading && width > 0 && total === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6 pl-7">
            <p className="bg-surface px-2 text-[13px] text-fg-muted">No incidents in the last 14 days.</p>
          </div>
        )}

        {activeBucket && (
          <div
            role="presentation"
            className="pointer-events-none absolute z-10 w-40 rounded-md border border-border bg-surface px-3 py-2 shadow-pop"
            style={{
              left: Math.min(Math.max(tipLeft - 88, 0), Math.max(0, width - 176)),
              top: 0,
            }}
          >
            <p className="text-[12px] font-medium text-fg-muted">{formatWeekday(activeBucket.start)}</p>
            <p className="mt-0.5 text-[15px] font-semibold text-fg tabular-nums">
              {activeBucket.total}
              <span className="ml-1 font-sans text-[12px] font-normal text-fg-muted">
                {activeBucket.total === 1 ? 'incident' : 'incidents'}
              </span>
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {SEVERITIES.map((s) => (
                <li key={s} className="flex items-center gap-2 text-[12px]">
                  <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: severityChartFill[s] }} />
                  <span className="flex-1 text-fg-muted">{severityMeta[s].label}</span>
                  <span className="font-medium text-fg tabular-nums">{activeBucket.counts[s]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {!loading && buckets.length > 0 && (
        <details className="mt-3">
          <summary className="inline-flex cursor-pointer items-center rounded text-[12px] text-fg-muted select-none hover:text-fg max-md:min-h-11">
            View as table
          </summary>
          <div className="mt-2 overflow-x-auto rounded-md border border-border">
            <table id={tableId} className="w-full text-left text-[13px]">
              <caption className="sr-only">Incidents per day by severity</caption>
              <thead className="bg-subtle text-[12px] text-fg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Day</th>
                  {SEVERITIES.map((s) => (
                    <th key={s} scope="col" className="px-3 py-2 text-right font-medium">
                      {severityMeta[s].label}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {[...buckets].reverse().map((b) => (
                  <tr key={b.start} className="border-t border-border">
                    <th scope="row" className="px-3 py-1.5 font-normal whitespace-nowrap text-fg">
                      {formatWeekday(b.start)}
                    </th>
                    {SEVERITIES.map((s) => (
                      <td key={s} className="px-3 py-1.5 text-right text-fg-muted tabular-nums">
                        {b.counts[s]}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-medium text-fg tabular-nums">{b.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
