import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  DeliveryDetail,
  DeliveryView,
  NotificationsOrganization,
} from '../../lib/notifications/types';
import { NotificationsAdminPage } from './notifications-admin-page';
import { CATEGORY_LABELS } from './notifications-shared';

const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    templates: vi.fn(),
    settings: vi.fn(),
    deliveries: vi.fn(),
    delivery: vi.fn(),
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

const organization = (
  actions: Partial<NotificationsOrganization['actions']> = {},
): NotificationsOrganization => ({
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  actions: {
    canManageTemplates: false,
    canManageSettings: false,
    canReadDeliveries: true,
    ...actions,
  },
});

const delivery = (overrides: Partial<DeliveryView> = {}): DeliveryView => ({
  id: 'd-1',
  type: 'leave.request-approved',
  category: 'LEAVE',
  mandatory: false,
  recipientName: 'Jordan Lee',
  channel: 'EMAIL',
  status: 'SENT',
  attemptCount: 1,
  nextAttemptAt: null,
  sentAt: '2026-03-15T16:00:00.000Z',
  lastErrorCode: null,
  suppressedReason: null,
  createdAt: '2026-03-15T15:59:00.000Z',
  updatedAt: '2026-03-15T16:00:00.000Z',
  ...overrides,
});

const page = (items: DeliveryView[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
  timezone: 'America/Toronto',
  types: [
    { key: 'leave.request-approved', category: 'LEAVE' as const },
    { key: 'time.timesheet-approved', category: 'TIME' as const },
  ],
});

