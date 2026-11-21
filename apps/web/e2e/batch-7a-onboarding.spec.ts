import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 7A — onboarding against a mocked API: HR starts onboarding from an employee profile
 * link and from a recruitment hire (a restarted one) through the module-scoped pickers (no ids
 * typed), sees offboarding candidates including an ended assignment and a dashboard that says it
 * is truncated; reassigns a manager task to "no owner"; an employee shows completed assigned
 * tasks and is told when HR records their own tasks. axe (serious/critical) and no page-wide
 * horizontal scroll at desktop, tablet and a 375 px phone.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const ASG = '33333333-3333-4333-8333-333333333333';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function session(page: Page, permissions: string[], isEmployee: boolean) {
  const identity = {
    id: 'user-hr',
    personId: 'person-hr',
    email: 'hr@example.com',
    status: 'ACTIVE',
    emailVerifiedAt: null,
    mustChangePassword: false,
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '7a-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Morgan Reedley' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['ONBOARDING', 'RECRUITMENT'],
          permissions,
          isEmployee,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

async function checkAt(page: Page) {
  for (const size of Object.values(VIEWPORTS)) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

const noActions = {
  canStart: false,
  canComplete: false,
  canAcknowledge: false,
  canWaive: false,
  canReopen: false,
  canReassign: false,
};
const progress = {
  total: 2,
  done: 0,
  percent: 0,
  requiredTotal: 2,
  requiredDone: 0,
  overdue: 0,
  allDone: false,
  requiredComplete: false,
};

function task(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workflowId: 'wf-1',
    sortOrder: 10,
    title,
    description: null,
    category: 'PAPERWORK',
    ownerType: 'EMPLOYEE',
    owner: { userId: 'user-hr', email: 'hr@example.com' },
    dueDate: '2026-11-03',
    overdue: false,
    required: true,
    evidenceRequired: false,
    acknowledgementRequired: false,
    acknowledgementStatement: null,
    reference: null,
    systemAction: 'NONE',
    status: 'NOT_STARTED',
    startedAt: null,
    completedAt: null,
    completedByUserId: null,
    completionNote: null,
    evidenceReference: null,
    completionSource: null,
    acknowledgedAt: null,
    waivedAt: null,
    waiverReason: null,
    reopenCount: 0,
    actions: noActions,
    ...overrides,
  };
}

function workflow(
  id: string,
  view: string,
  tasks: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    view,
    kind: 'ONBOARDING',
    status: 'ACTIVE',
    templateName: 'Staff onboarding',
    templateCode: 'STAFF',
    anchorDate: '2026-11-02',
    plannedEndDate: null,
    startedAt: '2026-10-01T12:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    reason: null,
    recruitmentHireId: null,
    cancellationReason: null,
    organization: { id: ORG, name: 'Northwind Academy' },
    employee: { id: EMP, employeeNumber: 'E-9', displayName: 'Ada Lovelace' },
    position: { id: 'pos-1', name: 'Counsellor' },
    progress,
    tasks,
    events: [],
    actions: { canManage: view === 'HR', canCancel: view === 'HR', canComplete: false },
    ...overrides,
  };
}

const dashboard = (kind: string) => ({
  today: '2026-10-06',
  kind,
  truncated: true,
  items: [
    {
      id: 'wf-1',
      status: 'ACTIVE',
      templateName: 'Staff onboarding',
      anchorDate: '2026-11-02',
      plannedEndDate: null,
      employee: { id: EMP, employeeNumber: 'E-9', displayName: 'Ada Lovelace' },
      position: { id: 'pos-1', name: 'Counsellor' },
      assignmentStatus: 'PLANNED',
      assignmentEndDate: null,
      progress,
    },
  ],
  attention: { overdueTasks: [], unassignedTasks: [], upcoming: [], coreHrPending: [] },
});

async function adminServer(page: Page) {
  const state = {
    started: null as null | Record<string, unknown>,
    fromHire: null as null | string,
    optionCalls: [] as Array<Record<string, string>>,
  };
  await page.route(path('/onboarding/organizations'), (route) =>
    json(route, {
      items: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          actions: {
            canManageTemplates: false,
            onboarding: true,
            offboarding: true,
            canImportOnboarding: true,
            canImportOffboarding: true,
          },
        },
      ],
    }),
  );
  await page.route(path('/onboarding/workflows'), (route) =>
    json(route, dashboard(new URL(route.request().url()).searchParams.get('kind') ?? 'ONBOARDING')),
  );
  await page.route(path('/onboarding/templates'), (route) => json(route, { items: [] }));
  await page.route(path(`/onboarding/employees/${EMP}/workflows`), (route) =>
    json(route, { items: [] }),
  );
  await page.route(path(`/employees/${EMP}`), (route) =>
    json(route, {
      id: EMP,
      employeeNumber: 'E-9',
      person: { firstName: 'Ada', lastName: 'Lovelace', middleName: null, preferredName: null },
      assignments: {
        current: [],
        historical: [],
        cancelled: [],
        upcoming: [
          {
            id: ASG,
            status: 'PLANNED',
            isPrimary: true,
            startDate: '2026-11-02',
            position: { id: 'pos-1', name: 'Counsellor', code: 'C' },
            organization: { id: ORG, name: 'Northwind Academy', code: 'NWA' },
          },
        ],
      },
    }),
  );
  await page.route(path('/onboarding/options'), (route) => {
    const params = Object.fromEntries(new URL(route.request().url()).searchParams);
    state.optionCalls.push(params);
    if (params.kind === 'hire')
      return json(route, {
        items: [
          {
            id: 'hire-1',
            label: 'Grace Hopper',
            description: 'E-12 · Counsellor · Starts 2026-11-02',
            restartable: true,
          },
        ],
        nextAfterId: null,
      });
    if (params.workflowKind === 'OFFBOARDING')
      return json(route, {
        items: [
          {
            id: 'asg-ended',
            label: 'Alan Turing',
            description: 'E-3 · Counsellor · Ended 2026-09-30',
          },
        ],
        nextAfterId: null,
      });
    return json(route, {
      items: [
        { id: ASG, label: 'Ada Lovelace', description: 'E-9 · Counsellor · Starts 2026-11-02' },
      ],
      nextAfterId: null,
    });
  });
  await page.route(path('/onboarding/workflows/onboarding'), async (route) => {
    state.started = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, workflow('wf-1', 'HR', []), 201);
  });
  await page.route(path('/onboarding/from-hire/hire-1'), (route) => {
    state.fromHire = 'hire-1';
    return json(
      route,
      {
        ...workflow('wf-new', 'HR', [], {
          employee: { id: 'emp-12', employeeNumber: 'E-12', displayName: 'Grace Hopper' },
        }),
        created: true,
        restartedFromWorkflowId: 'wf-old',
      },
      201,
    );
  });
  return state;
}

