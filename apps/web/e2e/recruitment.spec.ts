import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'recruitment-user',
  personId: 'person-recruitment-user',
  email: 'recruiter@example.com',
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
      ? json(route, { accessToken: 'recruitment-token', identity }, 201)
      : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'recruitment-token', identity }, 201);
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

const actions = (overrides: Record<string, boolean> = {}) => ({
  canManage: false,
  canMoveStage: false,
  canScreen: false,
  canScheduleInterview: false,
  canWithdraw: false,
  canReject: false,
  canCreateOffer: false,
  canApproveOffer: false,
  canHire: false,
  ...overrides,
});

const offer = (status: string) => ({
  id: 'of-1',
  applicationId: 'app-1',
  positionId: 'pos-1',
  workLocationId: null,
  employmentType: 'CASUAL',
  startDate: '2026-11-01',
  payBasis: 'HOURLY',
  rateAmount: '20.00',
  currency: 'CAD',
  expiresOn: '2026-10-20',
  candidateTerms: 'Seasonal contract for the winter camp.',
  internalNotes: null,
  status,
  effectiveStatus: status,
  approvedAt: '2026-10-01T00:00:00.000Z',
  approvedByUserId: 'u-2',
  sentAt: '2026-10-02T00:00:00.000Z',
  respondedAt: status === 'ACCEPTED' ? '2026-10-06T00:00:00.000Z' : null,
  declineReason: null,
  withdrawnAt: null,
  withdrawalReason: null,
  expiredAt: null,
  createdByUserId: 'u-1',
  createdAt: '2026-10-01T00:00:00.000Z',
});

const hire = {
  id: 'hire-1',
  personId: 'p-1',
  employeeId: 'emp-9',
  employmentAssignmentId: 'asg-9',
  compensationRecordId: 'comp-9',
  internalCandidate: false,
  createdEmployee: true,
  convertedByUserId: identity.id,
  convertedAt: '2026-10-06T12:00:00.000Z',
};

