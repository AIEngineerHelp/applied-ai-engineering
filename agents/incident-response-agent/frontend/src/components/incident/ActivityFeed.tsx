'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { nodeShortLabels } from '@/lib/meta';
import { time } from '@/lib/stats';
import type { ActivityEntry } from '@/lib/types';

const HISTORY = 4;
const MS_PER_CHAR = 20;
const MAX_TYPE_MS = 1000;

function entryKey(e: ActivityEntry): string {
  return `${e.at}|${e.message}`;
}

function stepLabel(node: string): string {
  return nodeShortLabels[node] ?? node;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Live narration of what the agent is doing. The newest line types out
 * (keyed on at+message, so a poll that returns the same entry never restarts
 * it); older lines sit above in subtle text, fading upward. `live` = the run
 * is still working (typing, caret, shimmer); otherwise the newest line is
 * shown statically (e.g. while waiting for an approval).
 */
export function ActivityFeed({
  entries,
  live,
  queuedLabel = 'Waiting for a worker to pick up this run',
  className,
}: {
  entries: ActivityEntry[];
  live: boolean;
  queuedLabel?: string;
  className?: string;
}) {
  const now = useNow();
  const newest = entries.length ? entries[entries.length - 1] : null;
  const history = entries.slice(Math.max(0, entries.length - 1 - HISTORY), Math.max(0, entries.length - 1));

  return (
    <div className={cn('min-w-0', className)}>
      {/* Screen readers get each full message once, not per character. */}
      <p aria-live="polite" className="sr-only">
        {newest ? `${stepLabel(newest.node)}: ${newest.message}` : queuedLabel}
      </p>

      <ol aria-hidden className="space-y-1">
        {history.map((e, n) => (
          <li
            key={entryKey(e)}
            className="text-[13px] text-fg-subtle"
            // Older lines fade out upward.
            style={{ opacity: 0.4 + (0.55 * (n + 1)) / history.length }}
          >
            <span className="animate-rise flex min-w-0 items-baseline gap-2">
              <StepPrefix node={e.node} />
              <span className="min-w-0 flex-1 truncate" title={e.message}>
                {e.message}
              </span>
              <time dateTime={e.at} title={formatDateTime(e.at)} className="shrink-0 text-[12px] tabular-nums">
                {/* Server clocks can run slightly ahead of the 15s-coarse local clock. */}
                {relativeTime(e.at, Math.max(now, time(e.at)))}
              </time>
            </span>
          </li>
        ))}

        <li className="flex min-w-0 items-baseline gap-2 pt-0.5 text-[14px]">
          {newest ? (
            <>
              <StepPrefix node={newest.node} />
              <TypingLine key={entryKey(newest)} text={newest.message} animate={live} />
            </>
          ) : (
            <span className="text-fg-muted">
              {queuedLabel}
              {live && <Caret />}
            </span>
          )}
        </li>
      </ol>
    </div>
  );
}

function StepPrefix({ node }: { node: string }) {
  return <span className="w-[4.5rem] shrink-0 text-[12px] text-fg-muted">{stepLabel(node)}</span>;
}

function Caret() {
  return <span aria-hidden className="animate-caret ml-px inline-block h-[1.05em] w-px translate-y-[0.18em] bg-fg" />;
}

/** Types `text` out once on mount; remounted (via key) only for a new entry. */
function TypingLine({ text, animate }: { text: string; animate: boolean }) {
  const [reduced] = useState(prefersReducedMotion);
  const typing = animate && !reduced;
  const [count, setCount] = useState(() => (typing ? 0 : text.length));

  useEffect(() => {
    if (!typing) return;
    const step = Math.min(MS_PER_CHAR, MAX_TYPE_MS / Math.max(1, text.length));
    const started = performance.now();
    const id = window.setInterval(() => {
      const n = Math.min(text.length, Math.floor((performance.now() - started) / step) + 1);
      setCount(n);
      if (n >= text.length) window.clearInterval(id);
    }, Math.max(16, step));
    return () => window.clearInterval(id);
    // Only on mount: a new message remounts this component via its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = typing ? count : text.length;
  const done = shown >= text.length;
  return (
    <span className="animate-rise min-w-0 flex-1 break-words">
      {/* Shimmer while the step is still in progress (off under reduced motion via CSS). */}
      <span className={cn('text-fg', animate && done && 'text-shimmer')}>{text.slice(0, shown)}</span>
      {typing && <Caret />}
    </span>
  );
}
