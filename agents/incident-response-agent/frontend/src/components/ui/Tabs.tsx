'use client';

import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

/** WAI-ARIA tablist with roving tabindex and arrow-key navigation. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  idPrefix,
  label,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  idPrefix: string;
  label: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(tabs[next].id);
  }

  return (
    <div role="tablist" aria-label={label} className="flex gap-5 overflow-x-auto border-b border-border">
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'relative -mb-px flex h-10 cursor-pointer items-center gap-1.5 border-b-2 px-1 text-[13px] whitespace-nowrap transition-colors duration-150 focus-visible:outline-offset-[-2px] max-md:h-11',
              selected ? 'border-link font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="text-[12px] text-fg-subtle tabular-nums">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