test('HR starts onboarding from a profile link and a hire through the scoped pickers', async ({
  page,
}) => {
  await session(page, ['onboarding.read', 'onboarding.manage', 'offboarding.manage'], false);
  const state = await adminServer(page);

  // The dashboard says it lists only part of the workflows.
  await page.goto('/admin/onboarding');
  await expect(page.getByRole('heading', { name: 'Onboarding & offboarding' })).toBeVisible();
  await expect(
    page.getByRole('note').filter({ hasText: 'More are within your access' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Import' })).toBeVisible();
  await checkAt(page);

  // From the employee profile: preselected, nothing started until HR starts it.
  await page.goto(
    `/admin/onboarding?onboardEmployee=${EMP}&onboardOrganization=${ORG}&onboardAssignment=${ASG}#start`,
  );
  const start = page.getByRole('form', { name: 'Start onboarding' });
  await expect(start.getByRole('note')).toContainText('Nothing has started');
  await expect(start.getByRole('combobox', { name: /Employment/ })).toHaveValue('Ada Lovelace');
  expect(state.started).toBeNull();
  await checkAt(page);
  await start.getByRole('button', { name: 'Start onboarding' }).click();
  await expect.poll(() => state.started).toEqual({ employmentAssignmentId: ASG, templateId: null });
  await expect(page.getByRole('link', { name: 'Open Onboarding for Ada Lovelace' })).toBeVisible();

  // Offboarding candidates include an ended assignment.
  const off = page.getByRole('form', { name: 'Start offboarding' });
  await off.getByRole('combobox', { name: /Employment/ }).fill('Alan');
  await expect(page.getByRole('option', { name: /Alan Turing.*Ended 2026-09-30/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // A recruitment hire, chosen by name; its earlier onboarding was cancelled.
  const hire = page.getByRole('form', { name: 'Start onboarding from a hire' });
  await expect(hire.getByLabel('Hire ID')).toHaveCount(0);
  await hire.getByRole('combobox', { name: /Hire/ }).fill('Grace');
  await page.getByRole('option', { name: /Grace Hopper.*Earlier onboarding cancelled/ }).click();
  await hire.getByRole('button', { name: 'Start from hire' }).click();
  await expect.poll(() => state.fromHire).toBe('hire-1');
  await expect(
    page.getByRole('link', { name: /Onboarding restarted.*Grace Hopper/ }),
  ).toHaveAttribute('href', '/onboarding/workflows/wf-new');
  expect(state.optionCalls.some((call) => call.kind === 'hire')).toBe(true);
  await checkAt(page);
});

test('HR gives a manager task no owner; HR handles it', async ({ page }) => {
  await session(page, ['onboarding.read', 'onboarding.manage'], false);
  let reassigned: unknown = 'none';
  const detail = workflow('wf-1', 'HR', [
    task('tk-mgr', 'Welcome meeting', {
      ownerType: 'MANAGER',
      owner: { userId: 'u-m', email: 'grace@example.com' },
      actions: { ...noActions, canReassign: true },
    }),
    task('tk-it', 'Set up accounts', {
      ownerType: 'SPECIFIC_USER',
      owner: { userId: 'u-it', email: 'it@example.com' },
      actions: { ...noActions, canReassign: true },
    }),
  ]);
  await page.route(path('/onboarding/workflows/wf-1'), (route) => json(route, detail));
  await page.route(path('/onboarding/tasks/tk-mgr/owner'), (route) => {
    reassigned = (route.request().postDataJSON() as { ownerUserId: unknown }).ownerUserId;
    return json(route, detail);
  });
  await page.goto('/onboarding/workflows/wf-1');
  const it = page.getByRole('row', { name: 'Task Set up accounts' });
  await it.getByRole('button', { name: 'Reassign' }).click();
  await expect(it.getByRole('checkbox')).toHaveCount(0);
  const manager = page.getByRole('row', { name: 'Task Welcome meeting' });
  await manager.getByRole('button', { name: 'Reassign' }).click();
  await manager.getByLabel(/Remove the owner \(HR handles it/).check();
  await checkAt(page);
  await manager.getByRole('button', { name: 'Save owner' }).click();
  await expect.poll(() => reassigned).toBeNull();
});

test('an employee shows completed assigned tasks and learns HR records their own tasks', async ({
  page,
}) => {
  await session(page, [], true);
  const includeDone: string[] = [];
  await page.route(path('/onboarding/me'), (route) =>
    json(route, {
      items: [
        workflow('wf-1', 'EMPLOYEE', [task('tk-bank', 'Submit banking details')], {
          employee: { id: EMP, employeeNumber: 'E-9', displayName: 'Ada Lovelace' },
        }),
      ],
    }),
  );
  await page.route(path('/onboarding/me/tasks'), (route) => {
    const done = new URL(route.request().url()).searchParams.get('includeDone') ?? 'false';
    includeDone.push(done);
    return json(route, {
      items:
        done === 'true'
          ? [
              {
                ...task('tk-laptop', 'Prepare laptop', {
                  ownerType: 'SPECIFIC_USER',
                  status: 'COMPLETED',
                  completedAt: '2026-10-05T12:00:00.000Z',
                }),
                workflow: {
                  id: 'wf-2',
                  kind: 'ONBOARDING',
                  status: 'ACTIVE',
                  anchorDate: '2026-11-02',
                  organization: { id: ORG, name: 'Northwind Academy' },
                  employee: { id: 'emp-3', displayName: 'Alan Turing' },
                },
              },
            ]
          : [],
    });
  });
  await page.goto('/onboarding');
  const own = page.getByRole('listitem', { name: 'Task Submit banking details' });
  await expect(own.getByRole('note')).toContainText('HR record this task for you');
  await page.getByLabel('Show completed tasks').check();
  await expect(page.getByRole('listitem', { name: 'Assigned task Prepare laptop' })).toBeVisible();
  expect(includeDone).toContain('true');
  await checkAt(page);
});
