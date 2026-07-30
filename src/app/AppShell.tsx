/**
 * Global application shell — specification section 8.
 *
 * Desktop: left sidebar + top header + main content.
 * Mobile:  compact top app bar + bottom navigation, large touch targets.
 */

import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { isAdministrator } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthContext';
import { apiRequest } from '@/services/api';
import { Badge, Button, Dialog } from '@/components/ui';
import {
  ClipboardCheckIcon,
  CloseIcon,
  MenuIcon,
  ScrollTextIcon,
  SettingsIcon,
  UsersIcon,
  type IconProps,
} from '@/components/icons';
import type { StatusTone } from '@/domain/status';

interface NavigationItem {
  to: string;
  label: string;
  Icon: (props: IconProps) => React.JSX.Element;
  adminOnly?: boolean;
}

const NAVIGATION: NavigationItem[] = [
  // Dashboard, Active Rechecks and History were merged into this one
  // destination — see RechecksPage.
  { to: '/app/rechecks', label: 'Rechecks', Icon: ClipboardCheckIcon },
  { to: '/app/admin/users', label: 'Users', Icon: UsersIcon, adminOnly: true },
  { to: '/app/admin/settings/general', label: 'Settings', Icon: SettingsIcon, adminOnly: true },
  { to: '/app/admin/audit-log', label: 'Audit Log', Icon: ScrollTextIcon, adminOnly: true },
];

/* -------------------------------------------------- connection indicator -- */

interface ZohoStatus {
  state: 'connected' | 'authentication_required' | 'configuration_incomplete' | 'unavailable';
  mockMode: boolean;
  organizationName: string | null;
  lastSuccessAt: string | null;
}

const CONNECTION_PRESENTATION: Record<
  ZohoStatus['state'],
  { label: string; tone: StatusTone; detail: string }
> = {
  connected: {
    label: 'Connected',
    tone: 'success',
    detail: 'Zoho Books is reachable and responding to read requests.',
  },
  authentication_required: {
    label: 'Authentication required',
    tone: 'danger',
    detail: 'Zoho rejected the stored credentials. An administrator must reconnect Zoho.',
  },
  configuration_incomplete: {
    label: 'Configuration incomplete',
    tone: 'warning',
    detail: 'Zoho is not connected yet. Imports are unavailable until an administrator connects it.',
  },
  unavailable: {
    label: 'Zoho unavailable',
    tone: 'danger',
    detail: 'Zoho could not be reached. Counting continues; new imports will fail.',
  },
};

