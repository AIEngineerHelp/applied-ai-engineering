import type { ReactNode } from 'react';
import { errorMessage, isForbidden } from '@/lib/api';
import { cn } from '@/lib/cn';
import { InlineError, TextButton } from './Card';

/** Calm, non-alarming notice for 403s: the user did nothing wrong, they just lack a role. */
export function PermissionNotice({ message, className }: { message: string; className?: string }) {
  return (
    <p role="status" className={cn('rounded-md border border-border px-3 py-2 text-[13px] leading-relaxed text-fg-muted', className)}>
      {message}
    </p>
  );
}

export function RetryButton({ onClick, label = 'Retry' }: { onClick: () => void; label?: string }) {
  return (
    <TextButton onClick={onClick} className="shrink-0">
      {label}
    </TextButton>
  );
}

/** Shows a permission notice for 403s and a regular inline error otherwise. */
export function ErrorNotice({
  error,
  prefix,
  action,
  onRetry,
}: {
  error: unknown;
  prefix?: string;
  action?: ReactNode;
  onRetry?: () => void;
}) {
  if (isForbidden(error)) return <PermissionNotice message={errorMessage(error)} />;
  const message = errorMessage(error);
  return (
    <InlineError
      message={prefix ? `${prefix}: ${message}` : message}
      action={action ?? (onRetry ? <RetryButton onClick={onRetry} /> : undefined)}
    />
  );
}
