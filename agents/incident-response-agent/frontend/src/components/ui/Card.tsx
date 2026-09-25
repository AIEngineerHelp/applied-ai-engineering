import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Bordered box (radius 8). Use sparingly: tables, charts, forms. */
export function Card({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * A titled section: 15px/600 title with an optional right-aligned text link,
 * content below. `boxed` draws the content inside a bordered box.
 */
export function Section({
  title,
  action,
  children,
  className,
  boxed,
  boxClassName,
  id,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  boxed?: boolean;
  boxClassName?: string;
  id: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('min-w-0', className)}>
      <div className="mb-3 flex min-h-6 items-center justify-between gap-3">
        <h2 id={id} className="text-[15px] font-semibold text-fg">
          {title}
        </h2>
        {action}
      </div>
      {boxed ? <div className={cn('min-w-0 rounded-lg border border-border bg-surface', boxClassName)}>{children}</div> : children}
    </section>
  );
}

/** Page title for pages below the top level (top-level pages use the breadcrumb as their title). */
export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h1 className="min-w-0 text-[20px] font-semibold text-balance break-words text-fg">{children}</h1>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** One line of muted text, optionally followed by an action (text link). */
export function EmptyState({ title, action, className }: { title: string; action?: ReactNode; className?: string }) {
  return (
    <p className={cn('px-4 py-8 text-center text-[13px] text-fg-muted', className)}>
      {title}
      {action && <> {action}</>}
    </p>
  );
}

export function InlineError({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-[13px] text-fg"
    >
      <span className="flex min-w-0 items-center gap-2 break-words">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
        {message}
      </span>
      {action}
    </div>
  );
}

/** Inline text link-style button. */
export function TextButton({ children, onClick, className }: { children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('cursor-pointer rounded text-[13px] font-medium text-link hover:underline max-md:min-h-11', className)}
    >
      {children}
    </button>
  );
}
