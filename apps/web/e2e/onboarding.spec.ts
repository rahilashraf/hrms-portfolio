import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'onboarding-user',
  personId: 'person-onboarding-user',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Matches an API path regardless of its query string. */
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn
      ? json(route, { accessToken: 'onboarding-token', identity }, 201)
      : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'onboarding-token', identity }, 201);
  });
  await page.route('**/auth/me', (route) =>
    signedIn ? json(route, identity) : json(route, {}, 401),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: 'org-1' }],
      })),
    }),
  );
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const noActions = {
  canStart: false,
  canComplete: false,
  canAcknowledge: false,
  canWaive: false,
  canReopen: false,
  canReassign: false,
};

type Status = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'WAIVED';

function task(id: string, title: string, status: Status, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workflowId: 'wf-1',
    sortOrder: 10,
    title,
    description: null,
    category: 'PAPERWORK',
    ownerType: 'EMPLOYEE',
    owner: { userId: identity.id, email: identity.email },
    dueDate: '2026-11-03',
    overdue: false,
    required: true,
    evidenceRequired: false,
    acknowledgementRequired: false,
    acknowledgementStatement: null,
    reference: null,
    systemAction: 'NONE',
    status,
    startedAt: null,
    completedAt: status === 'COMPLETED' ? '2026-10-06T12:00:00.000Z' : null,
    completedByUserId: null,
    completionNote: null,
    evidenceReference: null,
    completionSource: status === 'COMPLETED' ? 'MANUAL' : null,
    acknowledgedAt: null,
    waivedAt: status === 'WAIVED' ? '2026-10-06T12:00:00.000Z' : null,
    waiverReason: null,
    reopenCount: 0,
    actions: noActions,
    ...overrides,
  };
}

const progress = (done: number, total: number) => ({
  total,
  done,
  percent: Math.floor((done * 100) / total),
  requiredTotal: total,
  requiredDone: done,
  overdue: 0,
  allDone: done === total,
  requiredComplete: done === total,
});

const STATEMENT =
  'I have read the Staff Handbook and understand the workplace policies it sets out.';

