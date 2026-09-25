'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastApi {
  toast: (t: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = nextId.current++;
      setItems((prev) => [...prev.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.kind === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 left-4 z-[1000] flex flex-col items-end gap-2 sm:left-auto"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 shadow-pop"
          >
            <span
              aria-hidden
              className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', t.kind === 'error' ? 'bg-danger' : t.kind === 'success' ? 'bg-success' : 'bg-info')}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-fg">{t.title}</p>
              {t.description && <p className="mt-0.5 text-[13px] break-words text-fg-muted">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-m-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
