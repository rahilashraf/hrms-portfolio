import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREFERENCE_KEYS } from '../../lib/navigation/preferences';
import type { Workspace } from '../../lib/workspace/types';
import { ORGANIZATION_MODULES } from '../../lib/workspace/types';
import { WorkspaceProvider } from '../../providers/workspace-provider';
import { ToastProvider } from '../ui/toast';
import { AppShell } from './app-shell';

const useAuth = vi.hoisted(() => vi.fn());
vi.mock('../../providers/auth-provider', () => ({ useAuth }));
const replace = vi.hoisted(() => vi.fn());
const pathname = vi.hoisted(() => ({ value: '/dashboard' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname.value,
}));
const unreadCount = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notifications/api', () => ({ notificationsApi: { unreadCount } }));
const current = vi.hoisted(() => vi.fn());
vi.mock('../../lib/workspace/api', () => ({ workspaceApi: { current } }));

function authState({
  permissions = [] as string[],
  loading = false,
  scope = { type: 'ORGANIZATION', id: 'org-1' } as { type: string; id?: string },
} = {}) {
  return {
    status: 'authenticated',
    identity: { email: 'user@example.com' },
    authorizationLoading: loading,
    authorization: loading
      ? null
      : { permissions: permissions.map((key) => ({ key, scopes: [scope] })) },
    logout: vi.fn(async () => undefined),
    logoutAll: vi.fn(async () => undefined),
  };
}

function renderShell() {
  return render(
    <ToastProvider>
      <WorkspaceProvider>
        <AppShell>
          <h1>Page content</h1>
        </AppShell>
      </WorkspaceProvider>
    </ToastProvider>,
  );
}

const primary = () => screen.getByRole('navigation', { name: 'Primary' });

/** Fallback mode: GET /auth/me/workspace is unavailable. */
async function renderFallback(
  permissions: string[],
  options: { scope?: { type: string; id?: string } } = {},
) {
  cleanup();
  useAuth.mockReturnValue(authState({ permissions, ...options }));
  current.mockRejectedValue(new Error('unavailable'));
  renderShell();
  await waitFor(() =>
    expect(within(primary()).getByRole('link', { name: 'Home' })).toBeInTheDocument(),
  );
  return primary();
}

function workspace(
  overrides: Partial<Workspace['organizations'][number]>[] = [{}],
  systemPermissions: string[] = [],
): Workspace {
  return {
    user: { id: 'user-1', email: 'ada@example.com', displayName: 'Ada Lovelace' },
    systemPermissions,
    organizations: overrides.map((override, index) => ({
      id: `org-${index + 1}`,
      name: `Organization ${index + 1}`,
      code: `O${index + 1}`,
      timezone: null,
      branding: null,
      enabledModules: [...ORGANIZATION_MODULES],
      permissions: [],
      isEmployee: true,
      isManager: false,
      ...override,
    })),
  };
}

async function renderWorkspace(value: Workspace) {
  cleanup();
  useAuth.mockReturnValue(authState());
  current.mockResolvedValue(value);
  renderShell();
  await waitFor(() =>
    expect(within(primary()).getByRole('link', { name: 'Home' })).toBeInTheDocument(),
  );
  return primary();
}

