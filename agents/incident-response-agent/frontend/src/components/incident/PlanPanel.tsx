import { Check, CircleDashed, Minus, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { planStatusMeta } from '@/lib/meta';
import type { PlanStep, PlanStepStatus } from '@/lib/types';
import { Tag } from '../ui/Badge';
import { EmptyState } from '../ui/Card';
import { JsonBlock } from '../ui/JsonBlock';
import { Skeleton } from '../ui/Skeleton';

export function PlanPanel({ plan, active }: { plan: PlanStep[]; active: boolean }) {
  if (plan.length === 0) {
    return active ? (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    ) : (
      <EmptyState title="No investigation plan yet." className="px-0 text-left" />
    );
  }

  const groups = new Map<number, PlanStep[]>();
  for (const step of plan) {
    const list = groups.get(step.iteration) ?? [];
    list.push(step);
    groups.set(step.iteration, list);
  }
  const iterations = [...groups.keys()].sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      {iterations.map((iteration) => {
        const steps = groups.get(iteration) ?? [];
        return (
          <div key={iteration}>
            {iterations.length > 1 && (
              <h3 className="mb-2 text-[13px] font-medium text-fg-muted">
                Iteration {iteration}
                {iteration !== iterations[0] && <span className="font-normal"> · replanned</span>}
              </h3>
            )}
            <div className="rounded-md border border-border">
              <ol className="divide-y divide-border">
                {steps.map((step) => (
                  <PlanRow key={`${iteration}-${step.id}`} step={step} />
                ))}
              </ol>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusIcon({ status }: { status: PlanStepStatus }) {
  const cls = 'h-3.5 w-3.5';
  switch (status) {
    case 'done':
      return <Check className={cn(cls, 'text-success-fg')} strokeWidth={2} />;
    case 'failed':
      return <X className={cn(cls, 'text-danger-fg')} strokeWidth={2} />;
    case 'running':
      return <span className="animate-pulse-dot block h-1.5 w-1.5 rounded-full bg-info" />;
    case 'skipped':
      return <Minus className={cn(cls, 'text-fg-subtle')} />;
    default:
      return <CircleDashed className={cn(cls, 'text-fg-subtle')} />;
  }
}

function PlanRow({ step }: { step: PlanStep }) {
  const status = planStatusMeta[step.status];
  const hasArgs = step.args && Object.keys(step.args).length > 0;
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" title={status.label}>
        <StatusIcon status={step.status} />
        <span className="sr-only">{status.label}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className={cn('text-[13px] leading-snug', step.status === 'skipped' ? 'text-fg-subtle line-through' : 'text-fg')}>
            {step.goal}
          </p>
          <Tag>{step.tool}</Tag>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[12px] text-fg-subtle">
          <span>{step.id}</span>
          {step.depends_on.length > 0 && <span>after {step.depends_on.join(', ')}</span>}
        </div>
        {hasArgs && (
          <details className="mt-2">
            <summary className="inline-flex cursor-pointer items-center text-[12px] text-fg-muted select-none hover:text-fg max-md:min-h-11">Arguments</summary>
            <JsonBlock value={step.args} className="mt-2" />
          </details>
        )}
      </div>
    </li>
  );
}
