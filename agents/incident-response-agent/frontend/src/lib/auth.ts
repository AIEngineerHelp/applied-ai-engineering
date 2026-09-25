'use client';

import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { API_BASE_URL, AUTH_CALLBACK_PATH, apiLocation } from './config';
import type { AuthConfig } from './types';

/**
 * Browser-side session state. Kept outside React so the API client can read
 * tokens and trigger re-authentication, and exposed to components through a
 * tiny external store (see useAuth in components/auth/AuthGate).
 *
 * Flow: Authorization Code + PKCE against a public client (no secret). Tokens
 * live in sessionStorage (per tab, cleared when the tab closes) and are
 * renewed with the refresh token before they expire.
 */

export type AuthSnapshot =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'signed-out'; reason: string | null; issuer: string | null }
  | { status: 'signed-in'; mode: 'disabled' }
  | { status: 'signed-in'; mode: 'oidc'; user: User; returnTo: string | null };

const LOADING: AuthSnapshot = { status: 'loading' };
const REDIRECT_GUARD_KEY = 'ira.auth.lastRedirect';
const REDIRECT_GUARD_MS = 30_000;

let snapshot: AuthSnapshot = LOADING;
const listeners = new Set<() => void>();

let manager: UserManager | null = null;
let issuer: string | null = null;
let booting: Promise<void> | null = null;
let renewing: Promise<User | null> | null = null;
let redirecting = false;

function publish(next: AuthSnapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthSnapshot(): AuthSnapshot {
  return snapshot;
}

export function getServerAuthSnapshot(): AuthSnapshot {
  return LOADING;
}

/* ---------------------------------------------------------------- helpers */

function currentPath(): string {
  const { pathname, search, hash } = window.location;
  return pathname === AUTH_CALLBACK_PATH ? '/' : `${pathname}${search}${hash}`;
}

/** Only same-origin relative paths are accepted, to avoid open redirects. */
function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value.startsWith(AUTH_CALLBACK_PATH) ? '/' : value;
}

function returnToFromState(state: unknown): string {
  if (state && typeof state === 'object' && 'returnTo' in state) return safeReturnTo(state.returnTo);
  return '/';
}

function signedOut(reason: string | null): AuthSnapshot {
  return { status: 'signed-out', reason, issuer };
}

function describe(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Unknown error';
}

/* ---------------------------------------------------------------- boot */