beforeEach(() => {
  pathname.value = '/dashboard';
  unreadCount.mockResolvedValue({ unread: 0 });
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('AppShell fallback navigation (authorization snapshot)', () => {
  it('shows only entries allowed by the snapshot', async () => {
    const nav = await renderFallback(['role.read'], { scope: { type: 'SYSTEM' } });
    expect(within(nav).getByRole('link', { name: 'Roles & Permissions' })).toHaveAttribute(
      'href',
      '/admin/access-control/roles',
    );
    expect(within(nav).queryByRole('link', { name: 'Organization' })).not.toBeInTheDocument();
  });

  it('shows Employees for a scoped employee reader only', async () => {
    let nav = await renderFallback(['employee.read'], { scope: { type: 'TEAM', id: 'team-1' } });
    expect(within(nav).getByRole('link', { name: 'Employees' })).toHaveAttribute(
      'href',
      '/admin/employees',
    );
    nav = await renderFallback(['employee.manage']);
    expect(within(nav).queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
  });

  it('hides permission-gated entries while authorization is loading but keeps the bell', async () => {
    useAuth.mockReturnValue(authState({ loading: true }));
    current.mockRejectedValue(new Error('unavailable'));
    renderShell();
    await waitFor(() => expect(current).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'My Leave' })).not.toBeInTheDocument();
    // Batch 10A: one bell in the sidebar (desktop) and one in the header (below lg); CSS shows
    // exactly one of them, both link to the notification center.
    const bells = screen.getAllByRole('link', { name: 'Notifications' });
    expect(bells).toHaveLength(2);
    for (const bell of bells) expect(bell).toHaveAttribute('href', '/notifications');
    expect(screen.getByTestId('header-notifications')).toHaveClass('lg:hidden');
    expect(screen.getByTestId('header-notifications').closest('header')).not.toBeNull();
  });

  const operations: Array<{
    selfService: string;
    href: string;
    entry: string;
    entryHref: string;
    keys: string[];
    unrelated: string[];
  }> = [
    {
      selfService: 'My Leave',
      href: '/leave',
      entry: 'Requests',
      entryHref: '/admin/leave',
      keys: [
        'leave.read',
        'leave.approve',
        'leave.adjust',
        'leave.manage_policy',
        'holiday.manage',
      ],
      unrelated: ['leave.request'],
    },
    {
      selfService: 'My Time',
      href: '/time',
      entry: 'Attendance',
      entryHref: '/admin/time',
      keys: [
        'time.view',
        'time.approve',
        'time.correct',
        'time.timesheet.approve',
        'time.timesheet.manage',
        'time.manage_policy',
        'time.device.manage',
      ],
      unrelated: ['time.clock'],
    },
    {
      selfService: 'My Pay',
      href: '/pay',
      entry: 'Payroll',
      entryHref: '/admin/payroll',
      keys: [
        'payroll.read',
        'payroll.manage',
        'payroll.calculate',
        'payroll.approve',
        'payroll.finalize',
        'payroll.adjust',
      ],
      unrelated: ['compensation.manage', 'employee.manage'],
    },
    {
      selfService: 'My Compensation',
      href: '/compensation',
      entry: 'Compensation',
      entryHref: '/admin/compensation',
      keys: ['compensation.read', 'compensation.manage'],
      unrelated: ['payroll.manage'],
    },
    {
      selfService: 'My Benefits',
      href: '/benefits',
      entry: 'Benefits',
      entryHref: '/admin/benefits',
      keys: ['benefit.read', 'benefit.manage', 'benefit.plan.manage'],
      unrelated: ['payroll.manage', 'employee.manage'],
    },
    {
      selfService: 'My Performance',
      href: '/performance',
      entry: 'Performance',
      entryHref: '/admin/performance',
      keys: [
        'performance.read',
        'performance.manage',
        'performance.template.manage',
        'performance.cycle.manage',
        'performance.evidence.manage',
      ],
      unrelated: ['employee.manage', 'benefit.manage'],
    },
    {
      selfService: 'My Interviews',
      href: '/interviews',
      entry: 'Recruitment',
      entryHref: '/admin/recruitment',
      keys: [
        'recruitment.read',
        'recruitment.manage',
        'recruitment.offer.approve',
        'recruitment.hire',
        'recruitment.pipeline.manage',
        'recruitment.intake.manage',
      ],
      unrelated: ['employee.manage', 'performance.manage'],
    },
    {
      selfService: 'My Onboarding',
      href: '/onboarding',
      entry: 'Onboarding',
      entryHref: '/admin/onboarding',
      keys: [
        'onboarding.read',
        'onboarding.manage',
        'offboarding.read',
        'offboarding.manage',
        'onboarding.template.manage',
      ],
      unrelated: ['employee.manage', 'recruitment.hire'],
    },
    {
      selfService: 'My Documents',
      href: '/documents',
      entry: 'Document Records',
      entryHref: '/admin/documents',
      keys: [
        'document.read',
        'document.confidential.read',
        'document.restricted.read',
        'document.manage',
        'document.type.manage',
        'document.policy.manage',
      ],
      unrelated: ['employee.read', 'onboarding.manage'],
    },
  ];

  it.each(operations)(
    'always links $selfService and gates $entry on its permissions',
    async (item) => {
      let nav = await renderFallback(item.unrelated);
      expect(within(nav).getByRole('link', { name: item.selfService })).toHaveAttribute(
        'href',
        item.href,
      );
      expect(within(nav).queryByRole('link', { name: item.entry })).not.toBeInTheDocument();
      for (const key of item.keys) {
        nav = await renderFallback([key], { scope: { type: 'TEAM', id: 'team-1' } });
        expect(
          within(nav).getByRole('link', { name: item.entry }),
          `${item.entry} for ${key}`,
        ).toHaveAttribute('href', item.entryHref);
      }
    },
    20_000,
  );

  const administration: Array<{
    entry: string;
    href: string;
    keys: string[];
    unrelated: string[];
  }> = [
    {
      entry: 'Notification Settings',
      href: '/admin/notifications',
      keys: ['notification.template.manage', 'notification.settings.manage'],
      unrelated: ['document.manage', 'onboarding.template.manage'],
    },
    {
      entry: 'Integrations',
      href: '/settings/integrations/google',
      keys: ['integration.google.read', 'integration.google.manage'],
      unrelated: ['notification.settings.manage', 'document.manage'],
    },
    {
      entry: 'Reports',
      href: '/reports',
      keys: ['report.read'],
      unrelated: ['report.export', 'employee.read', 'payroll.read'],
    },
    {
      entry: 'Features',
      href: '/admin/settings',
      keys: ['feature.read', 'feature.manage'],
      unrelated: ['organization.manage', 'audit.read'],
    },
    {
      entry: 'Audit Log',
      href: '/admin/audit',
      keys: ['audit.read'],
      unrelated: ['feature.manage', 'organization.read', 'role.read'],
    },
    {
      entry: 'Organization',
      href: '/admin/organizations',
      keys: ['organization.read'],
      unrelated: ['employee.read'],
    },
  ];

  it.each(administration)(
    'gates $entry on its permissions',
    async (item) => {
      let nav = await renderFallback(item.unrelated);
      expect(within(nav).queryByRole('link', { name: item.entry })).not.toBeInTheDocument();
      for (const key of item.keys) {
        nav = await renderFallback([key], { scope: { type: 'DEPARTMENT', id: 'dept-1' } });
        expect(within(nav).getByRole('link', { name: item.entry })).toHaveAttribute(
          'href',
          item.href,
        );
      }
    },
    20_000,
  );

  it('hides organization-specific entries without a workspace organization', async () => {
    const nav = await renderFallback([
      'organization.read',
      'organization.manage',
      'organization.branding.manage',
    ]);
    expect(within(nav).queryByRole('link', { name: 'Positions' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Company Settings' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Branding' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Switch organization')).not.toBeInTheDocument();
  });
});

describe('AppShell workspace navigation', () => {
  it('shows a restricted employee only self-service', async () => {
    const nav = await renderWorkspace(
      workspace([{ permissions: ['leave.request', 'time.clock'] }]),
    );
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(links).toEqual([
      'Home',
      'My Profile',
      'My Time',
      'My Schedule',
      'My Leave',
      'My Pay',
      'My Compensation',
      'My Benefits',
      'My Performance',
      'My Interviews',
      'My Onboarding',
      'My Documents',
    ]);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('hides entries for disabled modules', async () => {
    const nav = await renderWorkspace(
      workspace([{ permissions: ['payroll.read'], enabledModules: ['LEAVE'] }]),
    );
    expect(within(nav).queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'My Pay' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'My Leave' })).toBeInTheDocument();
  });

  it('switches organization, persists the choice and re-filters navigation', async () => {
    const nav = await renderWorkspace(
      workspace([
        { name: 'Northwind Academy', permissions: ['payroll.read'] },
        {
          name: 'Lakeside Camp',
          permissions: ['recruitment.read'],
          branding: {
            displayName: 'Lakeside',
            shortName: 'Lake',
            logoUrl: null,
            iconUrl: null,
            primaryColor: '#0f766e',
            secondaryColor: null,
          },
        },
      ]),
    );
    expect(within(nav).getByRole('link', { name: 'Payroll' })).toBeInTheDocument();
    const select = screen.getByLabelText('Switch organization');
    expect(within(select).getByRole('option', { name: 'Lake' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'org-2' } });
    expect(within(primary()).queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument();
    expect(within(primary()).getByRole('link', { name: 'Recruitment' })).toBeInTheDocument();
    expect(window.localStorage.getItem(PREFERENCE_KEYS.organization)).toBe('org-2');
    expect(await screen.findByText('Switched to Lake.')).toBeInTheDocument();

    // A new session restores the persisted organization.
    await renderWorkspace(
      workspace([
        { name: 'Northwind Academy', permissions: ['payroll.read'] },
        { name: 'Lakeside Camp', permissions: ['recruitment.read'] },
      ]),
    );
    expect(screen.getByLabelText('Switch organization')).toHaveValue('org-2');
  });

  it('marks the active entry, including nested routes', async () => {
    pathname.value = '/admin/payroll/runs/run-1';
    const nav = await renderWorkspace(workspace([{ permissions: ['payroll.read'] }]));
    expect(within(nav).getByRole('link', { name: 'Payroll' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Payroll' })).toHaveAttribute(
      'href',
      '/admin/payroll',
    );
    expect(within(crumbs).getByText('Payroll run')).toHaveAttribute('aria-current', 'page');
  });
});

describe('AppShell sidebar behaviour', () => {
  const admin = () =>
    workspace([
      { permissions: ['payroll.read', 'compensation.read', 'employee.read', 'audit.read'] },
    ]);

  it('collapses and expands groups, persisting the choice', async () => {
    await renderWorkspace(admin());
    const toggle = within(primary()).getByRole('button', { name: 'Pay' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'nav-group-pay');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(primary()).queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(PREFERENCE_KEYS.collapsedGroups)!)).toEqual([
      'pay',
    ]);

    await renderWorkspace(admin());
    expect(within(primary()).getByRole('button', { name: 'Pay' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens the group holding the current page even when it was collapsed', async () => {
    window.localStorage.setItem(PREFERENCE_KEYS.collapsedGroups, JSON.stringify(['pay']));
    pathname.value = '/admin/payroll';
    await renderWorkspace(admin());
    expect(within(primary()).getByRole('button', { name: 'Pay' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('collapses to icons with accessible names and tooltips, and remembers it', async () => {
    await renderWorkspace(admin());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    const payroll = within(primary()).getByRole('link', { name: 'Payroll' });
    expect(payroll).toHaveAttribute('aria-label', 'Payroll');
    expect(payroll).toHaveAttribute('title', 'Payroll');
    expect(within(primary()).queryByRole('button', { name: 'Pay' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(window.localStorage.getItem(PREFERENCE_KEYS.collapsed)).toBe('1');

    await renderWorkspace(admin());
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(window.localStorage.getItem(PREFERENCE_KEYS.collapsed)).toBe('0');
  });

  it('supports arrow-key navigation and group toggling from the keyboard', async () => {
    await renderWorkspace(admin());
    const nav = primary();
    const home = within(nav).getByRole('link', { name: 'Home' });
    home.focus();
    fireEvent.keyDown(home, { key: 'ArrowDown' });
    const people = within(nav).getByRole('button', { name: 'People' });
    expect(people).toHaveFocus();
    fireEvent.keyDown(people, { key: 'ArrowLeft' });
    expect(people).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(people, { key: 'ArrowRight' });
    expect(people).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(people, { key: 'ArrowRight' });
    // Self-service entries lead each group.
    const myProfile = within(nav).getByRole('link', { name: 'My Profile' });
    expect(myProfile).toHaveFocus();
    fireEvent.keyDown(myProfile, { key: 'ArrowLeft' });
    expect(people).toHaveFocus();
    fireEvent.keyDown(people, { key: 'End' });
    expect(within(nav).getByRole('link', { name: 'Audit Log' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(home).toHaveFocus();
    fireEvent.keyDown(home, { key: 'ArrowUp' });
    expect(within(nav).getByRole('link', { name: 'Audit Log' })).toHaveFocus();
  });

  it('opens a focus-trapped mobile drawer that closes on Escape, backdrop and navigation', async () => {
    await renderWorkspace(admin());
    const open = screen.getByRole('button', { name: 'Open navigation' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = within(dialog).getByRole('button', { name: 'Close navigation' });
    await waitFor(() => expect(close).toHaveFocus());
    // The page behind the drawer is inert, and stops being inert when it closes.
    const content = screen.getByRole('main').parentElement!;
    expect(content).toHaveAttribute('inert');
    // Tab wraps within the drawer in both directions.
    const first = within(dialog).getByRole('link', { name: / home$/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('button', { name: 'Sign out all' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(open).toHaveFocus());
    expect(content).not.toHaveAttribute('inert');

    fireEvent.click(open);
    fireEvent.click(await screen.findByTestId('drawer-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(open);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Payroll' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clears the URL watcher a sidebar link starts once the shell unmounts (R4-A)', async () => {
    await renderWorkspace(admin());
    const started: unknown[] = [];
    const cleared = new Set<unknown>();
    // In this environment window is the global object: keep the real timers before spying.
    const realSetInterval = window.setInterval.bind(window);
    const realClearInterval = window.clearInterval.bind(window);
    const setInterval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    setInterval.mockImplementation(((handler: () => void, ms?: number) => {
      const id = realSetInterval(handler, ms);
      started.push(id);
      return id;
    }) as typeof window.setInterval);
    clearInterval.mockImplementation(((id?: number) => {
      cleared.add(id);
      realClearInterval(id);
    }) as typeof window.clearInterval);
    // jsdom never commits the navigation, so the watcher would poll for 2 s.
    fireEvent.click(screen.getByRole('link', { name: 'Payroll' }));
    expect(started).toHaveLength(1);
    expect(cleared.has(started[0])).toBe(false);
    cleanup();
    expect(cleared.has(started[0])).toBe(true);
  });

  it('has a skip link, banner, navigation and main landmarks', async () => {
    await renderWorkspace(admin());
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(
      within(screen.getByRole('main')).getByRole('heading', { name: 'Page content' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('banner')).toContainElement(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    );
  });

  it('signs out and returns to the login page', async () => {
    await renderWorkspace(admin());
    const state = useAuth.mock.results.at(-1)!.value as ReturnType<typeof authState>;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    expect(state.logout).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/login');
  });
});

describe('AppShell branding', () => {
  const branded = (branding: Workspace['organizations'][number]['branding']) =>
    workspace([{ name: 'Northwind Academy', branding }]);

  it('uses the selected organization logo, name and accent colors', async () => {
    await renderWorkspace(
      branded({
        displayName: 'Northwind',
        shortName: 'NWA',
        logoUrl: 'https://cdn.example.com/logo.png',
        iconUrl: null,
        primaryColor: '#0F766E',
        secondaryColor: '#F59E0B',
      }),
    );
    const home = screen.getByRole('link', { name: 'Northwind home' });
    const logo = within(home).getByAltText('Northwind logo');
    expect(logo).toHaveAttribute('src', 'https://cdn.example.com/logo.png');
    expect(logo).toHaveAttribute('referrerpolicy', 'no-referrer');
    const root = screen.getByRole('main').parentElement!.parentElement!;
    expect(root.style.getPropertyValue('--hrms-accent')).toBe('#0F766E');
    expect(root.style.getPropertyValue('--hrms-on-accent')).toBe('#FFFFFF');
    expect(root).toHaveAttribute('data-branded');
    await waitFor(() => expect(document.title).toBe('Home · NWA'));
  });

  it('keeps the default palette when the brand color has poor contrast, and shows the name without a logo', async () => {
    await renderWorkspace(
      branded({
        displayName: 'Northwind',
        shortName: 'NWA',
        logoUrl: null,
        iconUrl: null,
        primaryColor: '#777777',
        secondaryColor: null,
      }),
    );
    const home = screen.getByRole('link', { name: 'Northwind home' });
    expect(within(home).queryByRole('img')).not.toBeInTheDocument();
    expect(home).toHaveTextContent('NWA');
    const root = screen.getByRole('main').parentElement!.parentElement!;
    expect(root.style.getPropertyValue('--hrms-accent')).toBe('#4338CA');
    expect(root).not.toHaveAttribute('data-branded');
  });

  it('falls back to the organization name, then HRMS, in the title', async () => {
    pathname.value = '/admin/audit';
    await renderWorkspace(workspace([{ name: 'Lakeside Camp', permissions: ['audit.read'] }]));
    await waitFor(() => expect(document.title).toBe('Audit Log · Lakeside Camp'));
    expect(screen.getByRole('link', { name: 'Lakeside Camp home' })).toBeInTheDocument();
    await renderFallback(['audit.read'], { scope: { type: 'SYSTEM' } });
    await waitFor(() => expect(document.title).toBe('Audit Log · HRMS'));
    expect(screen.getByRole('link', { name: 'HRMS home' })).toBeInTheDocument();
  });
});
