import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  CategoryEmailSetting,
  NotificationCategory,
  NotificationsOrganization,
  NotificationView,
  TemplateEntry,
  TemplateView,
} from '../../lib/notifications/types';
import { NotificationBell } from './notification-bell';
import { NotificationCenterPage } from './notification-center-page';
import { NotificationPreferencesPage } from './notification-preferences-page';
import { NotificationsAdminPage } from './notifications-admin-page';
import { isAppPath, NOTIFICATIONS_CHANGED_EVENT } from './notifications-shared';

const mocks = vi.hoisted(() => ({
  api: {
    mine: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    archive: vi.fn(),
    preferences: vi.fn(),
    updatePreferences: vi.fn(),
    organizations: vi.fn(),
    templates: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    archiveTemplate: vi.fn(),
    preview: vi.fn(),
    settings: vi.fn(),
    updateSettings: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/notifications/api', () => ({ notificationsApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const notification = (overrides: Partial<NotificationView> = {}): NotificationView => ({
  id: 'n-1',
  organizationId: 'org-1',
  organization: { id: 'org-1', name: 'Camp' },
  type: 'onboarding.tasks-due',
  category: 'ONBOARDING',
  mandatory: false,
  title: 'Onboarding tasks need your attention',
  body: 'You have 1 overdue and 2 upcoming workflow tasks.',
  link: '/onboarding',
  sourceDomain: 'ONBOARDING',
  createdAt: '2026-10-05T12:00:00.000Z',
  readAt: null,
  archivedAt: null,
  ...overrides,
});

const CATEGORIES: NotificationCategory[] = [
  'SECURITY',
  'HR_REQUIRED',
  'ONBOARDING',
  'DOCUMENTS',
  'PERFORMANCE',
  'RECRUITMENT',
  'LEAVE',
  'SCHEDULING',
  'PAYROLL',
  'BENEFITS',
  'GENERAL',
];

const categorySettings = (off: NotificationCategory[] = []): CategoryEmailSetting[] =>
  CATEGORIES.map((category) => {
    const mandatory = category === 'SECURITY' || category === 'HR_REQUIRED';
    return {
      category,
      mandatory,
      configurable: !mandatory,
      emailEnabled: mandatory || !off.includes(category),
    };
  });

const organization = (
  actions: Partial<NotificationsOrganization['actions']> = {},
  overrides: Partial<NotificationsOrganization> = {},
): NotificationsOrganization => ({
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  actions: {
    canManageTemplates: false,
    canManageSettings: false,
    canReadDeliveries: false,
    ...actions,
  },
  ...overrides,
});

const template = (overrides: Partial<TemplateView> = {}): TemplateView => ({
  id: 'sys-1',
  organizationId: null,
  key: 'onboarding.tasks-due',
  category: 'ONBOARDING',
  subjectTemplate: 'Onboarding tasks need your attention',
  bodyTemplate: 'You have {{overdueCount}} overdue and {{dueSoonCount}} upcoming workflow tasks.',
  allowedVariables: ['overdueCount', 'dueSoonCount', 'taskTitles'],
  mandatory: false,
  status: 'ACTIVE',
  version: 1,
  system: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  ...overrides,
});

const entry = (override: TemplateView | null = null): TemplateEntry => ({
  key: 'onboarding.tasks-due',
  category: 'ONBOARDING',
  mandatory: false,
  allowedVariables: ['overdueCount', 'dueSoonCount', 'taskTitles'],
  sample: { overdueCount: '1', dueSoonCount: '2', taskTitles: 'Set up accounts' },
  system: template(),
  override,
});

const customTemplate = template({
  id: 'tpl-1',
  organizationId: 'org-1',
  system: false,
  version: 2,
  subjectTemplate: 'Camp onboarding reminder',
  bodyTemplate: '{{overdueCount}} tasks are overdue.',
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.useAuth.mockReset();
  auth([]);
});

// Batch 10E-2: tab clicks now write the section into the URL (#hash); every test starts from a
// clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('isAppPath', () => {
  it('accepts relative application paths only', () => {
    expect(isAppPath('/onboarding')).toBe(true);
    expect(isAppPath('/documents/records/doc-1?tab=a')).toBe(true);
    for (const link of [
      null,
      undefined,
      '',
      '//evil.example.com/x',
      '/\\evil.example.com',
      'https://evil.example.com',
      'javascript:alert(1)',
      'onboarding',
      '/a b',
    ]) {
      expect(isAppPath(link)).toBe(false);
    }
  });
});

