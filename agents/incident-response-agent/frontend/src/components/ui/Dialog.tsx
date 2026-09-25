'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name; rendered as a header unless `hideHeader`. */
  title: string;
  description?: string;
  variant?: 'center' | 'drawer';
  hideHeader?: boolean;
  className?: string;
}

/**
 * Thin wrapper around the native <dialog> element: we get focus trapping,
 * Escape-to-close, inert background and top-layer stacking for free.
 */
export function Dialog({
  open,
  onClose,
  children,
  title,
  description,
  variant = 'center',
  hideHeader,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal() focuses the first focusable element (the close button);
      // prefer a field marked data-autofocus.
      el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        // Clicks on the backdrop land on the <dialog> element itself.
        if (e.target === e.currentTarget) onClose();
      }}
      className={cn(
        'bg-surface text-fg shadow-pop',
        variant === 'center' &&
          'm-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg rounded-lg border border-border p-0',
        variant === 'drawer' &&
          'm-0 h-dvh max-h-dvh w-[85vw] max-w-72 border-0 border-r border-border bg-subtle p-0',
        className,
      )}
    >
      {open && (
        <div className={cn('flex flex-col', variant === 'drawer' ? 'h-full' : 'max-h-[calc(100dvh-2rem)]')}>
          {!hideHeader && (
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-[15px] font-semibold">{title}</h2>
                {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
              </div>
              <Button variant="ghost" size="icon" className="-mt-1 -mr-2" onClick={onClose} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {children}
        </div>
      )}
    </dialog>
  );
}
