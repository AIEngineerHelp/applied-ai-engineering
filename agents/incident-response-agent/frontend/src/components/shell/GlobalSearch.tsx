'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { shortId } from '@/lib/format';
import { useIncidents } from '@/lib/hooks';
import { incidentHref, incidentsHref } from '@/lib/route';
import { matchesQuery, time } from '@/lib/stats';
import { SeverityBadge, StatusLabel } from '../ui/Badge';

const MAX_RESULTS = 6;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}

/**
 * Incident search combobox. "/" focuses it from anywhere; Enter opens the
 * highlighted incident, or the Incidents view filtered by the query.
 */
export function GlobalSearch({
  navigate,
  autoFocus,
  onDone,
  className,
  shortcut = true,
}: {
  navigate: (href: string) => void;
  autoFocus?: boolean;
  onDone?: () => void;
  className?: string;
  shortcut?: boolean;
}) {
  const { data } = useIncidents();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!shortcut) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === '/' && !isTyping(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return (data ?? [])
      .filter((i) => matchesQuery(i, query))
      .sort((a, b) => time(b.received_at) - time(a.received_at))
      .slice(0, MAX_RESULTS);
  }, [data, query]);

  const showList = open && query.trim().length > 0;
  // Option count = results + the "see all" row.
  const optionCount = results.length + 1;

  function go(href: string) {
    navigate(href);
    setOpen(false);
    setQuery('');
    setActive(-1);
    inputRef.current?.blur();
    onDone?.();
  }

  function choose(index: number) {
    if (index >= 0 && index < results.length) go(incidentHref(results[index].id));
    else go(incidentsHref({ q: query }));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % optionCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a <= 0 ? optionCount - 1 : a - 1));
    } else if (e.key === 'Enter') {
      if (!query.trim()) return;
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      if (query) setQuery('');
      else inputRef.current?.blur();
      setOpen(false);
    }
  }

  const optionId = (n: number) => `${listId}-opt-${n}`;

  return (
    <div ref={rootRef} className={cn('relative', className)} role="search">
      <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search incidents"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
        autoFocus={autoFocus}
        data-autofocus={autoFocus || undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search incidents"
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-full rounded-md border border-border bg-subtle pr-8 pl-8 text-[13px] text-fg transition-colors placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-link focus-visible:bg-bg focus-visible:outline-0 max-md:h-11 max-md:text-[16px] [&::-webkit-search-cancel-button]:hidden"
      />
      {shortcut && (
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border px-1.5 font-mono text-[12px] leading-4 text-fg-subtle"
        >
          /
        </kbd>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label="Matching incidents"
        className={cn(
          'absolute top-full right-0 left-0 z-40 mt-1.5 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-pop md:-right-24',
          !showList && 'hidden',
        )}
      >
        {results.length === 0 && (
          <p className="px-2 py-2 text-[13px] text-fg-muted">No incident matches “{query.trim()}”.</p>
        )}
        {results.map((i, n) => (
          <div
            key={i.id}
            id={optionId(n)}
            role="option"
            aria-selected={active === n}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => choose(n)}
            onPointerMove={() => setActive(n)}
            className={cn(
              'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5',
              active === n && 'bg-hover',
            )}
          >
            <SeverityBadge severity={i.severity} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-fg">{i.title}</p>
              <p className="truncate font-mono text-[12px] text-fg-subtle">
                {shortId(i.id)} · {i.service ?? 'no service'}
              </p>
            </div>
            <StatusLabel status={i.status} className="max-sm:hidden" />
          </div>
        ))}
        <div
          id={optionId(results.length)}
          role="option"
          aria-selected={active === results.length}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => choose(results.length)}
          onPointerMove={() => setActive(results.length)}
          className={cn(
            'flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-fg-muted',
            active === results.length && 'bg-hover text-fg',
          )}
        >
          Show all results in Incidents
        </div>
      </div>
    </div>
  );
}
