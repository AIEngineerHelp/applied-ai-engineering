'use client';

import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { AuthGate } from './auth/AuthGate';
import { ToastProvider } from './ui/Toast';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ revalidateOnFocus: true, dedupingInterval: 1000 }}>
      <ToastProvider>
        <AuthGate>{children}</AuthGate>
      </ToastProvider>
    </SWRConfig>
  );
}
