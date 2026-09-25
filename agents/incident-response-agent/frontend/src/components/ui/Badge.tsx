import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { runStatusMeta, severityMeta, statusMeta, toneDot, type Tone } from '@/lib/meta';
import type { RunStatus, Severity } from '@/lib/types';

/** 6px signal dot; `pulse` fades it gently (off under prefers-reduced-motion). */
export function Dot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', toneDot[tone], pulse && 'animate-pulse-dot', className)}
    />
  );
}

/** Severity: 8px square in the signal color + "SEV1". No background. */
export function SeverityBadge({ severity, className, showName }: { severity: Severity; className?: string; showName?: boolean }) {
  const meta = severityMeta[severity] ?? { label: severity, tone: 'neutral' as Tone, name: severity };
  return (
    <span
      title={`${meta.label} · ${meta.name}`}
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium whitespace-nowrap text-fg tabular-nums', className)}
    >
      <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-[1px]', toneDot[meta.tone])} />
      {meta.label}
      {showName && <span className="font-normal text-fg-muted">{meta.name}</span>}
    </span>
  );
}

/** Dot + text in the primary text color. Used for statuses, risks and decisions. */
export function ToneLabel({
  tone,
  live,
  children,
  className,
  title,
}: {
  tone: Tone;
  live?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn('inline-flex shrink-0 items-center gap-2 text-[13px] whitespace-nowrap text-fg', className)}>
      <Dot tone={tone} pulse={live} />
      {children}
    </span>
  );
}

export function StatusLabel({ status, className }: { status: string; className?: string }) {
  const meta = statusMeta(status);
  return (
    <ToneLabel tone={meta.tone} live={meta.live} className={className}>
      {meta.label}
    </ToneLabel>
  );
}

export function RunStatusLabel({ status, className }: { status: RunStatus; className?: string }) {
  const meta = runStatusMeta[status] ?? { label: status, tone: 'neutral' as Tone };
  return (
    <ToneLabel tone={meta.tone} live={meta.live} className={className}>
      {meta.label}
    </ToneLabel>
  );
}

/** Quiet mono tag for tool names and labels. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-1.5 font-mono text-[12px] whitespace-nowrap text-fg-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