function ConnectionHealth(): React.JSX.Element {
  const [panelOpen, setPanelOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['zoho', 'status'],
    queryFn: () => apiRequest<ZohoStatus>('/api/zoho/status'),
    staleTime: 30_000,
  });

  const presentation =
    data === undefined
      ? { label: isLoading ? 'Checking…' : 'Unknown', tone: 'muted' as StatusTone, detail: '' }
      : CONNECTION_PRESENTATION[data.state];

  return (
    <>
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className="min-h-[36px] rounded-full"
        aria-label={`Zoho connection: ${presentation.label}. Open status panel.`}
      >
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
      </button>

      {/* Section 8.4: the panel must never expose tokens or secrets. */}
      <Dialog
        open={panelOpen}
        title="Zoho connection"
        onClose={() => setPanelOpen(false)}
        footer={
          <Button variant="primary" onClick={() => setPanelOpen(false)}>
            Close
          </Button>
        }
      >
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Status</dt>
            <dd className="mt-1">
              <Badge tone={presentation.tone}>{presentation.label}</Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Organization</dt>
            <dd className="mt-1">{data?.organizationName ?? 'Not available'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Last successful call</dt>
            <dd className="mt-1">
              {data?.lastSuccessAt === null || data?.lastSuccessAt === undefined
                ? 'No successful call recorded yet'
                : new Date(data.lastSuccessAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Access</dt>
            <dd className="mt-1">Read-only. This application never writes to Zoho Books.</dd>
          </div>
          {data?.mockMode === true && (
            <div>
              <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Mode</dt>
              <dd className="mt-1">
                <Badge tone="warning">Mock data</Badge>
                <span className="mt-1 block text-xs text-[var(--color-ink-subtle)]">
                  Local mock inventory is in use. Do not use this mode in production.
                </span>
              </dd>
            </div>
          )}
          <p className="border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-ink-subtle)]">
            {presentation.detail}
          </p>
        </dl>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------- page title */

const TITLE_BY_PREFIX: [string, string][] = [
  ['/app/rechecks/new', 'Create Stock Recheck'],
  ['/app/rechecks', 'Stock Rechecks'],
  ['/app/admin/users', 'Users'],
  ['/app/admin/settings', 'Settings'],
  ['/app/admin/audit-log', 'Audit Log'],
  ['/app/profile', 'Profile'],
];

function usePageTitle(): string {
  const { pathname } = useLocation();
  const match = TITLE_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix));
  return match?.[1] ?? 'Stock Recheck';
}

/* ------------------------------------------------------------------ shell */

export function AppShell(): React.JSX.Element {
  const { user, settings, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const pageTitle = usePageTitle();
  const location = useLocation();

  // Keep the browser tab title in sync for screen readers and tab switching.
  useEffect(() => {
    document.title = `${pageTitle} · ${settings?.businessName ?? 'Stock Recheck'}`;
  }, [pageTitle, settings?.businessName]);

  // Close the slide-out whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const isAdmin = user !== null && isAdministrator(user.role);
  const visibleNavigation = NAVIGATION.filter((item) => item.adminOnly !== true || isAdmin);

  return (
    <div className="min-h-dvh bg-[var(--color-surface-sunken)]">
      <a
        href="#main-content"
        className="sr-only-focusable absolute left-4 top-4 z-[70] rounded bg-[var(--color-brand)] px-4 py-2 text-white"
      >
        Skip to main content
      </a>

      {/* ------------------------------------------------ desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:flex">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-4">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-brand-subtle)] text-[var(--color-brand)]"
          >
            <ClipboardCheckIcon size={18} />
          </span>
          <span className="font-semibold">{settings?.businessName ?? 'Stock Recheck'}</span>
        </div>
        <nav aria-label="Main" className="flex-1 space-y-1 p-3">
          {visibleNavigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  'flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--color-brand-subtle)] text-[var(--color-brand)]'
                    : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]',
                )
              }
            >
              <item.Icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[var(--color-border)] p-3 text-xs text-[var(--color-ink-subtle)]">
          Zoho is read-only. No inventory data is ever updated.
        </div>
      </aside>

      <div className="lg:pl-60">
        {/* ------------------------------------------------- top header */}
        <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg lg:hidden"
              aria-label="Open navigation menu"
              aria-expanded={menuOpen}
            >
              <MenuIcon size={20} />
            </button>

            <h1 className="flex-1 truncate text-base font-semibold sm:text-lg">{pageTitle}</h1>

            <div className="hidden items-center gap-3 sm:flex">
              <ConnectionHealth />
            </div>

            <NavLink
              to="/app/profile"
              className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm hover:bg-[var(--color-surface-raised)]"
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-brand-subtle)] text-xs font-semibold text-[var(--color-brand)]"
              >
                {user?.displayName.slice(0, 2).toUpperCase() ?? '··'}
              </span>
              <span className="hidden text-left md:block">
                <span className="block leading-tight">{user?.displayName}</span>
                <span className="block text-xs leading-tight text-[var(--color-ink-subtle)]">
                  {user?.role === 'administrator' ? 'Administrator' : 'Counter'}
                </span>
              </span>
            </NavLink>

            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>

          <div className="border-t border-[var(--color-border)] px-4 py-2 sm:hidden">
            <ConnectionHealth />
          </div>
        </header>

        <main id="main-content" className="px-4 py-5 pb-24 lg:pb-8">
          <Outlet />
        </main>
      </div>

      {/* --------------------------------------------- mobile slide-out */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 lg:hidden"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMenuOpen(false);
          }}
        >
          <nav
            aria-label="Main"
            className="h-full w-72 max-w-[85vw] bg-[var(--color-surface)] p-4"
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="font-semibold">{settings?.businessName ?? 'Stock Recheck'}</span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close navigation menu"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg"
              >
                <CloseIcon size={18} />
              </button>
            </div>
            <div className="space-y-1">
              {visibleNavigation.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    clsx(
                      'flex min-h-[48px] items-center gap-3 rounded-lg px-3 text-sm font-medium',
                      isActive
                        ? 'bg-[var(--color-brand-subtle)] text-[var(--color-brand)]'
                        : 'text-[var(--color-ink-muted)]',
                    )
                  }
                >
                  <item.Icon size={18} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          </nav>
        </div>
      )}

      {/* ------------------------------------------ mobile bottom nav bar */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-border)] bg-[var(--color-surface)] lg:hidden"
      >
        {visibleNavigation.slice(0, 4).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              clsx(
                'flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-xs',
                isActive ? 'text-[var(--color-brand)]' : 'text-[var(--color-ink-subtle)]',
              )
            }
          >
            <item.Icon size={19} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
