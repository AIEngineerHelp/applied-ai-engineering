import { cn } from '@/lib/cn';

/** Product name as plain text with a small monochrome mark. */
export function Logo({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-primary">
        <span className="h-2 w-2 rounded-[2px] bg-primary-fg" />
      </span>
      {!compact && <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Incident Response</span>}
    </div>
  );
}
