import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { canFromSnapshot } from '../../lib/authorization/can';
import { NotificationBell } from '../notifications/notification-bell';
import { PermissionGate, RequirePermission } from './require-permission';

/**
 * Batch 10A — presentation helpers and shell pieces: the permission gate never flashes "Access
 * denied" while permissions load and keeps the page's width; the /admin page puts its h1 first
 * for every role combination; the bells share one unread count.
 */
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listOrganizations: vi.fn(),
  unreadCount: vi.fn(),
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../lib/organization/api', () => ({
  organizationApi: { listOrganizations: mocks.listOrganizations },
}));
vi.mock('../../lib/notifications/api', () => ({
  notificationsApi: { unreadCount: mocks.unreadCount },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Organization-scoped grants with the real scope check (Batch R3.2: a mock that ignored scope
// hid that a scope-less `can()` only counts system-wide grants).
const auth = (keys: string[] | null, loading = false) => {
  const authorization =
    keys === null
      ? null
      : {
          userId: 'user-1',
          permissions: keys.map((key) => ({
            key,
            scopes: [{ type: 'ORGANIZATION' as const, id: 'o-1' }],
          })),
        };
  mocks.useAuth.mockReturnValue({
    authorizationLoading: loading,
    authorization,
    can: (key: string, scope?: Parameters<typeof canFromSnapshot>[2]) =>
      canFromSnapshot(authorization, key, scope),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listOrganizations.mockResolvedValue([
    { id: 'o-1', name: 'Northwind', code: 'NWA', description: null, archivedAt: null },
  ]);
});
afterEach(cleanup);

describe('PermissionGate / RequirePermission', () => {
  it('shows a loading state in the page width while permissions load — never "Access denied"', async () => {
    auth(null, true);
    const { container } = render(
      <RequirePermission anyOf={['document.read']} width="wide">
        <p>Secret content</p>
      </RequirePermission>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Checking your access…');
    expect(screen.queryByText(/Access denied/)).not.toBeInTheDocument();
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('max-w-6xl');
    await expectNoAxeViolations(container);
  });

  it('shows the denied state once permissions are known to be missing, in the same width', () => {
    auth(['employee.read']);
    const { container } = render(
      <RequirePermission
        anyOf={['document.read', 'document.manage']}
        width="wide"
        deniedMessage="You do not have permission to view documents."
      >
        <p>Secret content</p>
      </RequirePermission>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText('You do not have permission to view documents.')).toBeInTheDocument();
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('max-w-6xl');
  });

  it('renders the page when any listed permission is held', () => {
    auth(['document.manage']);
    render(
      <RequirePermission anyOf={['document.read', 'document.manage']}>
        <p>Secret content</p>
      </RequirePermission>,
    );
    expect(screen.getByText('Secret content')).toBeInTheDocument();
  });

  it('PermissionGate is presentational: it renders exactly what it is told', () => {
    const { rerender } = render(
      <PermissionGate loading={false} allowed={false} deniedTitle="No access here">
        <p>Inside</p>
      </PermissionGate>,
    );
    expect(screen.getByRole('heading', { name: 'No access here' })).toBeInTheDocument();
    rerender(
      <PermissionGate loading={false} allowed>
        <p>Inside</p>
      </PermissionGate>,
    );
    expect(screen.getByText('Inside')).toBeInTheDocument();
  });
});

describe('/admin heading order and loading', () => {
  async function renderAdmin() {
    const { default: AdminPage } = await import('../../app/(app)/(authenticated)/admin/page');
    return render(<AdminPage />);
  }
  const headingLevels = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('h1, h2, h3')).map((h) => h.tagName);

  it('puts the h1 first for role readers, with the roles shortcut after it in brand colors', async () => {
    auth(['organization.read', 'role.read']);
    const { container } = await renderAdmin();
    await screen.findByText('Northwind');
    const levels = headingLevels(container);
    expect(levels[0]).toBe('H1');
    expect(screen.getByRole('heading', { level: 1, name: 'Organizations' })).toBeInTheDocument();
    const roles = screen.getByRole('heading', { level: 2, name: 'Roles & Permissions' });
    expect(roles).toHaveClass('text-[var(--hrms-accent-text)]');
    expect(roles.closest('a')).toHaveAttribute('href', '/admin/access-control/roles');
    expect(roles.closest('a')!.outerHTML).not.toMatch(/indigo-/);
  });

  it('has the same order without role.read (no shortcut)', async () => {
    auth(['organization.read']);
    const { container } = await renderAdmin();
    await screen.findByText('Northwind');
    expect(headingLevels(container)[0]).toBe('H1');
    expect(screen.queryByRole('heading', { name: 'Roles & Permissions' })).not.toBeInTheDocument();
  });

  it('offers no roles shortcut to role.manage or role.assign without role.read (Batch R3.2)', async () => {
    // The Roles page requires role.read; the shortcut would only lead to "Access denied".
    auth(['organization.read', 'role.manage', 'role.assign']);
    await renderAdmin();
    await screen.findByText('Northwind');
    expect(screen.queryByRole('heading', { name: 'Roles & Permissions' })).not.toBeInTheDocument();
  });

  it('shows loading, not "No organization access", while permissions load', async () => {
    auth(null, true);
    await renderAdmin();
    expect(screen.getByRole('status')).toHaveTextContent('Checking your access…');
    expect(screen.queryByText('No organization access')).not.toBeInTheDocument();
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });

  it('keeps the roles shortcut, after the denied h1, for role readers without organization access', async () => {
    auth(['role.read']);
    const { container } = await renderAdmin();
    expect(headingLevels(container)).toEqual(['H1', 'H2']);
    expect(
      screen.getByRole('heading', { level: 1, name: 'No organization access' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Roles & Permissions' }).closest('a'),
    ).toHaveAttribute('href', '/admin/access-control/roles');
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });

  it('shows the denied state (an h1) without organization.read', async () => {
    auth(['employee.read']);
    await renderAdmin();
    expect(
      screen.getByRole('heading', { level: 1, name: 'No organization access' }),
    ).toBeInTheDocument();
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });
});

describe('Notification bells share one unread count', () => {
  it('requests the count once for two bells, shows it in both, and stops with the last', async () => {
    vi.useFakeTimers();
    try {
      mocks.unreadCount.mockResolvedValue({ unread: 5 });
      const first = render(<NotificationBell pollMs={60_000} />);
      const second = render(<NotificationBell pollMs={60_000} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.unreadCount).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('link', { name: 'Notifications, 5 unread' })).toHaveLength(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.unreadCount).toHaveBeenCalledTimes(2);
      first.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.unreadCount).toHaveBeenCalledTimes(3);
      second.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(mocks.unreadCount).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
    // A new bell after all were gone starts from zero and asks again.
    mocks.unreadCount.mockResolvedValue({ unread: 0 });
    render(<NotificationBell />);
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(4));
  });
});