describe('NotificationBell', () => {
  it('shows the unread count with an accessible label and links to the center', async () => {
    api.unreadCount.mockResolvedValue({ unread: 3 });
    render(<NotificationBell />);
    const link = await screen.findByRole('link', { name: 'Notifications, 3 unread' });
    expect(link).toHaveAttribute('href', '/notifications');
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('3');
  });

  it('caps the badge at 99+ and hides it without unread notifications', async () => {
    api.unreadCount.mockResolvedValueOnce({ unread: 250 });
    render(<NotificationBell />);
    expect(
      await screen.findByRole('link', { name: 'Notifications, 250 unread' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('99+');
    cleanup();
    api.unreadCount.mockResolvedValue({ unread: 0 });
    render(<NotificationBell />);
    await waitFor(() => expect(api.unreadCount).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('polls on an interval, on focus and after inbox changes', async () => {
    vi.useFakeTimers();
    try {
      api.unreadCount.mockResolvedValue({ unread: 1 });
      render(<NotificationBell pollMs={60_000} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.unreadCount).toHaveBeenCalledTimes(1);
      api.unreadCount.mockResolvedValue({ unread: 4 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(api.unreadCount).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('link', { name: 'Notifications, 4 unread' })).toBeInTheDocument();
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.unreadCount).toHaveBeenCalledTimes(3);
      api.unreadCount.mockResolvedValue({ unread: 2 });
      await act(async () => {
        window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.unreadCount).toHaveBeenCalledTimes(4);
      expect(screen.getByRole('link', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
      cleanup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(api.unreadCount).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades silently when the count cannot be loaded', async () => {
    api.unreadCount.mockRejectedValue(new AuthApiError('service-unavailable', 503));
    render(<NotificationBell />);
    await waitFor(() => expect(api.unreadCount).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('NotificationCenterPage', () => {
  it('lists notifications with unread styling and renders only relative app links', async () => {
    api.mine.mockResolvedValue({
      items: [
        notification(),
        notification({
          id: 'n-2',
          title: 'Required documents are missing',
          category: 'HR_REQUIRED',
          mandatory: true,
          link: '//evil.example.com/phish',
          readAt: '2026-10-05T13:00:00.000Z',
        }),
        notification({ id: 'n-3', title: 'External link', link: 'https://evil.example.com' }),
        notification({ id: 'n-4', title: 'No link', link: null }),
      ],
      nextCursor: null,
    });
    render(<NotificationCenterPage />);
    const unread = await screen.findByRole('listitem', {
      name: 'Notification Onboarding tasks need your attention',
    });
    expect(api.mine).toHaveBeenCalledWith({
      limit: 20,
      cursor: null,
      unreadOnly: false,
      archived: false,
      organizationId: null,
    });
    expect(unread).toHaveAttribute('data-unread', 'true');
    expect(within(unread).getByText('Unread')).toBeInTheDocument();
    expect(
      within(unread).getByRole('link', { name: 'Open Onboarding tasks need your attention' }),
    ).toHaveAttribute('href', '/onboarding');
    const read = screen.getByRole('listitem', {
      name: 'Notification Required documents are missing',
    });
    expect(read).toHaveAttribute('data-unread', 'false');
    expect(within(read).getByText('Mandatory')).toBeInTheDocument();
    expect(within(read).getByText('Required HR notices')).toBeInTheDocument();
    expect(within(read).queryByRole('link')).not.toBeInTheDocument();
    expect(within(read).queryByRole('button', { name: /Mark .* read/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Notification External link' })).queryByRole(
        'link',
      ),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Notification No link' })).queryByRole('link'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Organization')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Email preferences' })).toHaveAttribute(
      'href',
      '/notifications/preferences',
    );
  });

  it('marks one read, marks read when following its link, and archives', async () => {
    const listener = vi.fn();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
    api.mine.mockResolvedValue({
      items: [notification(), notification({ id: 'n-2', title: 'Second', link: '/documents' })],
      nextCursor: null,
    });
    api.markRead.mockImplementation(async (id: string) =>
      notification({
        id,
        title: id === 'n-1' ? 'Onboarding tasks need your attention' : 'Second',
        readAt: '2026-10-06T10:00:00.000Z',
      }),
    );
    api.archive.mockResolvedValue(notification({ archivedAt: '2026-10-06T10:00:00.000Z' }));
    render(<NotificationCenterPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Mark Onboarding tasks need your attention read' }),
    );
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith('n-1'));
    await waitFor(() =>
      expect(
        screen.getByRole('listitem', { name: 'Notification Onboarding tasks need your attention' }),
      ).toHaveAttribute('data-unread', 'false'),
    );
    expect(listener).toHaveBeenCalled();

    const second = screen.getByRole('listitem', { name: 'Notification Second' });
    const stay = (event: Event) => event.preventDefault();
    document.addEventListener('click', stay);
    fireEvent.click(within(second).getByRole('link', { name: 'Open Second' }));
    document.removeEventListener('click', stay);
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith('n-2'));

    fireEvent.click(
      screen.getByRole('button', { name: 'Archive Onboarding tasks need your attention' }),
    );
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith('n-1'));
    expect(await screen.findByText('Notification archived.')).toBeInTheDocument();
    expect(
      screen.queryByRole('listitem', { name: 'Notification Onboarding tasks need your attention' }),
    ).not.toBeInTheDocument();
    window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, listener);
  });

  it('marks all read and reloads', async () => {
    api.mine
      .mockResolvedValueOnce({ items: [notification()], nextCursor: null })
      .mockResolvedValue({
        items: [notification({ readAt: '2026-10-06T10:00:00.000Z' })],
        nextCursor: null,
      });
    api.markAllRead.mockResolvedValue({ updated: 1 });
    render(<NotificationCenterPage />);
    await screen.findByRole('listitem', {
      name: 'Notification Onboarding tasks need your attention',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(api.markAllRead).toHaveBeenCalledWith(null));
    expect(await screen.findByText('1 notification marked read.')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('listitem', { name: 'Notification Onboarding tasks need your attention' }),
      ).toHaveAttribute('data-unread', 'false'),
    );
  });

  it('filters unread and archived, by organization, and loads more pages', async () => {
    api.mine.mockImplementation(
      async (filters: { cursor?: string | null; archived?: boolean; organizationId?: string }) => {
        if (filters.archived) {
          return {
            items: [
              notification({ id: 'n-9', title: 'Old', archivedAt: '2026-10-01T00:00:00.000Z' }),
            ],
            nextCursor: null,
          };
        }
        if (filters.cursor === 'c-1') {
          return {
            items: [
              notification({
                id: 'n-3',
                title: 'From the clinic',
                organizationId: 'org-2',
                organization: { id: 'org-2', name: 'Clinic' },
              }),
            ],
            nextCursor: null,
          };
        }
        return {
          items: [notification(), notification({ id: 'n-2', title: 'Another' })],
          nextCursor: filters.organizationId ? null : 'c-1',
        };
      },
    );
    render(<NotificationCenterPage />);
    await screen.findByRole('listitem', { name: 'Notification Another' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(
      await screen.findByRole('listitem', { name: 'Notification From the clinic' }),
    ).toBeInTheDocument();
    expect(api.mine).toHaveBeenLastCalledWith({
      limit: 20,
      cursor: 'c-1',
      unreadOnly: false,
      archived: false,
      organizationId: null,
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    // Notifications from two organizations: the organization filter appears.
    const select = screen.getByLabelText('Organization');
    fireEvent.change(select, { target: { value: 'org-2' } });
    await waitFor(() =>
      expect(api.mine).toHaveBeenLastCalledWith({
        limit: 20,
        cursor: null,
        unreadOnly: false,
        archived: false,
        organizationId: 'org-2',
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    await waitFor(() =>
      expect(api.mine).toHaveBeenLastCalledWith(
        expect.objectContaining({ unreadOnly: true, archived: false, organizationId: 'org-2' }),
      ),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    expect(await screen.findByRole('listitem', { name: 'Notification Old' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive Old' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it('shows an empty state and a friendly error', async () => {
    api.mine.mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<NotificationCenterPage />);
    expect(await screen.findByText('You have no notifications.')).toBeInTheDocument();
    cleanup();
    api.mine.mockRejectedValue(
      new AuthApiError('validation', 400, 'bad', { code: 'NOTIFICATION_CURSOR_INVALID' }),
    );
    render(<NotificationCenterPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The list position expired. Reload your notifications.',
    );
  });
});

describe('NotificationPreferencesPage', () => {
  it('shows in-app as always on and mandatory categories locked, and saves email toggles', async () => {
    api.preferences.mockResolvedValue({ inApp: 'ALWAYS', items: categorySettings() });
    api.updatePreferences.mockResolvedValue({
      inApp: 'ALWAYS',
      items: categorySettings(['LEAVE']),
    });
    render(<NotificationPreferencesPage />);
    const security = await screen.findByLabelText('Email for Security');
    expect(security).toBeChecked();
    expect(security).toBeDisabled();
    expect(screen.getByLabelText('Email for Required HR notices')).toBeDisabled();
    expect(screen.getAllByText('Mandatory — always emailed')).toHaveLength(2);
    expect(screen.getByText(/In-app notifications are always on/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save preferences' });
    expect(save).toBeDisabled();
    const leave = screen.getByLabelText('Email for Leave');
    expect(leave).toBeEnabled();
    fireEvent.click(leave);
    expect(leave).not.toBeChecked();
    fireEvent.click(save);
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalled());
    const sent = api.updatePreferences.mock.calls[0]![0] as Array<{
      category: string;
      emailEnabled: boolean;
    }>;
    expect(sent.map((item) => item.category)).not.toContain('SECURITY');
    expect(sent.map((item) => item.category)).not.toContain('HR_REQUIRED');
    expect(sent).toHaveLength(9);
    expect(sent).toContainEqual({ category: 'LEAVE', emailEnabled: false });
    expect(sent).toContainEqual({ category: 'PAYROLL', emailEnabled: true });
    expect(await screen.findByText('Email preferences saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email for Leave')).not.toBeChecked();
  });

  it('explains a refused change', async () => {
    api.preferences.mockResolvedValue({ inApp: 'ALWAYS', items: categorySettings() });
    api.updatePreferences.mockRejectedValue(
      new AuthApiError('validation', 400, 'x', { code: 'NOTIFICATION_CATEGORY_MANDATORY' }),
    );
    render(<NotificationPreferencesPage />);
    fireEvent.click(await screen.findByLabelText('Email for Payroll'));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Security and required HR notices are always sent; their email cannot be turned off.',
    );
  });
});

describe('NotificationsAdminPage', () => {
  it('is forbidden without notification admin permissions', () => {
    auth(['document.manage']);
    render(<NotificationsAdminPage />);
    expect(
      screen.getByText('You do not have permission to manage notifications.'),
    ).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('customizes a system template with a live preview, never editing the system default', async () => {
    auth(['notification.template.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageTemplates: true })] });
    api.templates.mockResolvedValue({ items: [entry()] });
    api.preview.mockImplementation(
      async (input: { subjectTemplate: string; bodyTemplate: string }) => {
        if (input.bodyTemplate.includes('{{secret}}')) {
          throw new AuthApiError('validation', 400, 'unknown', {
            code: 'NOTIFICATION_TEMPLATE_PLACEHOLDER',
          });
        }
        return {
          key: 'onboarding.tasks-due',
          variables: {},
          subject: input.subjectTemplate,
          body: input.bodyTemplate.replace('{{overdueCount}}', '1'),
        };
      },
    );
    api.createTemplate.mockResolvedValue(customTemplate);
    render(<NotificationsAdminPage />);
    const card = await screen.findByRole('region', { name: 'onboarding.tasks-due' });
    // Only the templates tab is permitted: no tab list and no settings.
    expect(screen.queryByRole('tab', { name: 'Email settings' })).not.toBeInTheDocument();
    expect(api.settings).not.toHaveBeenCalled();
    expect(within(card).getByText('Using the system default')).toBeInTheDocument();
    expect(within(card).getByText('System default (read-only)')).toBeInTheDocument();
    const variables = within(card).getByRole('list', {
      name: 'Allowed variables for onboarding.tasks-due',
    });
    expect(within(variables).getByText('{{overdueCount}}')).toBeInTheDocument();
    expect(within(variables).getByText('{{taskTitles}}')).toBeInTheDocument();
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Customize onboarding.tasks-due' }));
    const form = within(card).getByRole('form', { name: 'Edit template onboarding.tasks-due' });
    expect(within(form).getByLabelText('Subject')).toHaveValue(
      'Onboarding tasks need your attention',
    );
    fireEvent.change(within(form).getByLabelText('Body'), {
      target: { value: '{{overdueCount}} tasks are overdue at camp.' },
    });
    const preview = within(form).getByRole('region', { name: 'Preview onboarding.tasks-due' });
    expect(await within(preview).findByText('1 tasks are overdue at camp.')).toBeInTheDocument();
    expect(api.preview).toHaveBeenLastCalledWith({
      organizationId: 'org-1',
      key: 'onboarding.tasks-due',
      subjectTemplate: 'Onboarding tasks need your attention',
      bodyTemplate: '{{overdueCount}} tasks are overdue at camp.',
    });

    fireEvent.change(within(form).getByLabelText('Body'), {
      target: { value: 'Hello {{secret}}' },
    });
    expect(
      await within(preview).findByText(
        'The template uses a placeholder this notification does not provide. Use only the listed variables.',
      ),
    ).toBeInTheDocument();

    fireEvent.change(within(form).getByLabelText('Body'), {
      target: { value: '  {{overdueCount}} tasks are overdue.  ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create custom template' }));
    await waitFor(() =>
      expect(api.createTemplate).toHaveBeenCalledWith({
        organizationId: 'org-1',
        key: 'onboarding.tasks-due',
        subjectTemplate: 'Onboarding tasks need your attention',
        bodyTemplate: '{{overdueCount}} tasks are overdue.',
      }),
    );
    expect(
      await screen.findByText('Custom template for onboarding.tasks-due created.'),
    ).toBeInTheDocument();
  });

  it('edits and archives an organization override', async () => {
    auth(['notification.template.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageTemplates: true })] });
    api.templates.mockResolvedValue({ items: [entry(customTemplate)] });
    api.preview.mockResolvedValue({
      key: 'onboarding.tasks-due',
      variables: {},
      subject: 'Camp reminder',
      body: '1 tasks are overdue.',
    });
    api.updateTemplate.mockResolvedValue(customTemplate);
    api.archiveTemplate.mockResolvedValue({ ...customTemplate, status: 'ARCHIVED' });
    api.updateTemplate.mockRejectedValueOnce(
      new AuthApiError('validation', 400, 'x', { code: 'NOTIFICATION_TEMPLATE_LINK' }),
    );
    render(<NotificationsAdminPage />);
    const card = await screen.findByRole('region', { name: 'onboarding.tasks-due' });
    expect(within(card).getByText('Custom template · version 2')).toBeInTheDocument();
    expect(within(card).getByText('Camp onboarding reminder')).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole('button', { name: 'Edit custom template onboarding.tasks-due' }),
    );
    const form = within(card).getByRole('form', { name: 'Edit template onboarding.tasks-due' });
    expect(within(form).getByLabelText('Subject')).toHaveValue('Camp onboarding reminder');
    fireEvent.change(within(form).getByLabelText('Subject'), {
      target: { value: 'Camp reminder' },
    });
    expect(await within(form).findByText('Camp reminder')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save custom template' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Templates cannot contain links or web addresses',
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save custom template' }));
    await waitFor(() =>
      expect(api.updateTemplate).toHaveBeenLastCalledWith('tpl-1', {
        subjectTemplate: 'Camp reminder',
        bodyTemplate: '{{overdueCount}} tasks are overdue.',
      }),
    );
    expect(
      await screen.findByText('Custom template for onboarding.tasks-due saved.'),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Archive custom template onboarding.tasks-due' }),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Archive custom template',
      }),
    );
    await waitFor(() => expect(api.archiveTemplate).toHaveBeenCalledWith('tpl-1'));
  });

  it('manages organization email settings with mandatory categories locked', async () => {
    auth(['notification.settings.manage']);
    api.organizations.mockResolvedValue({
      items: [
        organization({ canManageSettings: true }),
        organization(
          { canManageTemplates: true, canManageSettings: true },
          { id: 'org-2', name: 'Clinic', code: 'CLINIC' },
        ),
      ],
    });
    const settings = {
      organizationId: 'org-1',
      emailEnabled: true,
      suppressMandatoryEmail: false,
      categories: categorySettings(),
      updatedAt: null,
    };
    api.settings.mockResolvedValue(settings);
    api.updateSettings.mockResolvedValue({
      ...settings,
      emailEnabled: false,
      suppressMandatoryEmail: true,
    });
    api.templates.mockResolvedValue({ items: [entry()] });
    render(<NotificationsAdminPage />);
    const form = await screen.findByRole('form', { name: 'Organization email settings' });
    expect(screen.queryByRole('tab', { name: 'Templates' })).not.toBeInTheDocument();
    expect(api.templates).not.toHaveBeenCalled();
    expect(within(form).getByLabelText('Email for Security')).toBeDisabled();
    expect(within(form).getByLabelText('Email for Security')).toBeChecked();
    expect(within(form).getByLabelText('Email for Required HR notices')).toBeDisabled();
    expect(within(form).queryByLabelText('Also suppress mandatory email')).not.toBeInTheDocument();

    fireEvent.click(within(form).getByLabelText('Send notification email for this organization'));
    expect(within(form).getByText(/Email is turned off for this organization/)).toBeInTheDocument();
    fireEvent.click(within(form).getByLabelText('Also suppress mandatory email'));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'people will not receive security or required HR notices by email',
    );
    expect(within(form).getByLabelText('Email for Security')).not.toBeChecked();
    fireEvent.click(within(form).getByLabelText('Email for Payroll'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save email settings' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const sent = api.updateSettings.mock.calls[0]![0] as {
      organizationId: string;
      emailEnabled: boolean;
      suppressMandatoryEmail: boolean;
      categories: Array<{ category: string; emailEnabled: boolean }>;
    };
    expect(sent.organizationId).toBe('org-1');
    expect(sent.emailEnabled).toBe(false);
    expect(sent.suppressMandatoryEmail).toBe(true);
    expect(sent.categories).toHaveLength(9);
    expect(sent.categories).toContainEqual({ category: 'PAYROLL', emailEnabled: false });
    expect(sent.categories.map((c) => c.category)).not.toContain('SECURITY');
    expect(await screen.findByText('Notification email settings saved.')).toBeInTheDocument();

    // The second organization allows both tabs.
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-2' } });
    expect(await screen.findByRole('tab', { name: 'Templates' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
    expect(await screen.findByRole('region', { name: 'onboarding.tasks-due' })).toBeInTheDocument();
    expect(api.templates).toHaveBeenCalledWith('org-2');
  });

  it('turning email back on never sends a mandatory suppression', async () => {
    auth(['notification.settings.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageSettings: true })] });
    const settings = {
      organizationId: 'org-1',
      emailEnabled: false,
      suppressMandatoryEmail: true,
      categories: categorySettings(),
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    api.settings.mockResolvedValue(settings);
    api.updateSettings.mockResolvedValue({
      ...settings,
      emailEnabled: true,
      suppressMandatoryEmail: false,
    });
    render(<NotificationsAdminPage />);
    const form = await screen.findByRole('form', { name: 'Organization email settings' });
    expect(within(form).getByLabelText('Also suppress mandatory email')).toBeChecked();
    fireEvent.click(within(form).getByLabelText('Send notification email for this organization'));
    expect(within(form).queryByLabelText('Also suppress mandatory email')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save email settings' }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ emailEnabled: true, suppressMandatoryEmail: false }),
      ),
    );
  });
});
