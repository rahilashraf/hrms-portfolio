/**
 * Batch R4-A — the V1 workflow completion screens in a real browser on the production build:
 * the manual lifecycle panel, multi-assignment web clock-in with a warning, holiday markers on
 * the schedules, and edit-form focus. Each runs axe (serious and critical, including colour
 * contrast) at desktop and tablet widths.
 */
import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import {
  assignmentView,
  coordinator,
  json,
  mockMyTime,
  mockScheduling,
  noHorizontalScroll,
  ORG,
  path,
  SCHEDULING_PERMISSIONS,
  session,
  todayInToronto,
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

const list = <T>(items: T[]) => ({ total: items.length, items, truncated: false, limit: 50 });

test('HR reviews and applies an overdue assignment end without ending employment', async ({
  page,
}) => {
  await session(page, ['employee.read', 'employee.manage']);
  const row = {
    employeeId: 'emp-2',
    employeeNumber: 'EMP-000002',
    employeeName: 'Grace Hopper',
    timezone: 'America/Toronto',
    organizationId: ORG,
    organizationName: 'Northwind Academy',
    employmentType: 'PART_TIME',
    isPrimary: false,
    startDate: '2026-01-01',
    localToday: '2026-11-04',
  };
  let overdue = [
    {
      ...row,
      employmentAssignmentId: 'asg-overdue',
      positionName: 'Org Associate',
      endDate: '2026-11-01',
      daysOverdue: 3,
    },
  ];
  const calls: string[] = [];
  await page.route(path('/employees/lifecycle/due'), (route) => {
    calls.push(new URL(route.request().url()).search);
    return json(route, {
      organizationId: ORG,
      terminations: [],
      assignmentEnds: overdue,
      upcomingAssignmentEnds: [
        {
          ...row,
          employeeId: 'emp-1',
          employeeName: 'Ada Lovelace',
          employmentAssignmentId: 'asg-term',
          positionName: 'Team A Associate',
          endDate: '2026-11-20',
          daysUntilEnd: 16,
          scheduledTerminationId: 'term-1',
        },
      ],
      upcomingDays: Number(new URL(route.request().url()).searchParams.get('upcomingDays') ?? 30),
      truncated: false,
      limit: 500,
    });
  });
  await page.route(`${API}/employees/emp-2/assignments/asg-overdue/impact**`, (route) =>
    json(route, {
      employeeId: 'emp-2',
      employmentAssignmentId: 'asg-overdue',
      organizationId: ORG,
      timezone: 'America/Toronto',
      endDate: '2026-11-01',
      blocked: false,
      blockers: [],
      attendance: { openTimeEntries: list([]) },
      scheduling: { futurePublishedShifts: list([]) },
      leave: { pending: list([]), approvedAfterEnd: list([]) },
      compensation: { recordsBeyondEnd: list([]) },
      payroll: { openPayrollRuns: 0 },
      benefits: { enrollmentsBeyondEnd: list([]) },
      managerRelationships: {
        visibleDirectReports: [],
        visibleDirectReportCount: 0,
        truncated: false,
        limit: 200,
      },
      employment: {
        otherCurrentAssignments: [
          {
            employmentAssignmentId: 'asg-other',
            status: 'ACTIVE',
            positionName: 'Team A Associate',
            organizationId: ORG,
          },
        ],
        remainsEmployedInOrganization: true,
        endsLastCurrentEmployment: false,
      },
      access: { loginStatus: 'ACTIVE', grantsInOrganization: 0, changesAccess: false },
      offboarding: null,
    }),
  );
  const applied: string[] = [];
  await page.route(`${API}/employees/emp-2/assignments/asg-overdue/apply-end`, (route) => {
    applied.push(route.request().method());
    overdue = [];
    return json(route, { id: 'asg-overdue', status: 'ENDED' });
  });

  await page.goto('/admin/employees/lifecycle');
  // R5-A: the breadcrumb names this page (it is not an employee profile) and links Employees.
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs).toContainText('Ending assignments');
  await expect(crumbs).not.toContainText('Employee profile');
  await expect(crumbs.getByRole('link', { name: 'Employees' })).toHaveAttribute(
    'href',
    '/admin/employees',
  );
  const overdueTable = page.getByRole('table', { name: 'Assignments past their end date' });
  await expect(overdueTable.getByText('Grace Hopper')).toBeVisible();
  const soon = page.getByRole('table', { name: 'Assignments ending soon' });
  await expect(soon.getByText('Ends with scheduled termination')).toBeVisible();
  await expect(soon.getByRole('button')).toHaveCount(0);
  await checkDesktopAndTablet(page);

  await page.getByLabel('Show assignments ending within').selectOption('60');
  await expect.poll(() => calls.at(-1)).toContain('upcomingDays=60');

  await page.getByRole('button', { name: /Review and apply end for Grace Hopper/ }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Apply this assignment end?' });
  await expect(dialog).toContainText('the employee stays employed');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Apply end' }).click();
  await expect(page.getByText(/employment and other assignments are unchanged/)).toBeVisible();
  await expect(page.getByText('No assignment is past its end date.')).toBeVisible();
  expect(applied).toEqual(['POST']);
});

test('an employee clocks in once for two assignments and sees the unscheduled warning', async ({
  page,
}) => {
  await session(page, ['time.clock'], { isEmployee: true });
  await mockMyTime(page);
  const lifeguard = assignmentView('assignment-3', 'Lifeguard', {
    id: ORG,
    name: 'Northwind Academy',
  });
  const bodies: unknown[] = [];
  await page.route(`${API}/time/me/status`, (route) =>
    json(route, {
      state: 'OFF_CLOCK',
      serverTime: new Date().toISOString(),
      currentTimeEntry: null,
      currentAssignment: null,
      currentBreakEntry: null,
      breakStartedAt: null,
      clockedInAt: null,
      eligibleAssignments: [coordinator, lifeguard],
      activeExceptions: [],
      availableActions: ['CLOCK_IN'],
      attendanceModes: [],
    }),
  );
  await page.route(`${API}/time/me/clock-in`, (route) => {
    bodies.push(route.request().postDataJSON());
    return json(route, {
      state: 'CLOCKED_IN',
      warnings: [{ code: 'UNSCHEDULED_WORK', message: 'No published scheduled shift matched.' }],
    });
  });

  await page.goto('/time');
  const form = page.getByRole('form', { name: 'Clock in' });
  await form.getByLabel('Assignment').selectOption('assignment-1');
  const covering = form.getByRole('group', { name: 'Also covering (optional)' });
  await covering.getByRole('checkbox', { name: /Lifeguard/ }).check();
  await checkDesktopAndTablet(page);
  await form.getByRole('button', { name: 'Clock In (2 assignments)' }).click();
  await expect(
    page.getByText('Clocked in, covering 2 assignments (time counted once).'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'No published shift matched this clock-in. It was recorded and flagged for review.',
    ),
  ).toBeVisible();
  expect(bodies).toEqual([
    {
      employmentAssignmentId: 'assignment-1',
      additionalEmploymentAssignmentIds: ['assignment-3'],
    },
  ]);
});

test('holidays are marked on My Schedule and on the manager grid, in words', async ({ page }) => {
  const today = todayInToronto();
  await session(page, [...SCHEDULING_PERMISSIONS, 'time.clock'], { isEmployee: true });
  await mockMyTime(page);
  await mockScheduling(page);
  const holidays = [
    { date: today, name: 'Founders Day', kind: 'STATUTORY_HOLIDAY', organizationId: ORG },
  ];
  await page.route(path('/scheduling/me'), (route) =>
    json(route, {
      employeeId: 'employee-1',
      range: { from: today, to: today },
      holidays,
      items: [],
    }),
  );
  await page.goto('/schedule');
  const listRegion = page.getByRole('region', { name: 'Holidays in these two weeks' });
  await expect(listRegion).toContainText('Holiday: Founders Day');
  await checkDesktopAndTablet(page);

  await page.route(path('/scheduling'), (route) => {
    const params = new URL(route.request().url()).searchParams;
    return json(route, {
      range: { from: params.get('from'), to: params.get('to') },
      holidays,
      items: [],
      nextAfterId: null,
    });
  });
  await page.goto('/admin/scheduling');
  await expect(page.getByText('Holiday: Founders Day').first()).toBeVisible();
  await checkDesktopAndTablet(page);
});

test('a scheduling edit form takes focus and gives it back on cancel', async ({ page }) => {
  await session(page, SCHEDULING_PERMISSIONS);
  await mockScheduling(page);
  await page.route(path('/schedule-policies'), (route) =>
    json(route, {
      items: [
        {
          id: 'pol-future',
          scopeType: 'ORGANIZATION',
          organizationId: ORG,
          organizationalUnitId: null,
          departmentId: null,
          teamId: null,
          name: 'Winter rules',
          effectiveFrom: '2099-01-01',
          effectiveTo: null,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          generationHorizonDays: null,
          defaultSchedulePeriod: null,
          autoCreateSchedules: null,
          unscheduledWorkMode: null,
          clockInEarlyMinutes: null,
          clockInLateMinutes: null,
          overlapConflictSeverity: null,
          minimumRestMinutes: 480,
          maximumShiftDurationMinutes: null,
          requireWorkLocation: null,
          allowManagerConflictOverride: null,
        },
      ],
      nextAfterId: null,
    }),
  );
  await page.goto('/admin/scheduling/policies');
  const edit = page.getByRole('button', { name: /^Edit Winter rules/ });
  await edit.focus();
  await page.keyboard.press('Enter');
  const form = page.getByRole('form', { name: 'Edit Winter rules' });
  await expect(form.getByLabel('Name (optional)')).toBeFocused();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await expect(edit).toBeFocused();
});
