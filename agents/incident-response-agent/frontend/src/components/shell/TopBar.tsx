'use client';

import { useLayoutEffect, useState } from 'react';
import { LogOut, Menu as MenuIcon, Moon, Plus, Search, Sun } from 'lucide-react';
import { isForbidden } from '@/lib/api';
import { signOut } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useIncidents, useMe } from '@/lib/hooks';
import { displayName, highestRole, roleLabel } from '@/lib/roles';
import { applyTheme, setTheme, useTheme } from '@/lib/theme';
import { useAuthDisabled } from '../auth/AuthGate';
import { Dot } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Skeleton } from '../ui/Skeleton';
import { GlobalSearch } from './GlobalSearch';

export interface Crumb {
  label: string;
  href?: string;
}

export function TopBar({
  crumbs,
  navigate,
  onOpenNav,
  onNewIncident,
}: {
  crumbs: Crumb[];
  navigate: (href: string) => void;
  onOpenNav: () => void;
  /** Present only for responder+. */
  onNewIncident?: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-bg px-2 md:gap-2 md:px-6 xl:px-8">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenNav} aria-label="Open navigation">
        <MenuIcon />
      </Button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
          {crumbs.map((c, n) => {
            const last = n === crumbs.length - 1;
            return (
              <li key={`${c.label}-${n}`} className={cn('flex min-w-0 items-center gap-1.5', !last && 'max-sm:hidden')}>
                {c.href && !last ? (
                  <a
                    href={c.href}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(c.href ?? '/');
                    }}
                    className="truncate rounded text-fg-muted transition-colors hover:text-fg"
                  >
                    {c.label}
                  </a>
                ) : (
                  crumbs.length === 1 ? (
                    // Top-level pages: the breadcrumb is the page title.
                    <h1 className="truncate text-[14px] font-semibold text-fg">{c.label}</h1>
                  ) : (
                    <span aria-current="page" className="truncate font-mono text-[13px] text-fg">
                      {c.label}
                    </span>
                  )
                )}
                {!last && (
                  <span aria-hidden className="text-fg-subtle">
                    /
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <GlobalSearch navigate={navigate} className="hidden w-64 md:block lg:w-72" />
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search incidents" onClick={() => setSearchOpen(true)}>
        <Search />
      </Button>

      <LiveIndicator />
      <ThemeToggle className="max-md:hidden" />

      {onNewIncident && (
        <Button variant="primary" onClick={onNewIncident} aria-label="New incident" className="max-sm:w-11 max-sm:justify-center max-sm:px-0">
          <Plus className="sm:hidden" />
          <span className="max-sm:sr-only">New incident</span>
        </Button>
      )}

      <UserMenu />

      <Dialog open={searchOpen} onClose={() => setSearchOpen(false)} title="Search incidents" className="mt-4 mb-auto overflow-visible">
        <div className="px-4 pt-3 pb-4">
          <GlobalSearch navigate={navigate} autoFocus shortcut={false} onDone={() => setSearchOpen(false)} />
        </div>
      </Dialog>
    </header>
  );
}

/** API connectivity, derived from the shared incident-list poll. */
function LiveIndicator() {
  const { data, error } = useIncidents();
  const offline = Boolean(error) && !isForbidden(error);
  const state = offline ? 'offline' : data ? 'live' : 'connecting';
  const label = state === 'live' ? 'Live' : state === 'offline' ? 'Offline' : 'Connecting';
  const description =
    state === 'live'
      ? 'Connected to the API. Data refreshes every 5 seconds.'
      : state === 'offline'
        ? 'Cannot reach the API. Showing the last data received; retrying.'
        : 'Connecting to the API…';
  return (
    <div role="status" title={description} className="flex h-8 shrink-0 items-center gap-1.5 px-1.5 text-[12px] text-fg-subtle md:px-2">
      <Dot tone={state === 'live' ? 'success' : state === 'offline' ? 'danger' : 'neutral'} />
      <span className="max-md:sr-only">{label}</span>
      <span className="sr-only">{description}</span>
    </div>
  );
}

function useThemeSync(theme: 'light' | 'dark') {
  // React's dev Strict Mode remount resets <html> attributes it doesn't own;
  // re-apply the stored choice before paint (no-op in production).
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
}

/** Single sun/moon button; the label describes what pressing it does. */
function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  useThemeSync(theme);
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode';
  return (
    <Button variant="ghost" size="icon" className={className} onClick={() => setTheme(next)} aria-label={label} title={label}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

function initials(name: string): string {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function UserMenu() {
  const { data: me, error } = useMe();
  const authDisabled = useAuthDisabled();
  const theme = useTheme();
  const role = highestRole(me);
  const name = me ? displayName(me) : error ? 'Unknown user' : '';

  return (
    <Menu
      label={me ? `Account: ${name}` : 'Account'}
      triggerClassName="h-8 w-8 rounded-full max-md:h-11 max-md:w-11"
      trigger={
        me ? (
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border-strong bg-subtle text-[12px] font-medium text-fg-muted"
          >
            {initials(name)}
          </span>
        ) : (
          <Skeleton className="h-7 w-7 rounded-full" />
        )
      }
      panelClassName="w-60"
    >
      {(close) => (
        <>
          <div className="px-2 pt-1.5 pb-2">
            <p className="truncate text-[13px] font-medium text-fg">{name || 'Loading…'}</p>
            {me?.email && <p className="truncate text-[12px] text-fg-muted">{me.email}</p>}
            <p className="mt-0.5 text-[12px] text-fg-muted">
              {role ? `${roleLabel[role]} role` : me ? 'No role assigned' : error ? 'Could not load your profile' : ''}
            </p>
            {authDisabled && (
              <p
                className="mt-1.5 flex items-center gap-1.5 text-[12px] text-fg-muted"
                title="The API runs with AUTH_MODE=disabled: no sign-in is required. Never use this in production."
              >
                <Dot tone="warning" />
                Auth disabled (dev)
              </p>
            )}
          </div>
          <div className="md:hidden">
            <MenuSeparator />
            <MenuItem
              icon={theme === 'dark' ? <Sun /> : <Moon />}
              onSelect={() => {
                setTheme(theme === 'dark' ? 'light' : 'dark');
                close();
              }}
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </MenuItem>
          </div>
          {!authDisabled && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<LogOut />}
                onSelect={() => {
                  close();
                  void signOut();
                }}
              >
                Sign out
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );
}