describe('Notifications delivery log (Batch 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth(['notification.delivery.read']);
    api.organizations.mockResolvedValue({ items: [organization()] });
  });
  afterEach(cleanup);

  it('is reachable with notification.delivery.read alone and shows each status distinctly', async () => {
    api.deliveries.mockResolvedValue(
      page([
        delivery(),
        delivery({
          id: 'd-2',
          status: 'PENDING',
          attemptCount: 1,
          nextAttemptAt: '2026-03-15T16:02:00.000Z',
          lastErrorCode: 'SMTP_TIMEOUT',
        }),
        delivery({ id: 'd-3', status: 'SENDING', attemptCount: 1 }),
        delivery({
          id: 'd-4',
          status: 'FAILED',
          attemptCount: 1,
          lastErrorCode: 'DELIVERY_OUTCOME_UNCERTAIN',
        }),
        delivery({
          id: 'd-5',
          status: 'SUPPRESSED',
          attemptCount: 0,
          suppressedReason: 'EMAIL_PROVIDER_NOT_CONFIGURED',
        }),
        delivery({
          id: 'd-6',
          channel: 'IN_APP',
          attemptCount: 0,
          type: 'time.timesheet-approved',
          category: 'TIME',
        }),
      ]),
    );
    render(<NotificationsAdminPage />);
    const table = await screen.findByRole('table', { name: /Notification deliveries/ });
    expect(api.deliveries).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', cursor: null, limit: 25 }),
    );
    // A single section: no tabs, no template or settings requests.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(api.templates).not.toHaveBeenCalled();
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(7);
    for (const text of ['Sent', 'Pending', 'Sending', 'Failed', 'Suppressed'])
      expect(within(table).getAllByText(text).length).toBeGreaterThan(0);
    expect(within(table).getByText('No email provider is configured')).toBeTruthy();
    expect(within(table).getByText('Outcome unknown; not retried')).toBeTruthy();
    expect(within(table).getByText(/^Retry 2 at/)).toBeTruthy();
    expect(within(table).getByText('Timesheet approved')).toBeTruthy();
    expect(within(table).getByText(CATEGORY_LABELS.TIME)).toBeTruthy();
    // In-app deliveries have no attempts to show.
    expect(within(rows[6]!).queryByRole('button')).toBeNull();
  });

  it('applies filters on submit (no raw ids), validates the date range and clears', async () => {
    api.deliveries.mockResolvedValue(page([]));
    render(<NotificationsAdminPage />);
    expect(await screen.findByText('No deliveries have been recorded yet.')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Delivery log filters' });
    fireEvent.change(within(form).getByLabelText('Event'), {
      target: { value: 'time.timesheet-approved' },
    });
    fireEvent.change(within(form).getByLabelText('Category'), { target: { value: 'TIME' } });
    fireEvent.change(within(form).getByLabelText('Channel'), { target: { value: 'EMAIL' } });
    fireEvent.change(within(form).getByLabelText('Status'), { target: { value: 'FAILED' } });
    fireEvent.change(within(form).getByLabelText('Recipient name'), { target: { value: 'Jor' } });
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-03-20' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-03-10' } });
    expect(screen.getByRole('alert').textContent).toMatch(/start date must not be after/);
    expect(
      (within(form).getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-03-31' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(api.deliveries).toHaveBeenLastCalledWith({
        organizationId: 'org-1',
        type: 'time.timesheet-approved',
        category: 'TIME',
        channel: 'EMAIL',
        status: 'FAILED',
        from: '2026-03-20',
        to: '2026-03-31',
        recipient: 'Jor',
        cursor: null,
        limit: 25,
      }),
    );
    expect(await screen.findByText('No deliveries match these filters.')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(api.deliveries).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: '', status: '', recipient: '' }),
      ),
    );
  });

  it('pages with the cursor and opens a focus-managed attempt history', async () => {
    api.deliveries
      .mockResolvedValueOnce(page([delivery()], 'cursor-2'))
      .mockResolvedValueOnce(page([delivery({ id: 'd-9', recipientName: 'Sam Roy' })]));
    const detail: DeliveryDetail = {
      ...delivery({ status: 'SENT', attemptCount: 2 }),
      attempts: [
        {
          attemptNumber: 1,
          status: 'RETRYABLE_FAILURE',
          outcome: 'RETRYABLE',
          provider: 'smtp',
          errorCode: 'SMTP_TIMEOUT',
          startedAt: '2026-03-15T15:59:00.000Z',
          finishedAt: '2026-03-15T15:59:30.000Z',
        },
        {
          attemptNumber: 2,
          status: 'SUCCEEDED',
          outcome: 'SUCCEEDED',
          provider: 'smtp',
          errorCode: null,
          startedAt: '2026-03-15T16:00:00.000Z',
          finishedAt: '2026-03-15T16:00:01.000Z',
        },
      ],
    };
    api.delivery.mockResolvedValue(detail);
    render(<NotificationsAdminPage />);
    await screen.findByText('Jordan Lee');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Sam Roy')).toBeTruthy();
    expect(api.deliveries).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-2' }),
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    const open = screen.getByRole('button', { name: 'Attempts for Leave approved to Jordan Lee' });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Delivery attempts' });
    expect(api.delivery).toHaveBeenCalledWith('d-1');
    const attempts = await within(dialog).findByRole('table', { name: /Attempts of this email/ });
    expect(within(attempts).getByText('Failed, retried later')).toBeTruthy();
    expect(within(attempts).getByText('SMTP_TIMEOUT')).toBeTruthy();
    expect(within(attempts).getByText('Delivered to the provider')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Delivery attempts');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('shows the error state with a retry, and tabs when other sections are granted', async () => {
    api.deliveries.mockRejectedValueOnce(new AuthApiError('service-unavailable', 503));
    api.deliveries.mockResolvedValue(page([delivery()]));
    render(<NotificationsAdminPage />);
    expect(await screen.findByText('The delivery log could not be loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Jordan Lee')).toBeTruthy();
    cleanup();

    auth(['notification.settings.manage', 'notification.delivery.read']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageSettings: true })],
    });
    api.settings.mockResolvedValue({
      organizationId: 'org-1',
      emailEnabled: true,
      suppressMandatoryEmail: false,
      categories: [{ category: 'TIME', mandatory: false, configurable: true, emailEnabled: true }],
      updatedAt: null,
    });
    render(<NotificationsAdminPage />);
    const tab = await screen.findByRole('tab', { name: 'Delivery log' });
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    fireEvent.click(tab);
    expect(await screen.findByRole('table', { name: /Notification deliveries/ })).toBeTruthy();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab.id);
  });

  it('refuses users without any notifications administration permission', async () => {
    auth(['employee.read']);
    render(<NotificationsAdminPage />);
    expect(screen.getByText('You do not have permission to manage notifications.')).toBeTruthy();
    expect(api.deliveries).not.toHaveBeenCalled();
  });
});
