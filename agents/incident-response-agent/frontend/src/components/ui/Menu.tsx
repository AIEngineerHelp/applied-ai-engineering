'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Minimal accessible dropdown: a trigger button (aria-haspopup/expanded) and
 * a panel that closes on Escape, outside click and item selection. Items
 * inside should be <MenuItem>s; arrow keys move between them.
 */
export function Menu({
  trigger,
  label,
  children,
  align = 'end',
  triggerClassName,
  panelClassName,
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  triggerClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const triggerId = `${id}-trigger`;

  const close = useCallback(() => {
    setOpen(false);
    document.getElementById(triggerId)?.focus();
  }, [triggerId]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    // Focus the first item for keyboard users.
    const first = panelRef.current?.querySelector<HTMLElement>('[role^="menuitem"]');
    first?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    if (!items.length) return;
    e.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (e.key === 'End') next = items.length - 1;
    items[next]?.focus();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex cursor-pointer items-center justify-center rounded-md transition-colors duration-150 hover:bg-hover',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={cn(
            'absolute top-full z-40 mt-1.5 min-w-48 rounded-lg border border-border bg-surface p-1 shadow-pop',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  checked,
  icon,
}: {
  children: ReactNode;
  onSelect: () => void;
  /** When defined, renders as a radio item. */
  checked?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      tabIndex={-1}
      onClick={onSelect}
      className={cn(
        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg transition-colors duration-150 hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px] max-md:h-11',
        '[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5] [&_svg]:text-fg-subtle',
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {checked && <Check aria-hidden className="text-fg!" />}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}
