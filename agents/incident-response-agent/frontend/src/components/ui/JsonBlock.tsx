import { cn } from '@/lib/cn';
import { toJson } from '@/lib/format';

export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  const text = typeof value === 'string' ? value : toJson(value);
  return (
    <pre
      className={cn(
        'max-h-72 overflow-auto rounded-md border border-border bg-subtle px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-fg-muted',
        className,
      )}
    >
      {text}
    </pre>
  );
}