async function loadConfig(): Promise<AuthConfig> {
  const res = await fetch(`${API_BASE_URL}/v1/auth/config`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  return (await res.json()) as AuthConfig;
}

function createManager(config: AuthConfig & { issuer: string; client_id: string }): UserManager {
  const origin = window.location.origin;
  const store = new WebStorageStateStore({ store: window.sessionStorage });
  const um = new UserManager({
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: `${origin}${AUTH_CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: 'code',
    scope: config.scopes || 'openid profile email',
    // Some IdPs (e.g. Auth0) need the audience on the authorize request to
    // issue an access token for the API; others ignore unknown parameters.
    extraQueryParams: config.audience ? { audience: config.audience } : undefined,
    userStore: store,
    stateStore: store,
    automaticSilentRenew: true,
    loadUserInfo: false,
    monitorSession: false,
  });

  um.events.addUserLoaded((user) => {
    const returnTo = snapshot.status === 'signed-in' && snapshot.mode === 'oidc' ? snapshot.returnTo : null;
    publish({ status: 'signed-in', mode: 'oidc', user, returnTo });
  });
  um.events.addUserUnloaded(() => {
    if (!redirecting) publish(signedOut(null));
  });
  um.events.addAccessTokenExpired(() => {
    void renewSession().then((user) => {
      if (!user && !redirecting) publish(signedOut('Your session expired. Sign in again to continue.'));
    });
  });
  return um;
}

async function boot(): Promise<void> {
  let config: AuthConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    booting = null; // allow retry
    publish({ status: 'error', message: `Cannot load sign-in settings from ${apiLocation()} (${describe(err)}).` });
    return;
  }

  if (config.mode !== 'oidc') {
    publish({ status: 'signed-in', mode: 'disabled' });
    return;
  }
  if (!config.issuer || !config.client_id) {
    booting = null;
    publish({ status: 'error', message: 'Single sign-on is enabled on the API but no issuer or client id is configured.' });
    return;
  }

  issuer = config.issuer;
  manager = createManager({ ...config, issuer: config.issuer, client_id: config.client_id });

  if (window.location.pathname === AUTH_CALLBACK_PATH) {
    try {
      const user = await manager.signinRedirectCallback();
      publish({ status: 'signed-in', mode: 'oidc', user, returnTo: returnToFromState(user.state) });
    } catch (err) {
      window.history.replaceState(null, '', '/');
      publish(signedOut(`Sign-in did not complete: ${describe(err)}`));
    }
    return;
  }

  let user = await manager.getUser();
  if (user?.expired) user = await renewSession();
  publish(user ? { status: 'signed-in', mode: 'oidc', user, returnTo: null } : signedOut(null));
}

/** Loads the auth config and restores the session. Safe to call repeatedly. */
export function startAuth(): Promise<void> {
  booting ??= boot();
  return booting;
}

export function retryAuth(): void {
  if (snapshot.status !== 'error') return;
  publish(LOADING);
  void startAuth();
}

/** Clears a consumed post-login redirect target. */
export function consumeReturnTo(): void {
  if (snapshot.status === 'signed-in' && snapshot.mode === 'oidc' && snapshot.returnTo) {
    publish({ ...snapshot, returnTo: null });
  }
}

/* ---------------------------------------------------------------- tokens */

/**
 * Silently renews the session with the refresh token. Concurrent callers
 * share one attempt. Resolves to null when renewal is not possible.
 */
export function renewSession(): Promise<User | null> {
  const um = manager;
  if (!um) return Promise.resolve(null);
  renewing ??= (async () => {
    try {
      const current = await um.getUser();
      // Without a refresh token signinSilent would fall back to a hidden
      // iframe, which the CSP (frame-ancestors 'none') intentionally blocks.
      if (!current?.refresh_token) return null;
      return await um.signinSilent();
    } catch {
      return null;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

/** Current access token, renewing it first if it has expired. Null when auth is disabled. */
export async function getAccessToken(): Promise<string | null> {
  if (!manager) return null;
  let user = await manager.getUser();
  if (user?.expired) user = await renewSession();
  return user?.access_token ?? null;
}

export function isOidc(): boolean {
  return manager !== null;
}

/* ---------------------------------------------------------------- sign in / out */

export async function signIn(returnTo?: string): Promise<void> {
  if (!manager || redirecting) return;
  redirecting = true;
  try {
    await manager.signinRedirect({ state: { returnTo: safeReturnTo(returnTo ?? currentPath()) } });
  } catch (err) {
    redirecting = false;
    publish(signedOut(`Could not reach the identity provider: ${describe(err)}`));
  }
}

export async function signOut(): Promise<void> {
  if (!manager) return;
  redirecting = true;
  try {
    await manager.signoutRedirect();
  } catch {
    // The IdP has no end-session endpoint: drop the local session only.
    redirecting = false;
    await manager.removeUser();
    publish(signedOut(null));
  }
}

/**
 * Called by the API client on a 401. With `renew`, tries one silent renewal
 * first ("retry" means the request can be repeated). Otherwise redirects to
 * the IdP, unless we already did so moments ago: a token the API keeps
 * rejecting right after login would loop forever, so we stop and explain.
 */
export async function handleUnauthorized(renew: boolean): Promise<'retry' | 'redirecting' | 'failed'> {
  if (!manager) return 'failed';
  if (redirecting) return 'redirecting';
  if (renew && (await renewSession())) return 'retry';

  let last = 0;
  try {
    last = Number(window.sessionStorage.getItem(REDIRECT_GUARD_KEY) ?? 0);
    window.sessionStorage.setItem(REDIRECT_GUARD_KEY, String(Date.now()));
  } catch {
    // Storage unavailable; skip the loop guard.
  }
  if (Date.now() - last < REDIRECT_GUARD_MS) {
    await manager.removeUser();
    publish(
      signedOut(
        'The API rejected your session right after sign-in. This usually means the API and the identity provider disagree on the token audience or issuer.',
      ),
    );
    return 'failed';
  }
  await signIn();
  return redirecting ? 'redirecting' : 'failed';
}