test('an employee acknowledges the handbook and completes a task on My Onboarding', async ({
  page,
}) => {
  await mockSession(page, []);
  let acknowledged = false;
  let completed = false;
  let ackBody: unknown = null;
  let completeBody: unknown = null;
  const detail = () => {
    const done = Number(acknowledged) + Number(completed);
    return {
      id: 'wf-1',
      view: 'EMPLOYEE',
      kind: 'ONBOARDING',
      status: done === 2 ? 'COMPLETED' : 'ACTIVE',
      templateName: 'Staff onboarding',
      anchorDate: '2026-11-02',
      plannedEndDate: null,
      startedAt: '2026-10-01T12:00:00.000Z',
      completedAt: null,
      cancelledAt: null,
      organization: { id: 'org-1', name: 'Camp' },
      employee: { id: 'emp-1', employeeNumber: 'E-100', displayName: 'Ada Lovelace' },
      position: { id: 'pos-1', name: 'Counsellor' },
      progress: progress(done, 2),
      tasks: [
        task('tk-ack', 'Staff Handbook', acknowledged ? 'COMPLETED' : 'NOT_STARTED', {
          category: 'POLICY',
          acknowledgementRequired: true,
          acknowledgementStatement: STATEMENT,
          acknowledgedAt: acknowledged ? '2026-10-06T12:00:00.000Z' : null,
          reference: {
            type: 'GOOGLE_DOC',
            url: 'https://docs.google.com/document/d/handbook',
            externalId: null,
            label: 'Staff Handbook 2026',
          },
          actions: { ...noActions, canAcknowledge: !acknowledged },
        }),
        task('tk-bank', 'Submit banking details', completed ? 'COMPLETED' : 'NOT_STARTED', {
          category: 'PAYROLL',
          evidenceRequired: true,
          dueDate: '2026-10-01',
          overdue: !completed,
          evidenceReference: completed ? 'FORM-42' : null,
          actions: completed ? noActions : { ...noActions, canStart: true, canComplete: true },
        }),
      ],
      actions: { canManage: false, canCancel: false, canComplete: false },
    };
  };
  await page.route(path('/onboarding/me'), (route) => json(route, { items: [detail()] }));
  await page.route(path('/onboarding/me/tasks'), (route) => json(route, { items: [] }));
  await page.route(path('/onboarding/tasks/tk-ack/acknowledge'), (route) => {
    ackBody = route.request().postDataJSON();
    acknowledged = true;
    return json(route, detail(), 201);
  });
  await page.route(path('/onboarding/tasks/tk-bank/complete'), (route) => {
    completeBody = route.request().postDataJSON();
    completed = true;
    return json(route, detail(), 201);
  });

  await signIn(page);
  await expect(page.getByRole('link', { name: 'Onboarding', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'My Onboarding' }).click();
  await expect(page.getByRole('heading', { name: 'My onboarding' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff Handbook 2026' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await expect(page.getByText('0% · 0 of 2 tasks done', { exact: false })).toBeVisible();

  const ack = page.getByRole('form', { name: 'Acknowledge Staff Handbook' });
  await expect(ack.getByText(STATEMENT)).toBeVisible();
  await expect(ack.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
  await ack.getByLabel('I acknowledge the statement above.').check();
  await ack.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Acknowledgement recorded.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Acknowledge Staff Handbook' })).toHaveCount(0);
  expect(ackBody).toEqual({ statementAccepted: true });

  const bank = page.getByRole('listitem', { name: 'Task Submit banking details' });
  await expect(bank.getByText('Overdue')).toBeVisible();
  await bank.getByRole('button', { name: 'Complete' }).click();
  await bank.getByLabel('Evidence reference').fill('FORM-42');
  await bank.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByText('Task completed.')).toBeVisible();
  await expect(page.getByText('100% · 2 of 2 tasks done', { exact: false })).toBeVisible();
  expect(completeBody).toEqual({ note: null, evidenceReference: 'FORM-42' });
});

test('HR reviews the offboarding dashboard, opens a workflow and waives a task', async ({
  page,
}) => {
  await mockSession(page, ['offboarding.manage']);
  let waived: string | null = null;
  const detail = () => ({
    id: 'wf-9',
    view: 'HR',
    kind: 'OFFBOARDING',
    status: 'ACTIVE',
    templateName: 'Staff offboarding',
    templateCode: 'STAFF-OFF',
    anchorDate: '2026-10-01',
    plannedEndDate: '2026-10-01',
    startedAt: '2026-09-15T12:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    reason: 'Returning to school',
    recruitmentHireId: null,
    cancellationReason: null,
    organization: { id: 'org-1', name: 'Camp' },
    employee: { id: 'emp-2', employeeNumber: 'E-200', displayName: 'Alan Turing' },
    position: { id: 'pos-1', name: 'Counsellor' },
    progress: progress(waived ? 1 : 0, 2),
    coreHr: {
      assignmentStatus: 'ACTIVE',
      assignmentStartDate: '2025-06-01',
      assignmentEndDate: null,
      employeeStatus: 'ACTIVE',
      department: { id: 'd-1', name: 'Programs' },
      team: null,
      workLocation: null,
      manager: { assignmentId: 'asg-m', displayName: 'Grace Hopper' },
      endDateRecorded: false,
    },
    events: [
      {
        id: 'ev-1',
        taskId: null,
        type: 'STARTED',
        fromStatus: null,
        toStatus: 'ACTIVE',
        note: null,
        actorUserId: identity.id,
        createdAt: '2026-09-15T12:00:00.000Z',
      },
      ...(waived
        ? [
            {
              id: 'ev-2',
              taskId: 'tk-keys',
              type: 'TASK_WAIVED',
              fromStatus: 'NOT_STARTED',
              toStatus: 'WAIVED',
              note: waived,
              actorUserId: identity.id,
              createdAt: '2026-10-06T12:00:00.000Z',
            },
          ]
        : []),
    ],
    tasks: [
      task('tk-keys', 'Collect building keys', waived ? 'WAIVED' : 'NOT_STARTED', {
        workflowId: 'wf-9',
        category: 'EQUIPMENT',
        ownerType: 'MANAGER',
        owner: { userId: 'u-m', email: 'grace@example.com' },
        dueDate: '2026-10-01',
        overdue: !waived,
        systemAction: 'COLLECT_EQUIPMENT',
        waiverReason: waived,
        actions: waived
          ? { ...noActions, canReopen: true }
          : { ...noActions, canStart: true, canComplete: true, canWaive: true, canReassign: true },
      }),
      task('tk-exit', 'Exit interview', 'NOT_STARTED', {
        workflowId: 'wf-9',
        category: 'MEETING',
        ownerType: 'HR',
        owner: null,
        actions: {
          ...noActions,
          canStart: true,
          canComplete: true,
          canWaive: true,
          canReassign: true,
        },
      }),
    ],
    actions: { canManage: true, canCancel: true, canComplete: false },
  });
  await page.route(path('/onboarding/organizations'), (route) =>
    json(route, {
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: { canManageTemplates: false, onboarding: false, offboarding: true },
        },
      ],
    }),
  );
  await page.route(path('/onboarding/workflows'), (route) =>
    json(route, {
      today: '2026-10-06',
      kind: 'OFFBOARDING',
      items: [
        {
          id: 'wf-9',
          status: 'ACTIVE',
          templateName: 'Staff offboarding',
          anchorDate: '2026-10-01',
          plannedEndDate: '2026-10-01',
          employee: { id: 'emp-2', employeeNumber: 'E-200', displayName: 'Alan Turing' },
          position: { id: 'pos-1', name: 'Counsellor' },
          assignmentStatus: 'ACTIVE',
          assignmentEndDate: null,
          progress: { ...progress(0, 2), overdue: 1 },
        },
      ],
      attention: {
        overdueTasks: [
          {
            workflowId: 'wf-9',
            taskId: 'tk-keys',
            title: 'Collect building keys',
            dueDate: '2026-10-01',
            ownerType: 'MANAGER',
            owner: 'grace@example.com',
            employee: 'Alan Turing',
          },
        ],
        unassignedTasks: [],
        upcoming: [],
        coreHrPending: [
          { workflowId: 'wf-9', employee: 'Alan Turing', plannedEndDate: '2026-10-01' },
        ],
      },
    }),
  );
  await page.route(path('/onboarding/workflows/wf-9'), (route) => json(route, detail()));
  await page.route(path('/onboarding/tasks/tk-keys/waive'), (route) => {
    waived = (route.request().postDataJSON() as { reason: string }).reason;
    return json(route, detail(), 201);
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Onboarding', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Onboarding & offboarding' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Offboarding' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const pending = page.getByRole('region', { name: 'Awaiting Core HR' });
  await expect(pending.getByText(/Core HR has not ended the assignment yet/)).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Overdue tasks' })
      .getByText('Alan Turing — Collect building keys'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open Alan Turing' }).click();

  await expect(page).toHaveURL(/\/onboarding\/workflows\/wf-9$/);
  await expect(page.getByRole('heading', { name: 'Offboarding: Alan Turing' })).toBeVisible();
  await expect(page.getByText('Reason: Returning to school')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Core HR' }).getByRole('note')).toContainText(
    'Offboarding never ends employment',
  );
  const keys = page.getByRole('row', { name: 'Task Collect building keys' });
  await keys.getByRole('button', { name: 'Waive' }).click();
  await keys.getByLabel('Reason for waiving').fill('Keys were never issued');
  await keys.getByRole('button', { name: 'Confirm waiver' }).click();
  await expect(page.getByText('Task waived.')).toBeVisible();
  await expect(keys.getByText('Waived: Keys were never issued')).toBeVisible();
  await expect(keys.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'History' }).getByText(/Task waived/),
  ).toBeVisible();
  expect(waived).toBe('Keys were never issued');
});

test('a user without onboarding permissions sees no Onboarding link and is denied the page', async ({
  page,
}) => {
  await mockSession(page, ['employee.read', 'recruitment.read']);
  await page.route(path('/onboarding/organizations'), (route) => json(route, { items: [] }));
  await signIn(page);
  await expect(page.getByRole('link', { name: 'My Onboarding' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Onboarding', exact: true })).toHaveCount(0);
  await page.goto('/admin/onboarding');
  await expect(page.getByText('You do not have permission to view onboarding.')).toBeVisible();
});
