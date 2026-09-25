'use client';

import Link from 'next/link';
import { FileText, FlaskConical, LayoutDashboard, Network, ListChecks, ScrollText, Siren, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { approvalsHref, auditHref, evalsHref, graphHref, incidentsHref, logsHref, overviewHref, type View } from '@/lib/route';
import { Logo } from './Logo';

interface Item {
  id: View;
  label: string;
  href: string;
  icon: LucideIcon;
  count?: number;
}

/**
 * Light sidebar. `rail` is 220px from xl and a 56px icon rail between md and
 * xl (tooltips + aria-labels); `drawer` is the always-expanded variant inside
 * the mobile off-canvas dialog.
 */
export function SideNav({
  active,
  pendingCount,
  isAdmin,
  variant,
  onNavigate,
}: {
  active: View;
  pendingCount: number;
  isAdmin: boolean;
  variant: 'rail' | 'drawer';
  onNavigate?: () => void;
}) {
  const rail = variant === 'rail';
  const items: Item[] = [
    { id: 'overview', label: 'Overview', href: overviewHref, icon: LayoutDashboard },
    { id: 'incidents', label: 'Incidents', href: incidentsHref(), icon: Siren },
    { id: 'logs', label: 'Logs', href: logsHref(), icon: FileText },
    { id: 'graph', label: 'Knowledge graph', href: graphHref(), icon: Network },
    { id: 'evals', label: 'Evals', href: evalsHref(), icon: FlaskConical },
    { id: 'approvals', label: 'Approvals', href: approvalsHref, icon: ListChecks, count: pendingCount },
    ...(isAdmin ? [{ id: 'audit' as const, label: 'Audit log', href: auditHref(), icon: ScrollText }] : []),
  ];

  return (
    <div className="flex h-full flex-col bg-subtle">
      <div className={cn('flex h-12 shrink-0 items-center', rail ? 'justify-center xl:justify-start xl:px-4' : 'px-4')}>
        <Logo compact={false} className={rail ? 'max-xl:[&>span:last-child]:hidden' : undefined} />
      </div>

      <nav aria-label="Main" className="flex-1 px-2 py-2">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const isActive = item.id === active;
            const Icon = item.icon;
            const aria = item.count ? `${item.label}, ${item.count} pending` : item.label;
            return (
              <li key={item.id} className="group relative">
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={aria}
                  className={cn(
                    'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150 max-md:h-11',
                    rail && 'max-xl:justify-center max-xl:px-0',
                    isActive ? 'bg-hover font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  <Icon aria-hidden className={cn('h-4 w-4 shrink-0', isActive ? 'text-fg' : 'text-fg-subtle')} strokeWidth={1.5} />
                  <span className={cn('flex-1', rail && 'max-xl:sr-only')}>{item.label}</span>
                  {item.count ? (
                    <span aria-hidden className={cn('text-[12px] text-fg-muted tabular-nums', rail && 'max-xl:hidden')}>
                      {item.count}
                    </span>
                  ) : null}
                </Link>
                {rail && item.count ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-1 right-2 h-1.5 w-1.5 rounded-full bg-warning max-md:hidden xl:hidden"
                  />
                ) : null}
                {rail && (
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute top-1/2 left-full z-40 ml-2 -translate-y-1/2 rounded-md bg-primary px-2 py-1 text-[12px] font-medium whitespace-nowrap text-primary-fg opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 max-md:hidden xl:hidden"
                  >
                    {aria}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
