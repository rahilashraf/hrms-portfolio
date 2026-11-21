import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navContextFromWorkspace } from '../../lib/navigation/context';
import { parseDashboard } from '../../lib/dashboard/api';
import type { Workspace } from '../../lib/workspace/types';
import { DashboardPage } from './dashboard-page';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth/api-client', () => ({ apiRequest }));
const identity = {
  id: 'user-1',
  personId: 'person-1',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ identity }) }));
const workspaceValue = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../providers/workspace-provider', () => ({
  useOptionalWorkspace: () => workspaceValue.current,
  useWorkspace: () => workspaceValue.current,
}));

function setWorkspace(
  permissions: string[],
  isEmployee: boolean,
  modules = ['ATTENDANCE', 'LEAVE'],
) {
  const workspace: Workspace = {
    user: { id: 'user-1', email: 'ada@example.com', displayName: 'Ada Lovelace' },
    systemPermissions: [],
    organizations: [
      {
        id: 'org-1',
        name: 'Northwind Academy',
        code: 'NWA',
        timezone: 'America/Toronto',
        branding: null,
        enabledModules: modules as Workspace['organizations'][number]['enabledModules'],
        permissions,
        isEmployee,
        isManager: false,
      },
    ],
  };
  workspaceValue.current = {
    status: 'ready',
    workspace,
    organizations: workspace.organizations,
    selectedOrganization: workspace.organizations[0],
    navContext: navContextFromWorkspace(workspace, workspace.organizations[0]!),
  };
}

const EMPLOYEE_DASHBOARD = {
  organizationId: 'org-1',
  cards: [],
  self: {
    employeeId: 'employee-1',
    todayShifts: 1,
    leaveBalances: [
      { leaveTypeId: 'vac', name: 'Vacation', availableMinutes: 2400, pendingMinutes: 480 },
    ],
    policyAcknowledgementsDue: 2,
    selfReviewsDue: null,
    reviewsToWrite: null,
    openGoals: null,
  },
  quickActions: [],
};

const ADMIN_DASHBOARD = {
  organizationId: 'org-1',
  cards: [
    {
      key: 'activeEmployees',
      label: 'Active employees',
      value: 42,
      href: '/admin/employees',
      area: 'People',
    },
    {
      key: 'pendingLeaveApprovals',
      label: 'Leave requests to approve',
      value: 3,
      href: '/admin/leave',
      area: 'Leave',
    },
    // Malformed / unsafe entries are dropped.
    { key: 'bad', label: 'External', value: 1, href: 'https://evil.example.com', area: 'X' },
    { key: 'noValue', label: 'No value', href: '/admin/x' },
  ],
  self: null,
  quickActions: [
    { key: 'addEmployee', label: 'Add employee', href: '/admin/employees/new' },
    { key: 'reviewLeave', label: 'Review leave requests', href: '/admin/leave' },
  ],
};

function respond(dashboard: unknown, setup: unknown = { organizationId: 'org-1', steps: [] }) {
  apiRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/dashboard')) return dashboard;
    if (path.endsWith('/setup')) return setup;
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('DashboardPage', () => {
  it('shows an employee their self-service section and My Time, with nothing invented', async () => {
    setWorkspace(['leave.request', 'time.clock'], true);
    respond(EMPLOYEE_DASHBOARD);
    render(<DashboardPage />);
    expect(screen.getByRole('heading', { name: 'Welcome, Ada' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'My work' })).toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledWith('/dashboard?organizationId=org-1');
    expect(screen.getByText("Today's shifts").nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Policies to acknowledge')).toBeInTheDocument();
    expect(screen.getByText('Vacation')).toBeInTheDocument();
    expect(screen.getByText('40h')).toBeInTheDocument();
    expect(screen.getByText('8h pending')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to My Time' })).toHaveAttribute('href', '/time');
    // Performance is off (null): no review stats.
    expect(screen.queryByText('Self-reviews due')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Quick actions' })).not.toBeInTheDocument();
    // No organization.read/manage: no setup checklist request.
    expect(apiRequest).not.toHaveBeenCalledWith('/organizations/org-1/setup');
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('shows an administrator only the cards and quick actions the API returned, plus setup', async () => {
    setWorkspace(['employee.read', 'employee.manage', 'leave.approve', 'organization.read'], false);
    respond(ADMIN_DASHBOARD, {
      organizationId: 'org-1',
      steps: [
        {
          key: 'company',
          label: 'Company details',
          description: '',
          complete: false,
          optional: false,
          href: '/admin/settings/company',
          detail: null,
        },
      ],
    });
    render(<DashboardPage />);
    const overview = (await screen.findByRole('heading', { name: 'Overview' })).parentElement!;
    const cards = within(overview).getAllByRole('link');
    expect(cards.map((card) => card.getAttribute('href'))).toEqual([
      '/admin/employees',
      '/admin/leave',
    ]);
    expect(within(cards[0]!).getByText('42')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Active employees')).toBeInTheDocument();
    expect(screen.queryByText('External')).not.toBeInTheDocument();
    const actions = screen.getByRole('heading', { name: 'Quick actions' }).parentElement!;
    expect(
      within(actions)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Add employee', 'Review leave requests']);
    expect(screen.queryByRole('heading', { name: 'My work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to My Time' })).not.toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Set up your organization' }),
    ).toBeInTheDocument();
  });

  it('shows an empty state when nothing was returned', async () => {
    setWorkspace([], false);
    respond({ organizationId: 'org-1', cards: [], self: null, quickActions: [] });
    render(<DashboardPage />);
    expect(await screen.findByText('Nothing needs your attention')).toBeInTheDocument();
  });

  it('shows loading skeletons, then an error state with retry', async () => {
    setWorkspace([], true);
    let fail = true;
    apiRequest.mockImplementation(async () => {
      if (fail) throw new Error('down');
      return EMPLOYEE_DASHBOARD;
    });
    render(<DashboardPage />);
    expect(screen.getByText('Loading your dashboard…')).toBeInTheDocument();
    expect(await screen.findByText('Dashboard unavailable')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'My work' })).toBeInTheDocument(),
    );
  });

  it('parses the response defensively', () => {
    expect(() => parseDashboard(null)).toThrow();
    const parsed = parseDashboard({ ...ADMIN_DASHBOARD, extra: 'ignored' });
    expect(parsed.cards.map((card) => card.key)).toEqual([
      'activeEmployees',
      'pendingLeaveApprovals',
    ]);
    expect(parsed).not.toHaveProperty('extra');
  });
});
