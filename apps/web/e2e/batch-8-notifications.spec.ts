import { expect, test } from '@playwright/test';
import { API } from './support/api-origin';
import { ORG, TYPES, checkAt, delivery, json, session } from './support/notifications-mocks';

/**
 * Batch 8 — the read-only notification delivery log and the TIME category against a mocked
 * API: a delivery reader opens the admin page (no template or settings access), filters by
 * event, status and recipient name, pages with the cursor, opens an attempt history and closes
 * it with Escape; an employee sees "Time & attendance" in their email preferences. axe
 * (serious/critical) and no page-wide horizontal scroll at 1280, 820 and a 375 px phone.
 */

test('a delivery reader filters, pages and inspects attempts without seeing message content', async ({
  page,
}) => {
  await session(page, ['notification.delivery.read']);
  await page.route(`${API}/notifications/organizations`, (route) =>
    json(route, {
      items: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          actions: { canManageTemplates: false, canManageSettings: false, canReadDeliveries: true },
        },
      ],
    }),
  );
  const queries: URLSearchParams[] = [];
  await page.route(
    (url) => url.origin === API && url.pathname === '/notifications/deliveries',
    (route) => {
      const params = new URL(route.request().url()).searchParams;
      queries.push(params);
      if (params.get('cursor') === 'page-2')
        return json(route, {
          items: [
            delivery('d-4', {
              type: 'time.timesheet-approved',
              category: 'TIME',
              channel: 'IN_APP',
              attemptCount: 0,
              recipientName: 'Sam Roy',
            }),
          ],
          nextCursor: null,
          timezone: 'America/Toronto',
          types: TYPES,
        });
      if (params.get('status') === 'SUPPRESSED')
        return json(route, {
          items: [
            delivery('d-3', {
              type: 'payroll.payslip-available',
              category: 'PAYROLL',
              status: 'SUPPRESSED',
              attemptCount: 1,
              sentAt: null,
              suppressedReason: 'EMAIL_PROVIDER_NOT_CONFIGURED',
              lastErrorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED',
            }),
          ],
          nextCursor: null,
          timezone: 'America/Toronto',
          types: TYPES,
        });
      return json(route, {
        items: [
          delivery('d-1'),
          delivery('d-2', {
            status: 'PENDING',
            sentAt: null,
            nextAttemptAt: '2026-11-02T15:04:00.000Z',
            lastErrorCode: 'SMTP_TIMEOUT',
            recipientName: 'Alexandra Montgomery-Fitzgerald',
          }),
        ],
        nextCursor: 'page-2',
        timezone: 'America/Toronto',
        types: TYPES,
      });
    },
  );
  await page.route(`${API}/notifications/deliveries/d-1`, (route) =>
    json(route, {
      ...delivery('d-1', { attemptCount: 2 }),
      attempts: [
        {
          attemptNumber: 1,
          status: 'RETRYABLE_FAILURE',
          outcome: 'RETRYABLE',
          provider: 'smtp',
          errorCode: 'SMTP_TIMEOUT',
          startedAt: '2026-11-02T15:00:00.000Z',
          finishedAt: '2026-11-02T15:00:30.000Z',
        },
        {
          attemptNumber: 2,
          status: 'SUCCEEDED',
          outcome: 'SUCCEEDED',
          provider: 'smtp',
          errorCode: null,
          startedAt: '2026-11-02T15:01:00.000Z',
          finishedAt: '2026-11-02T15:01:01.000Z',
        },
      ],
    }),
  );

  await page.goto('/admin/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications administration' })).toBeVisible();
  const table = page.getByRole('table', { name: /Notification deliveries/ });
  await expect(table.getByText('Jordan Lee')).toBeVisible();
  await expect(table.getByText(/^Retry 2 at/)).toBeVisible();
  await checkAt(page);

  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(table.getByText('Sam Roy')).toBeVisible();
  await expect(table.getByText('Time & attendance')).toBeVisible();
  expect(queries.at(-1)?.get('cursor')).toBe('page-2');

  const filters = page.getByRole('form', { name: 'Delivery log filters' });
  await filters.getByLabel('Status').selectOption('SUPPRESSED');
  await filters.getByLabel('Recipient name').fill('Jor');
  await filters.getByRole('button', { name: 'Apply filters' }).click();
  await expect(table.getByText('No email provider is configured')).toBeVisible();
  expect(queries.at(-1)?.get('status')).toBe('SUPPRESSED');
  expect(queries.at(-1)?.get('recipient')).toBe('Jor');
  expect(queries.at(-1)?.get('organizationId')).toBe(ORG);
  await checkAt(page);

  await filters.getByRole('button', { name: 'Clear' }).click();
  const open = page.getByRole('button', { name: 'Attempts for Leave approved to Jordan Lee' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Delivery attempts' });
  await expect(dialog.getByText('Failed, retried later')).toBeVisible();
  await expect(dialog.getByText('Delivered to the provider')).toBeVisible();
  await checkAt(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('an employee sees the Time & attendance category in their email preferences', async ({
  page,
}) => {
  await session(page, []);
  const categories = [
    'SECURITY',
    'HR_REQUIRED',
    'ONBOARDING',
    'DOCUMENTS',
    'PERFORMANCE',
    'RECRUITMENT',
    'LEAVE',
    'SCHEDULING',
    'TIME',
    'PAYROLL',
    'BENEFITS',
    'GENERAL',
  ];
  await page.route(`${API}/notifications/me/preferences`, (route) =>
    json(route, {
      inApp: 'ALWAYS',
      items: categories.map((category) => {
        const mandatory = category === 'SECURITY' || category === 'HR_REQUIRED';
        return { category, mandatory, configurable: !mandatory, emailEnabled: true };
      }),
    }),
  );
  await page.goto('/notifications/preferences');
  await expect(page.getByLabel('Email for Time & attendance')).toBeChecked();
  await checkAt(page);
});
