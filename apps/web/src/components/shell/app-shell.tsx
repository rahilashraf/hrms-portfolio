'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  readCollapsed,
  readCollapsedGroups,
  writeCollapsed,
  writeCollapsedGroups,
} from '../../lib/navigation/preferences';
import {
  activeNavItem,
  breadcrumbsFor,
  parentGroup,
  visibleNavigation,
} from '../../lib/navigation/registry';
import {
  LocationChangeNotifierContext,
  useLocationHash,
  useOwnedLocationChangeNotifier,
} from '../../lib/navigation/use-location-hash';
import { accentPalette, accentStyle } from '../../lib/branding/color';
import { isSafeHttpsUrl } from '../../lib/branding/validation';
import type { WorkspaceOrganization } from '../../lib/workspace/types';
import { useAuth } from '../../providers/auth-provider';
import { useWorkspace } from '../../providers/workspace-provider';
import { trapTab } from '../ui/focus';
import { useToast } from '../ui/toast';
import { useConfirm } from '../ui/use-confirm';
import { Breadcrumbs } from './breadcrumbs';
import { NotificationBell } from '../notifications/notification-bell';
import { Icon } from './icons';
import { OrganizationSwitcher, organizationDisplayName } from './organization-switcher';
import { SidebarNavigation } from './sidebar';
import { UserPanel } from './user-panel';
import { useDocumentTitle } from '../ui/use-document-title';

const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * Phase 20 — the authenticated application shell: skip link, grouped sidebar (collapsible to
 * icons on desktop, a focus-trapped drawer on small screens), organization switcher, profile
 * controls, breadcrumbs and the main landmark.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { identity, logout, logoutAll } = useAuth();
  const { status, workspace, organizations, selectedOrganization, selectOrganization, navContext } =
    useWorkspace();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const hash = useLocationHash();

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(readCollapsedGroups() ?? []),
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  // R4-A: the shell (mounted across navigations) owns the URL watcher of the sidebar links and,
  // through the context below, of links inside the page that leave it.
  const notifyLocationChange = useOwnedLocationChangeNotifier();
  const [signingOut, setSigningOut] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  const tree = useMemo(() => (navContext ? visibleNavigation(navContext) : []), [navContext]);
  const active = useMemo(() => activeNavItem(tree, pathname, hash), [tree, pathname, hash]);
  const crumbs = useMemo(() => breadcrumbsFor(tree, pathname, hash), [tree, pathname, hash]);
  const activeGroupId = active ? (parentGroup(tree, active.id)?.id ?? null) : null;
  const branding = selectedOrganization?.branding ?? null;
  const palette = useMemo(
    () => accentPalette(branding?.primaryColor, branding?.secondaryColor),
    [branding?.primaryColor, branding?.secondaryColor],
  );
  const pageTitle = crumbs.at(-1)?.label ?? null;
  const brandName = selectedOrganization ? brandTitleName(selectedOrganization) : null;

  // "<page> · <organization short name or display name>" (fallback "HRMS").
  useDocumentTitle(documentTitle(pageTitle, brandName));

  const setGroupExpanded = useCallback((groupId: string, expanded: boolean) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (expanded) next.delete(groupId);
      else next.add(groupId);
      writeCollapsedGroups([...next]);
      return next;
    });
  }, []);

  // Landing on a page inside a collapsed group opens that group (state adjusted during render).
  const [revealedGroup, setRevealedGroup] = useState<string | null>(null);
  if (activeGroupId !== revealedGroup) {
    setRevealedGroup(activeGroupId);
    if (activeGroupId && collapsedGroups.has(activeGroupId)) {
      const next = new Set(collapsedGroups);
      next.delete(activeGroupId);
      setCollapsedGroups(next);
      writeCollapsedGroups([...next]);
    }
  }

  // The drawer closes on navigation…
  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    if (mobileOpen) setMobileOpen(false);
  }

  // …and when the viewport grows to the desktop layout.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => query.matches && setMobileOpen(false);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (mobileOpen) {
      sidebar.current?.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
    } else if (wasOpen.current) {
      menuButton.current?.focus();
    }
    wasOpen.current = mobileOpen;
  }, [mobileOpen]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      writeCollapsed(!current);
      return !current;
    });
  }

  async function signOut(action: () => Promise<void>) {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await action();
    } catch {
      // Local auth is cleared even when the server cannot be reached.
    } finally {
      router.replace('/login');
    }
  }

  function switchOrganization(organizationId: string) {
    selectOrganization(organizationId);
    const organization = organizations.find((item) => item.id === organizationId);
    if (organization) toast.notify(`Switched to ${organizationDisplayName(organization)}.`, 'info');
  }

  const iconOnly = collapsed && !mobileOpen;
  const displayName = workspace?.user.displayName || identity?.email || '';
  const email = workspace?.user.email || identity?.email || '';

  return (
    <div
      className="flex min-h-screen w-full flex-1 bg-slate-50"
      style={accentStyle(palette) as CSSProperties}
      data-branded={palette.branded ? '' : undefined}
    >
      <a
        href="#main-content"
        className="sr-only z-[80] rounded-lg bg-[var(--hrms-accent)] px-4 py-2 text-sm font-semibold text-[var(--hrms-on-accent)] focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      {mobileOpen && (
        <div
          aria-hidden="true"
          data-testid="drawer-backdrop"
          className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        id="app-sidebar"
        ref={sidebar}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? 'Navigation' : undefined}
        onKeyDown={(event) => {
          if (!mobileOpen) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            setMobileOpen(false);
            return;
          }
          if (sidebar.current) trapTab(event, sidebar.current);
        }}
        className={`flex-col border-r border-slate-200 bg-white ${
          mobileOpen
            ? 'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] shadow-xl'
            : `hidden lg:sticky lg:top-0 lg:flex lg:h-screen ${iconOnly ? 'lg:w-16' : 'lg:w-64'}`
        }`}
      >
        <div className={`flex items-center gap-2 py-4 ${iconOnly ? 'flex-col px-2' : 'px-4'}`}>
          <BrandHomeLink organization={selectedOrganization} iconOnly={iconOnly} />
          <span className="flex-1" />
          {mobileOpen ? (
            <button
              type="button"
              data-drawer-close=""
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
            >
              <Icon name="close" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed={collapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={toggleCollapsed}
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
            >
              <Icon name={collapsed ? 'expand' : 'collapse'} />
            </button>
          )}
        </div>
        {status === 'ready' && (
          <OrganizationSwitcher
            organizations={organizations}
            selected={selectedOrganization}
            collapsed={iconOnly}
            onSelect={switchOrganization}
          />
        )}
        <SidebarNavigation
          tree={tree}
          activeId={active?.id ?? null}
          collapsed={iconOnly}
          collapsedGroups={collapsedGroups}
          onToggleGroup={setGroupExpanded}
          onNavigate={() => {
            notifyLocationChange();
            setMobileOpen(false);
          }}
          loading={navContext === null}
        />
        {confirmDialog}
        <UserPanel
          name={displayName}
          email={email}
          collapsed={iconOnly}
          busy={signingOut}
          onSignOut={() => void signOut(logout)}
          onSignOutAll={() =>
            void confirm({
              title: 'Sign out everywhere?',
              description:
                'Every session of your account, on this and every other device, will end.',
              confirmLabel: 'Sign out everywhere',
              destructive: true,
            }).then((ok) => {
              if (ok) void signOut(logoutAll);
            })
          }
        />
      </aside>
      {/* While the mobile navigation is open, the page behind it is inert (not focusable or read). */}
      <div className="flex min-w-0 flex-1 flex-col" inert={mobileOpen}>
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-6">
            <button
              ref={menuButton}
              type="button"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              aria-controls="app-sidebar"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-1.5 text-slate-700 hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] lg:hidden"
            >
              <Icon name="menu" />
            </button>
            <Breadcrumbs crumbs={crumbs} />
            {/* Batch 10A: on small screens the bell sits in the header (the sidebar's bell is in
                the closed drawer there); on large screens this one is not displayed — exactly one
                bell is visible, focusable and announced at a time. */}
            <div data-testid="header-notifications" className="ml-auto shrink-0 lg:hidden">
              <NotificationBell />
            </div>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          <LocationChangeNotifierContext.Provider value={notifyLocationChange}>
            {children}
          </LocationChangeNotifierContext.Provider>
        </main>
      </div>
    </div>
  );
}

