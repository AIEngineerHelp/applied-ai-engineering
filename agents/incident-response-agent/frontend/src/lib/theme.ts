'use client';

import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY } from './theme-script';

/**
 * Explicit light/dark choice. Light is the default (the OS setting is not
 * followed); dark sets data-theme="dark" on <html>. The inline script in
 * app/layout.tsx applies the stored value before first paint.
 */
export type Theme = 'light' | 'dark';

const listeners = new Set<() => void>();
let current: Theme | null = null;

function read(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function snapshot(): Theme {
  current ??= read();
  return current;
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
}

export function setTheme(theme: Theme) {
  current = theme;
  try {
    if (theme === 'dark') window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    else window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts for this page only.
  }
  applyTheme(theme);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, snapshot, () => 'light');
}
