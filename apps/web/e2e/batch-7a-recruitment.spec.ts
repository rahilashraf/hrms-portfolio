import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 7A — recruitment without raw ids, against a stateful mocked API. A standard Recruiter
 * (recruitment.* only: no employee.read, no role.assign) creates an opening entirely from
 * pickers (GET /recruitment/options), opens its details, imports intake submissions (the report
 * survives the refresh), pages the intake history, and on an application reschedules an
 * interview, reads its feedback history, adds an interviewer from the staff picker and cancels
 * an interview through the confirmation dialog. /recruitment opens Recruitment. axe
 * (serious/critical) and no page-wide horizontal scroll at desktop, tablet and a 375 px phone.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
const RECRUITER = [
  'recruitment.read',
  'recruitment.manage',
  'recruitment.pipeline.manage',
  'recruitment.intake.manage',
];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function session(page: Page) {
  const identity = {
    id: 'user-rec',
    personId: 'person-rec',
    email: 'recruiter@example.com',
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
      permissions: RECRUITER.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Riley Recruiter' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['RECRUITMENT'],
          permissions: RECRUITER,
          isEmployee: false,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
  // Core HR pickers are refused to a Recruiter: nothing here may depend on them.
  for (const forbidden of ['/employees', '/employees/options/positions', '/authorization/users'])
    await page.route(path(forbidden), (route) => json(route, { message: 'Forbidden' }, 403));
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

const organization = {
  id: ORG,
  name: 'Northwind Academy',
  code: 'NWA',
  timezone: 'America/Toronto',
  actions: {
    canManagePipeline: true,
    canManageIntake: true,
    canReadAllCandidates: true,
    canManageCandidates: true,
    canCreateOpenings: true,
  },
};

const opening = (overrides: Record<string, unknown> = {}) => ({
  id: 'op-1',
  organization: { id: ORG, name: 'Northwind Academy' },
  code: 'REQ-1',
  title: 'Classroom assistant',
  description: null,
  status: 'OPEN',
  statusReason: null,
  employmentType: 'FULL_TIME',
  openingCount: 2,
  hiredCount: 0,
  position: null,
  organizationalUnit: { id: 'unit-1', name: 'Elementary' },
  department: { id: 'dept-a', name: 'Primary' },
  team: { id: 'team-a', name: 'Grade 3' },
  workLocation: { id: 'wl-1', name: 'Toronto campus' },
  hiringManager: { id: 'emp-2', displayName: 'Grace Hopper' },
  recruiterUserId: null,
  expectedStartDate: null,
  postedOn: '2026-09-01',
  closesOn: '2026-12-31',
  compensation: null,
  openedAt: '2026-09-01T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  actions: { canManage: true, canApproveOffers: false, canHire: false, isHiringManager: false },
  applications: { ACTIVE: 1 },
  ...overrides,
});

const OPTIONS: Record<string, unknown[]> = {
  team: [
    {
      id: 'team-a',
      label: 'Grade 3',
      description: 'G3',
      placement: { organizationalUnitId: 'unit-1', departmentId: 'dept-a', teamId: 'team-a' },
    },
  ],
  workLocation: [{ id: 'wl-1', label: 'Toronto campus', description: 'TOR' }],
  hiringManager: [{ id: 'emp-2', label: 'Grace Hopper', description: 'E-002' }],
  staff: [{ id: 'user-ken', label: 'Ken Thompson', description: 'E-003' }],
  position: [],
  unit: [],
  department: [],
};

async function recruitmentRoutes(page: Page) {
  const state = { created: null as unknown, imported: false };
  await page.route(path('/recruitment/organizations'), (route) =>
    json(route, { items: [organization] }),
  );
  await page.route(path('/recruitment/dashboard'), (route) =>
    json(route, {
      today: '2026-10-06',
      openings: { byStatus: { OPEN: 1 }, total: 1 },
      pipeline: [],
      attention: {
        overdueFeedback: [],
        upcomingInterviews: [],
        offersAwaitingApproval: [],
        offersExpiringSoon: [],
        acceptedNotHired: [],
        staleApplications: [],
        openingsPastClose: [],
        pendingIntake: 1,
      },
    }),
  );
  await page.route(path('/recruitment/options'), (route) => {
    const url = new URL(route.request().url());
    return json(route, {
      items: OPTIONS[url.searchParams.get('kind') ?? ''] ?? [],
      nextAfterId: null,
    });
  });
  await page.route(path('/recruitment/openings'), (route) => {
    if (route.request().method() === 'POST') {
      state.created = route.request().postDataJSON();
      return json(route, opening({ id: 'op-9', status: 'DRAFT' }), 201);
    }
    return json(route, { items: [opening()] });
  });
  await page.route(path('/recruitment/openings/op-1'), (route) =>
    json(route, {
      ...opening(),
      events: [
        {
          id: 'ev-1',
          type: 'STATUS_CHANGED',
          fromStatus: 'DRAFT',
          toStatus: 'OPEN',
          changedFields: null,
          reason: null,
          actorUserId: 'user-rec',
          createdAt: '2026-09-01T12:00:00.000Z',
        },
      ],
    }),
  );
  return state;
}

const submission = (id: string, status: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sourceId: 'src-1',
  externalResponseId: `resp-${id}`,
  status,
  reason: status === 'PENDING_OPENING' ? 'OPENING_NOT_FOUND' : null,
  submission: {
    openingCode: 'REQ-404',
    candidate: { firstName: 'Mary', lastName: `Jackson ${id}`, email: `${id}@example.org` },
  },
  submittedAt: '2026-10-01T00:00:00.000Z',
  correctionCount: 0,
  candidateId: null,
  applicationId: status === 'APPLIED' ? `app-${id}` : null,
  receivedAt: '2026-10-01T00:00:00.000Z',
  lastReceivedAt: '2026-10-01T00:00:00.000Z',
  resolvedAt: status === 'PENDING_OPENING' ? null : '2026-10-02T00:00:00.000Z',
  ...overrides,
});

test('a Recruiter creates an opening from pickers, reads its details and works intake', async ({
  page,
}) => {
  await session(page);
  const state = await recruitmentRoutes(page);
  await page.route(path('/recruitment/intake-sources'), (route) =>
    json(route, {
      items: [
        {
          id: 'src-1',
          organizationId: ORG,
          code: 'CAREERS',
          name: 'Careers form',
          provider: 'GOOGLE_FORMS',
          externalResourceId: 'form-1',
          resourceUrl: null,
          defaultOpeningId: null,
          lastSyncedAt: null,
          lastSyncStatus: null,
          lastSyncMessage: null,
          archivedAt: null,
          pendingOpening: 1,
        },
      ],
    }),
  );
  await page.route(path('/recruitment/intake-sources/src-1/import'), (route) => {
    state.imported = true;
    return json(
      route,
      {
        sourceId: 'src-1',
        received: 2,
        counts: { CREATED: 1, PENDING_OPENING: 1 },
        outcomes: [
          { externalResponseId: 'r1', outcome: 'CREATED' },
          { externalResponseId: 'r2', outcome: 'PENDING_OPENING', reason: 'OPENING_NOT_FOUND' },
        ],
      },
      201,
    );
  });
  await page.route(path('/recruitment/intake'), (route) => {
    const params = new URL(route.request().url()).searchParams;
    const status = params.get('status');
    if (status === 'PENDING_OPENING')
      return json(route, { items: [submission('s1', 'PENDING_OPENING')], nextAfterId: null });
    return json(
      route,
      params.get('afterId')
        ? { items: [submission('s3', 'APPLIED')], nextAfterId: null }
        : { items: [submission('s2', 'APPLIED')], nextAfterId: 's2' },
    );
  });

  await page.goto('/recruitment');
  await expect(page).toHaveURL(/\/admin\/recruitment/);
  await expect(page.getByRole('heading', { name: 'Recruitment', exact: true })).toBeVisible();

  // ── Openings: create from pickers only ───────────────────────────────────
  await page.getByRole('tab', { name: 'Openings' }).click();
  await page.getByRole('button', { name: 'New opening' }).click();
  const form = page.getByRole('form', { name: 'Create opening' });
  await form.getByLabel('Requisition code').fill('REQ-7A');
  await form.getByLabel('Job title').fill('Classroom assistant');
  await form.getByRole('combobox', { name: 'Team (optional)' }).fill('Gr');
  await page.getByRole('option', { name: /Grade 3/ }).click();
  await form.getByRole('combobox', { name: 'Work location (optional)' }).fill('Tor');
  await page.getByRole('option', { name: /Toronto campus/ }).click();
  await form.getByRole('combobox', { name: 'Hiring manager (optional)' }).fill('Grace');
  await page.getByRole('option', { name: /Grace Hopper/ }).click();
  await expect(form.getByRole('textbox', { name: /\bID\b/ })).toHaveCount(0);
  await checkAt(page);
  await form.getByRole('button', { name: 'Create opening' }).click();
  await expect(page.getByText('Opening created as a draft.')).toBeVisible();
  expect(state.created).toMatchObject({
    organizationId: ORG,
    code: 'REQ-7A',
    organizationalUnitId: 'unit-1',
    departmentId: 'dept-a',
    teamId: 'team-a',
    workLocationId: 'wl-1',
    hiringManagerEmployeeId: 'emp-2',
  });

  // ── Opening details ──────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Details of Classroom assistant' }).click();
  const details = page.getByRole('region', { name: 'Opening details' });
  await expect(details.getByText('Grace Hopper')).toBeVisible();
  await expect(details.getByRole('list', { name: 'Opening history' })).toContainText('Open');
  await checkAt(page);

  // ── Intake: the import report survives the refresh; history pages ────────
  await page.getByRole('tab', { name: 'Intake' }).click();
  await page.getByRole('button', { name: 'Import submissions into Careers form' }).click();
  await page
    .getByRole('form', { name: 'Import submissions' })
    .getByLabel(/Submissions/)
    .fill('[{"externalResponseId":"r1"},{"externalResponseId":"r2"}]');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Submissions imported.')).toBeVisible();
  const report = page.getByRole('region', { name: 'Import report' });
  await expect(report).toContainText('Careers form: 2 received');
  await expect(report).toContainText('r2: Pending Opening — Opening Not Found');
  // Batch 10E-1: the applicant names the row (a row header in the shared DataTable).
  await expect(page.getByRole('rowheader', { name: /^Mary Jackson s1 / })).toBeVisible();
  await expect(report).toBeVisible();
  await checkAt(page);

  await page.getByLabel('Submission status').selectOption('APPLIED');
  await expect(page.getByRole('rowheader', { name: /^Mary Jackson s2 / })).toBeVisible();
  await page.getByRole('button', { name: 'Load more submissions' }).click();
  await expect(page.getByRole('rowheader', { name: /^Mary Jackson s3 / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more submissions' })).toHaveCount(0);
  await checkAt(page);
});

test('a Recruiter reschedules an interview, reads feedback history, adds an interviewer and confirms a cancellation', async ({
  page,
}) => {
  await session(page);
  await recruitmentRoutes(page);
  const calls: Record<string, unknown> = {};
  const interview = {
    id: 'int-1',
    applicationId: 'app-1',
    type: 'VIDEO',
    title: 'Panel interview',
    scheduledStart: '2026-10-20T15:00:00.000Z',
    durationMinutes: 45,
    location: null,
    meetingUrl: 'https://meet.example.com/abc',
    status: 'SCHEDULED',
    feedbackDueAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    interviewers: [{ userId: 'u-9', email: 'grace@example.org', feedbackSubmitted: false }],
    feedback: [],
    pendingFeedback: 1,
    feedbackOverdue: false,
    isInterviewer: false,
  };
  const application = {
    id: 'app-1',
    view: 'FULL',
    status: 'ACTIVE',
    source: 'DIRECT',
    sourceDetail: null,
    appliedAt: '2026-09-02T00:00:00.000Z',
    stageEnteredAt: '2026-09-10T00:00:00.000Z',
    stage: { id: 's-2', name: 'Interview', kind: 'INTERVIEW' },
    organization: { id: ORG, name: 'Northwind Academy' },
    opening: {
      id: 'op-1',
      code: 'REQ-1',
      title: 'Classroom assistant',
      status: 'OPEN',
      positionId: null,
      employmentType: 'FULL_TIME',
    },
    candidate: {
      id: 'cand-1',
      organizationId: ORG,
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      preferredName: null,
      status: 'ACTIVE',
      source: 'DIRECT',
      internal: false,
      internalEmployee: null,
      mergedIntoCandidateId: null,
      hired: false,
      email: 'ada@example.org',
      phone: null,
      location: null,
      notes: null,
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    interviews: [interview],
    documents: [],
    dispositionReason: null,
    dispositionAt: null,
    transitions: [],
    activity: [],
    hire: null,
    screening: null,
    offers: [],
    actions: {
      canManage: true,
      canMoveStage: false,
      canScreen: false,
      canScheduleInterview: true,
      canWithdraw: true,
      canReject: true,
      canCreateOffer: false,
      canApproveOffer: false,
      canHire: false,
    },
  };
  await page.route(path('/recruitment/applications/app-1'), (route) => json(route, application));
  await page.route(path('/recruitment/stages'), (route) => json(route, { items: [] }));
  await page.route(path('/recruitment/interviews/int-1'), (route) => {
    calls.reschedule = route.request().postDataJSON();
    return json(route, interview);
  });
  await page.route(path('/recruitment/interviews/int-1/feedback'), (route) =>
    json(route, {
      items: [
        {
          id: 'fb-1',
          interviewId: 'int-1',
          interviewerUserId: 'u-9',
          status: 'SUBMITTED',
          recommendation: 'YES',
          rating: 4,
          strengths: 'Calm with students',
          concerns: null,
          comments: null,
          submittedAt: '2026-10-01T00:00:00.000Z',
          revision: 1,
          reopenReason: null,
          supersededAt: '2026-10-02T00:00:00.000Z',
        },
      ],
    }),
  );
  await page.route(path('/recruitment/interviews/int-1/interviewers'), (route) => {
    calls.addInterviewer = route.request().postDataJSON();
    return json(route, interview, 201);
  });
  await page.route(path('/recruitment/interviews/int-1/cancel'), (route) => {
    calls.cancel = route.request().postDataJSON();
    return json(route, { ...interview, status: 'CANCELLED' }, 201);
  });

  await page.goto('/recruitment/applications/app-1');
  const card = page.getByRole('listitem', { name: 'Interview Panel interview' });
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Feedback history' }).click();
  const history = card.getByRole('region', { name: 'Feedback history of Panel interview' });
  await expect(history).toContainText('Revision 1');
  await expect(history).toContainText('Superseded');

  await card.getByRole('button', { name: 'Reschedule' }).click();
  const reschedule = card.getByRole('form', { name: 'Reschedule Panel interview' });
  await reschedule.getByLabel('New start').fill('2026-10-22T10:00');
  await checkAt(page);
  await reschedule.getByRole('button', { name: 'Save new time' }).click();
  await expect(page.getByText('Interview rescheduled.')).toBeVisible();
  expect(calls.reschedule).toMatchObject({ durationMinutes: 45 });

  await card.getByRole('combobox', { name: 'Add interviewer to Panel interview' }).fill('Ken');
  await page.getByRole('option', { name: /Ken Thompson/ }).click();
  await card.getByRole('button', { name: 'Add interviewer', exact: true }).click();
  await expect(page.getByText('Interviewer added.')).toBeVisible();
  expect(calls.addInterviewer).toEqual({ userId: 'user-ken' });

  // The schedule form has no free-text user-id field.
  const schedule = page.getByRole('form', { name: 'Schedule interview' });
  await expect(schedule.getByLabel(/user IDs/)).toHaveCount(0);

  await card.getByRole('button', { name: 'Cancel interview' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel Panel interview?' });
  await expect(dialog.getByRole('button', { name: 'Cancel interview' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('Candidate unavailable');
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Cancel interview' }).click();
  await expect(page.getByText('Interview cancelled.')).toBeVisible();
  expect(calls.cancel).toEqual({ reason: 'Candidate unavailable' });
});
