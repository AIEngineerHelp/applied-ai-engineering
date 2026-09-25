import { Suspense } from 'react';
import { AppShell, AppShellFallback } from '@/components/shell/AppShell';

export default function Home() {
  // AppShell reads the URL via useSearchParams, which must sit under Suspense
  // so the static shell can prerender.
  return (
    <Suspense fallback={<AppShellFallback />}>
      <AppShell />
    </Suspense>
  );
}
