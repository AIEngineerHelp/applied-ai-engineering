'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';
import {
  consumeReturnTo,
  getAuthSnapshot,
  getServerAuthSnapshot,
  retryAuth,
  signIn,
  startAuth,
  subscribeAuth,
  type AuthSnapshot,
} from '@/lib/auth';
import { Button } from '../ui/Button';
import { Logo } from '../shell/Logo';

export function useAuth(): AuthSnapshot {
  return useSyncExternalStore(subscribeAuth, getAuthSnapshot, getServerAuthSnapshot);
}

/** Whether the API runs with AUTH_MODE=disabled (local development). */
export function useAuthDisabled(): boolean {
  const auth = useAuth();
  return auth.status === 'signed-in' && auth.mode === 'disabled';
}

/**
 * Renders the app only once the user has a session (or auth is disabled).
 * Everything below it can assume API calls carry a valid bearer token.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    void startAuth();
  }, []);

  const returnTo = auth.status === 'signed-in' && auth.mode === 'oidc' ? auth.returnTo : null;
  useEffect(() => {
    if (!returnTo) return;
    router.replace(returnTo);
    consumeReturnTo();
  }, [returnTo, router]);

  if (auth.status === 'signed-in') return children;

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-sm">
        {auth.status === 'loading' && (
          <div role="status" className="flex flex-col items-center gap-3 text-[13px] text-fg-subtle">
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
            <span>Loading…</span>
          </div>
        )}
        {auth.status === 'error' && <ConfigError message={auth.message} />}
        {auth.status === 'signed-out' && <SignIn reason={auth.reason} issuer={auth.issuer} />}
      </div>
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-6 py-7 sm:px-8">
      <Logo />
      {children}
    </div>
  );
}

function SignIn({ reason, issuer }: { reason: string | null; issuer: string | null }) {
  let host: string | null = null;
  try {
    host = issuer ? new URL(issuer).host : null;
  } catch {
    host = issuer;
  }

  return (
    <Panel>
      <h1 className="mt-6 text-[20px] font-semibold text-fg">Sign in</h1>
      {reason && (
        <p role="alert" className="mt-4 flex gap-2 rounded-md border border-border px-3 py-2 text-[13px] leading-relaxed text-fg">
          <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
          <span className="min-w-0 break-words">{reason}</span>
        </p>
      )}
      <Button variant="primary" className="mt-6 w-full justify-center" onClick={() => void signIn()} autoFocus>
        Continue with single sign-on
      </Button>
      {host && <p className="mt-3 text-center font-mono text-[12px] text-fg-subtle">{host}</p>}
    </Panel>
  );
}

function ConfigError({ message }: { message: string }) {
  return (
    <Panel>
      <h1 className="mt-6 text-[20px] font-semibold text-fg">Can’t start the console</h1>
      <p role="alert" className="mt-2 text-[14px] leading-relaxed break-words text-fg-muted">
        {message}
      </p>
      <Button variant="secondary" className="mt-6 w-full justify-center" onClick={retryAuth}>
        Try again
      </Button>
    </Panel>
  );
}
