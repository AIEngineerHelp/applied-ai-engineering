'use client';

import { useEffect, useState } from 'react';

/**
 * Local text state for a URL-backed filter: typing updates immediately, the
 * URL is updated after `delay` ms, and external URL changes (back button,
 * links) are adopted.
 */
export function useUrlDraft(urlValue: string, commit: (value: string) => void, delay = 250) {
  const [draft, setDraft] = useState(urlValue);
  const [synced, setSynced] = useState(urlValue);
  if (urlValue !== synced) {
    setSynced(urlValue);
    setDraft(urlValue);
  }
  useEffect(() => {
    if (draft === urlValue) return;
    const t = window.setTimeout(() => {
      setSynced(draft);
      commit(draft);
    }, delay);
    return () => window.clearTimeout(t);
  }, [draft, urlValue, commit, delay]);
  return [draft, setDraft] as const;
}
