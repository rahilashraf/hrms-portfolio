/**
 * Batch R3 — the V1 frontend completion screens in a real browser on the production build:
 * editing a scheduling policy, the audit log's actor and record-type filters, and compensation
 * on a chosen date. Each is checked with axe (serious and critical, including colour contrast,
 * which jsdom cannot check) at desktop and tablet widths.
 */
import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import {
  json,
  mockScheduling,
  noHorizontalScroll,
  ORG,
  path,
  SCHEDULING_PERMISSIONS,
  session,
  VIEWPORTS,
} from './support/workforce-mocks';

async function checkDesktopAndTablet(page: Page) {
  for (const size of [VIEWPORTS.desktop, VIEWPORTS.tablet]) {
    await page.setViewportSize(size);
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

const SETTINGS_NONE = {
  generationHorizonDays: null,
  defaultSchedulePeriod: null,
  autoCreateSchedules: null,
  unscheduledWorkMode: null,
  clockInEarlyMinutes: null,
  clockInLateMinutes: null,
  overlapConflictSeverity: null,
  minimumRestMinutes: null,
  maximumShiftDurationMinutes: null,
  requireWorkLocation: null,
  allowManagerConflictOverride: null,
};

const policy = (overrides: Record<string, unknown>) => ({
  id: 'pol-future',
  scopeType: 'ORGANIZATION',
  organizationId: ORG,
  organizationalUnitId: null,
  departmentId: null,
  teamId: null,
  name: 'Winter rules',
  // Far enough ahead that it has not taken effect anywhere, whenever this runs.
  effectiveFrom: '2099-01-01',
  effectiveTo: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...SETTINGS_NONE,
  minimumRestMinutes: 480,
  ...overrides,
});

test('a scheduler edits a policy that has not taken effect, and only that one', async ({
  page,
}) => {
  await session(page, SCHEDULING_PERMISSIONS);
  await mockScheduling(page);
  let future = policy({});
  const updates: unknown[] = [];
  await page.route(path('/schedule-policies'), (route) =>
    json(route, {
      items: [
        future,
        policy({ id: 'pol-current', name: 'Base rules', effectiveFrom: '2026-01-01' }),
      ],
      nextAfterId: null,
    }),
  );
  await page.route(`${API}/schedule-policies/pol-future`, (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    updates.push(body);
    future = { ...future, ...body };
    return json(route, future);
  });

  await page.goto('/admin/scheduling/policies');
  const edit = page.getByRole('button', { name: /^Edit Winter rules/ });
  await expect(edit).toBeVisible();
  // A policy already in effect cannot be edited (the API would refuse).
  await expect(page.getByRole('button', { name: /^Edit Base rules/ })).toHaveCount(0);

  await edit.click();
  const form = page.getByRole('form', { name: 'Edit Winter rules' });
  const rest = form.getByLabel('Minimum rest between shifts');
  await expect(rest).toHaveValue('480');
  await checkDesktopAndTablet(page);

  await rest.fill('600');
  await form.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText('Policy saved.')).toBeVisible();
  expect(updates).toEqual([{ minimumRestMinutes: 600 }]);
  await expect(form).toHaveCount(0);
});

test('an auditor filters by a person chosen by name and a readable record type', async ({
  page,
}) => {
  await session(page, ['audit.read']);
  const ACTOR = '0b9a7c66-1111-4222-8333-444455556666';
  const listed: URL[] = [];
  const actorSearches: URL[] = [];
  await page.route(path('/audit/actors'), (route) => {
    const url = new URL(route.request().url());
    actorSearches.push(url);
    return json(route, {
      items: [
        { userId: ACTOR, displayName: 'Grace Hopper' },
        { userId: '0b9a7c66-1111-4222-8333-000000000000', displayName: null },
      ],
      nextAfterId: null,
    });
  });
  await page.route(path('/audit'), (route) => {
    const url = new URL(route.request().url());
    listed.push(url);
    return json(route, {
      items: [
        {
          id: 'audit-1',
          occurredAt: '2026-10-05T12:00:00.000Z',
          action: 'EMPLOYEE_UPDATED',
          entityType: 'Employee',
          entityId: 'emp-1',
          actor: { userId: ACTOR, displayName: 'Grace Hopper' },
          requestId: 'req-1',
          metadata: { organizationId: ORG },
        },
      ],
      nextCursor: null,
      range: { from: '2026-09-05T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z' },
    });
  });

  await page.goto('/admin/audit');
  await expect(page.getByRole('main').getByText('Grace Hopper').first()).toBeVisible();

  const filters = page.getByRole('form', { name: 'Audit filters' });
  await filters
    .getByRole('combobox', { name: 'Record type', exact: true })
    .selectOption({ label: 'Employee' });
  const actor = filters.getByRole('combobox', { name: 'Performed by' });
  await actor.fill('grace');
  await page.getByRole('option', { name: /Grace Hopper/ }).click();
  await checkDesktopAndTablet(page);

  await filters.getByRole('button', { name: 'Search' }).click();
  await expect.poll(() => listed.at(-1)?.searchParams.get('actorUserId')).toBe(ACTOR);
  const last = listed.at(-1)!;
  expect(last.searchParams.get('entityType')).toBe('Employee');
  expect(last.searchParams.get('organizationId')).toBe(ORG);
  // The actor lookup is scoped to the same organization as the list.
  expect(actorSearches.length).toBeGreaterThan(0);
  for (const url of actorSearches) expect(url.searchParams.get('organizationId')).toBe(ORG);
});

test('an employee looks up their pay on a past and a future date', async ({ page }) => {
  await session(page, [], { isEmployee: true });
  const record = (id: string, effectiveFrom: string, effectiveTo: string | null, rate: string) => ({
    id,
    employmentAssignmentId: 'assignment-1',
    recordType: id === 'record-1' ? 'INITIAL' : 'CHANGE',
    payBasis: 'HOURLY',
    rateAmount: rate,
    currency: 'CAD',
    effectiveFrom,
    effectiveTo,
    payGroup: { id: 'group-1', code: 'NWA-BIWEEKLY', name: 'NWA Biweekly' },
    reason: null,
    supersedesRecordId: null,
    supersededAt: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const past = record('record-1', '2026-01-01', '2026-06-30', '24.5000');
  const current = record('record-2', '2026-07-01', '2026-12-31', '26.0000');
  const future = record('record-3', '2027-01-01', null, '28.0000');
  const view = {
    assignment: {
      id: 'assignment-1',
      status: 'ACTIVE',
      employmentType: 'FULL_TIME',
      isPrimary: true,
      startDate: '2026-01-01',
      endDate: null,
      employee: { id: 'employee-1', employeeNumber: 'EMP-000001', displayName: 'Ada Lovelace' },
      position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
      organization: { id: ORG, name: 'Northwind Academy', code: 'NWA' },
    },
    asOf: '2026-11-16',
    current,
    timeline: [past, current, future].map((r) => ({
      ...r,
      actions: { canCorrect: false, canEnd: false },
    })),
    superseded: [],
    actions: { canCreate: false, canChange: false },
  };
  await page.route(`${API}/compensation/me`, (route) =>
    json(route, { employeeId: 'employee-1', assignments: [view] }),
  );
  await page.route(`${API}/employment-assignments/assignment-1/compensation/as-of?**`, (route) => {
    const date = new URL(route.request().url()).searchParams.get('date')!;
    const found = [past, current, future].find(
      (r) => r.effectiveFrom <= date && (r.effectiveTo === null || date <= r.effectiveTo),
    );
    return json(route, { employmentAssignmentId: 'assignment-1', date, record: found ?? null });
  });

  await page.goto('/compensation');
  const lookup = page.getByRole('region', { name: /^Compensation on a date for/ });
  const date = lookup.getByLabel('Compensation on date');
  await expect(date).toHaveValue('2026-11-16');

  await date.fill('2026-03-15');
  await lookup.getByRole('button', { name: 'Show' }).click();
  await expect(lookup.getByText('Historical (ended)')).toBeVisible();
  await expect(lookup.getByText(/24\.50/).first()).toBeVisible();

  await date.fill('2027-02-01');
  await lookup.getByRole('button', { name: 'Show' }).click();
  await expect(lookup.getByText('Future-effective')).toBeVisible();
  await expect(lookup.getByText(/28\.00/).first()).toBeVisible();
  await checkDesktopAndTablet(page);

  // Before the first record: nothing was in effect.
  await date.fill('2025-12-01');
  await lookup.getByRole('button', { name: 'Show' }).click();
  await expect(
    lookup.getByText('No compensation was in effect on that date.').first(),
  ).toBeVisible();
});