function application(state: 'SENT' | 'ACCEPTED' | 'HIRED') {
  return {
    id: 'app-1',
    view: 'FULL',
    status: state === 'HIRED' ? 'HIRED' : 'OFFERED',
    source: 'REFERRAL',
    sourceDetail: null,
    appliedAt: '2026-09-02T00:00:00.000Z',
    stageEnteredAt: '2026-09-25T00:00:00.000Z',
    stage: {
      id: 's-5',
      name: state === 'HIRED' ? 'Hired' : 'Offer',
      kind: state === 'HIRED' ? 'HIRED' : 'OFFER',
    },
    organization: { id: 'org-1', name: 'Camp' },
    opening: {
      id: 'op-1',
      code: 'REQ-1',
      title: 'Camp Counsellor',
      status: 'OPEN',
      positionId: 'pos-1',
      employmentType: 'CASUAL',
    },
    candidate: {
      id: 'cand-1',
      organizationId: 'org-1',
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      preferredName: null,
      status: 'ACTIVE',
      source: 'REFERRAL',
      internal: false,
      internalEmployee: null,
      mergedIntoCandidateId: null,
      hired: state === 'HIRED',
      email: 'ada@example.org',
      phone: null,
      location: null,
      notes: null,
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    interviews: [],
    documents: [
      {
        id: 'doc-1',
        candidateId: 'cand-1',
        applicationId: 'app-1',
        kind: 'RESUME',
        title: 'Résumé',
        provider: 'GOOGLE_DRIVE',
        externalUrl: 'https://drive.example.com/file/1',
        externalFileId: null,
        fileName: null,
        mimeType: null,
        addedAt: '2026-09-02T00:00:00.000Z',
        removedAt: null,
      },
    ],
    dispositionReason: null,
    dispositionAt: null,
    transitions: [],
    activity: [],
    hire: state === 'HIRED' ? hire : null,
    screening: null,
    offers: [offer(state === 'SENT' ? 'SENT' : 'ACCEPTED')],
    actions: actions({ canManage: state !== 'HIRED', canHire: state === 'ACCEPTED' }),
  };
}

test('a recruiter goes from the dashboard to an offer, records acceptance and converts to an employee', async ({
  page,
}) => {
  await mockSession(page, ['recruitment.manage', 'recruitment.hire', 'employee.manage']);
  let state: 'SENT' | 'ACCEPTED' | 'HIRED' = 'SENT';
  let hireBody: unknown = null;
  await page.route(path('/recruitment/organizations'), (route) =>
    json(route, {
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: {
            canManagePipeline: false,
            canManageIntake: false,
            canReadAllCandidates: true,
            canManageCandidates: true,
            canCreateOpenings: true,
          },
        },
      ],
    }),
  );
  await page.route(path('/recruitment/dashboard'), (route) =>
    json(route, {
      today: '2026-10-06',
      openings: { byStatus: { OPEN: 1 }, total: 1 },
      pipeline: [
        {
          opening: {
            id: 'op-1',
            code: 'REQ-1',
            title: 'Camp Counsellor',
            status: 'OPEN',
            openingCount: 3,
            hiredCount: 1,
          },
          stages: [
            { stageId: 's-1', name: 'Applied', count: 3 },
            { stageId: 's-5', name: 'Offer', count: 1 },
          ],
        },
      ],
      attention: {
        overdueFeedback: [],
        upcomingInterviews: [],
        offersAwaitingApproval: [],
        offersExpiringSoon: [
          {
            offerId: 'of-1',
            applicationId: 'app-1',
            candidate: 'Ada Lovelace',
            opening: { id: 'op-1', title: 'Camp Counsellor', code: 'REQ-1' },
            status: 'SENT',
            expiresOn: '2026-10-08',
            expired: false,
          },
        ],
        acceptedNotHired: [],
        staleApplications: [],
        openingsPastClose: [],
        pendingIntake: null,
      },
    }),
  );
  await page.route(path('/recruitment/applications/app-1'), (route) =>
    json(route, application(state)),
  );
  await page.route(path('/recruitment/offers/of-1/accept'), (route) => {
    state = 'ACCEPTED';
    return json(route, offer('ACCEPTED'), 201);
  });
  await page.route(path('/recruitment/applications/app-1/hire'), (route) => {
    hireBody = route.request().postDataJSON();
    state = 'HIRED';
    return json(
      route,
      {
        ...hire,
        employeeNumber: 'E-100',
        assignment: { id: 'asg-9', status: 'ACTIVE', startDate: '2026-11-01' },
        opening: { id: 'op-1', status: 'OPEN', hiredCount: 2, openingCount: 3 },
      },
      201,
    );
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Recruitment', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Recruitment', exact: true })).toBeVisible();
  const expiring = page.getByRole('region', { name: 'Offers expiring soon' });
  await expect(expiring.getByText('Expires 10/08/2026')).toBeVisible();
  await expiring.getByRole('link', { name: 'Ada Lovelace — Camp Counsellor' }).click();

  await expect(page).toHaveURL(/\/recruitment\/applications\/app-1$/);
  await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Résumé' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await page.getByRole('button', { name: 'Record acceptance' }).click();
  await expect(page.getByText('Offer acceptance recorded.')).toBeVisible();

  const convert = page.getByRole('form', { name: 'Convert to employee' });
  await convert.getByRole('button', { name: 'Convert to employee' }).click();
  await expect(page.getByText('Converted to employee E-100.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open employee record' })).toHaveAttribute(
    'href',
    '/admin/employees/emp-9',
  );
  expect(hireBody).toEqual({
    isPrimary: true,
    initializeCompensation: true,
    payGroupId: null,
    managerAssignmentId: null,
    existingEmployeeId: null,
  });
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('an interviewer submits feedback from My Interviews and it is then locked', async ({
  page,
}) => {
  await mockSession(page, []);
  let submitted: Record<string, unknown> | null = null;
  const interview = (myFeedback: unknown) => ({
    id: 'int-1',
    applicationId: 'app-1',
    type: 'VIDEO',
    title: 'Panel interview',
    scheduledStart: '2026-10-05T15:00:00.000Z',
    durationMinutes: 45,
    location: null,
    meetingUrl: 'https://meet.example.com/abc',
    status: 'COMPLETED',
    feedbackDueAt: '2026-10-07T15:00:00.000Z',
    completedAt: '2026-10-05T16:00:00.000Z',
    cancelledAt: null,
    cancellationReason: null,
    interviewers: [
      { userId: identity.id, email: identity.email, feedbackSubmitted: Boolean(myFeedback) },
    ],
    feedback: myFeedback ? [myFeedback] : [],
    pendingFeedback: myFeedback ? 0 : 1,
    feedbackOverdue: false,
    isInterviewer: true,
    candidate: { id: 'cand-1', displayName: 'Ada Lovelace' },
    opening: { id: 'op-1', code: 'REQ-1', title: 'Camp Counsellor' },
    stageName: 'Interview',
    myFeedback,
  });
  const feedback = () => ({
    id: 'fb-1',
    interviewId: 'int-1',
    interviewerUserId: identity.id,
    status: 'SUBMITTED',
    recommendation: submitted?.recommendation ?? null,
    rating: submitted?.rating ?? null,
    strengths: submitted?.strengths ?? null,
    concerns: null,
    comments: null,
    submittedAt: '2026-10-06T10:00:00.000Z',
    revision: 1,
    reopenReason: null,
    supersededAt: null,
  });
  await page.route(path('/recruitment/me/interviews'), (route) =>
    json(route, { items: [interview(submitted ? feedback() : null)] }),
  );
  await page.route(path('/recruitment/interviews/int-1/feedback/me/submit'), (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, feedback(), 201);
  });

  await signIn(page);
  await expect(page.getByRole('link', { name: 'Recruitment', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'My Interviews' }).click();
  await expect(page.getByRole('heading', { name: 'My interviews' })).toBeVisible();
  const form = page.getByRole('form', { name: 'Interview feedback' });
  await form.getByLabel('Recommendation').selectOption('YES');
  await form.getByLabel('Rating (1–5)').selectOption('4');
  await form.getByLabel('Strengths').fill('Calm and kind with campers');
  await form.getByRole('button', { name: 'Submit feedback' }).click();
  await expect(page.getByText('Feedback submitted.')).toBeVisible();
  const locked = page.getByLabel('My submitted feedback');
  await expect(locked.getByText(/locked/)).toBeVisible();
  await expect(locked.getByText('Recommendation: Yes')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Interview feedback' })).toHaveCount(0);
  expect(submitted).toEqual({
    recommendation: 'YES',
    rating: 4,
    strengths: 'Calm and kind with campers',
    concerns: null,
    comments: null,
  });
});

test('a user without recruitment permissions sees no Recruitment link and is denied the page', async ({
  page,
}) => {
  await mockSession(page, ['employee.read', 'performance.read']);
  await page.route(path('/recruitment/organizations'), (route) => json(route, { items: [] }));
  await signIn(page);
  await expect(page.getByRole('link', { name: 'My Interviews' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Recruitment', exact: true })).toHaveCount(0);
  await page.goto('/admin/recruitment');
  await expect(page.getByText('You do not have permission to view recruitment.')).toBeVisible();
});