/** The organization name used in titles: short name, else display name, else its name. */
export function brandTitleName(organization: WorkspaceOrganization): string {
  return (
    organization.branding?.shortName || organization.branding?.displayName || organization.name
  );
}

export function documentTitle(page: string | null, brand: string | null): string {
  const suffix = brand || 'HRMS';
  return page ? `${page} · ${suffix}` : suffix;
}

/**
 * The sidebar header: the selected organization's logo (or icon when collapsed) from https
 * references only, else its name; generic "HRMS" without an organization.
 */
function BrandHomeLink({
  organization,
  iconOnly,
}: {
  organization: WorkspaceOrganization | null;
  iconOnly: boolean;
}) {
  const branding = organization?.branding ?? null;
  const name = organization
    ? branding?.displayName || branding?.shortName || organization.name
    : 'HRMS';
  const shortName = organization ? brandTitleName(organization) : 'HRMS';
  const image = iconOnly
    ? (branding?.iconUrl ?? null)
    : (branding?.logoUrl ?? branding?.iconUrl ?? null);
  const safeImage = isSafeHttpsUrl(image) ? image : null;
  return (
    <Link
      href="/dashboard"
      aria-label={`${name} home`}
      className="flex min-w-0 items-center gap-2 rounded font-semibold tracking-wide text-[var(--hrms-accent-text)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
    >
      {safeImage ? (
        // Branding images are external https references chosen by administrators.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={safeImage}
          alt={`${name} logo`}
          referrerPolicy="no-referrer"
          className={iconOnly ? 'size-8 rounded object-contain' : 'h-8 max-w-[9rem] object-contain'}
        />
      ) : (
        <span className="truncate">
          {iconOnly ? shortName.slice(0, 1).toUpperCase() : shortName}
        </span>
      )}
    </Link>
  );
}
