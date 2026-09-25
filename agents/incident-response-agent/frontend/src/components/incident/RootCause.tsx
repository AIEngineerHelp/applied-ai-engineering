import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { humanize } from '@/lib/format';
import type { Evidence, Hypothesis } from '@/lib/types';
import { Tag } from '../ui/Badge';
import { EmptyState, Section } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

export function RootCause({
  hypotheses,
  evidence,
  active,
  live,
  onEvidenceClick,
}: {
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  active: boolean;
  /** Shown instead of a placeholder while the run is working and has no hypothesis yet. */
  live?: ReactNode;
  onEvidenceClick: (id: string) => void;
}) {
  const [top, ...rest] = hypotheses;

  return (
    <Section id="rca-heading" title="Root cause" boxed boxClassName="p-4 md:p-5">
      {!top ? (
        active ? (
          (live ?? <Skeleton className="h-4 w-1/3" />)
        ) : (
          <EmptyState title="No evidence-backed root cause was found." className="px-0 py-2 text-left" />
        )
      ) : (
        <>
          <HypothesisBody hypothesis={top} evidence={evidence} onEvidenceClick={onEvidenceClick} />
          {rest.length > 0 && <Alternatives items={rest} label="other candidate" />}
          {top.alternatives?.length > 0 && <Alternatives items={top.alternatives} label="alternative" />}
        </>
      )}
    </Section>
  );
}

/** Confidence meter: neutral bar + numeric percentage. */
function Confidence({ value, compact }: { value: number; compact?: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={cn('flex shrink-0 items-center gap-2.5', compact ? 'w-28' : 'w-full sm:w-52')}>
      {!compact && <span className="text-[12px] text-fg-muted">Confidence</span>}
      <div
        role="meter"
        aria-label="Confidence"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${pct}%`}
        className="h-1.5 flex-1 bg-hover"
      >
        <div className="h-full bg-fg" style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('w-9 text-right font-semibold text-fg tabular-nums', compact ? 'text-[12px]' : 'text-[13px]')}>{pct}%</span>
    </div>
  );
}

function HypothesisBody({
  hypothesis,
  evidence,
  onEvidenceClick,
}: {
  hypothesis: Hypothesis;
  evidence: Evidence[];
  onEvidenceClick: (id: string) => void;
}) {
  const known = new Set(evidence.map((e) => e.id));
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="font-mono text-[15px] font-semibold break-all text-fg">{hypothesis.root_cause_component}</p>
          <p className="mt-0.5 text-[13px] text-fg-muted">{humanize(hypothesis.fault_type)}</p>
        </div>
        <Confidence value={hypothesis.confidence} />
      </div>
      <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-fg">{hypothesis.description}</p>
      {hypothesis.evidence_ids.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-fg-muted">Evidence</span>
          {hypothesis.evidence_ids.map((id) =>
            known.has(id) ? (
              <button
                key={id}
                type="button"
                onClick={() => onEvidenceClick(id)}
                className="inline-flex h-6 cursor-pointer items-center rounded-md border border-border-strong px-1.5 font-mono text-[12px] text-fg transition-colors duration-150 hover:bg-hover max-md:h-11 max-md:px-3"
                title="Show evidence"
              >
                {id}
              </button>
            ) : (
              <Tag key={id} className="text-fg-subtle">
                {id}
              </Tag>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Alternatives({ items, label }: { items: Hypothesis[]; label: string }) {
  return (
    <details className="mt-4 border-t border-border pt-3">
      <summary className="inline-flex cursor-pointer items-center text-[13px] text-fg-muted select-none hover:text-fg max-md:min-h-11">
        {items.length} {label}
        {items.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-2 divide-y divide-border">
        {items.map((h, i) => (
          <li key={i} className="py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-[13px]">
                <span className="font-mono text-[12px] text-fg">{h.root_cause_component}</span>
                <span className="text-fg-muted"> · {humanize(h.fault_type)}</span>
              </span>
              <Confidence value={h.confidence} compact />
            </div>
            {h.description && <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{h.description}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}
