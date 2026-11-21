import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'performance-user',
  personId: 'person-performance-user',
  email: 'performance@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn
      ? json(route, { accessToken: 'performance-token', identity }, 201)
      : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'performance-token', identity }, 201);
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

const levels = [
  { value: 1, label: 'Needs Improvement', description: null },
  { value: 3, label: 'Meets Expectations', description: null },
  { value: 5, label: 'Exceptional', description: null },
];

const actions = (overrides: Record<string, boolean> = {}) => ({
  canEditSelf: false,
  canEditReviewer: false,
  canReassign: false,
  canReopenSelf: false,
  canReopenReviewer: false,
  canLinkEvidence: false,
  canLinkGoals: false,
  canFinalize: false,
  canAcknowledge: false,
  canClose: false,
  canCorrect: false,
  ...overrides,
});

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-1',
    status: 'FINALIZED',
    selfStatus: 'SUBMITTED',
    reviewerStatus: 'SUBMITTED',
    viewer: 'SELF',
    cycle: {
      id: 'cyc-1',
      code: 'ANNUAL-2026',
      name: 'Annual review 2026',
      status: 'OPEN',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      windowStart: '2026-11-01',
      windowEnd: '2026-12-15',
      selfReviewDueDate: '2026-11-10',
      reviewerDueDate: '2026-12-01',
      scoringMode: 'NONE',
      overallRatingEnabled: true,
      overallScaleLevels: levels,
      acknowledgementEnabled: true,
    },
    organization: { id: 'org-1', name: 'Camp' },
    employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
    employmentAssignment: { id: 'asg-1', positionName: 'Grade 3 Teacher' },
    reviewer: { id: 'emp-2', displayName: 'Grace Hopper' },
    form: [
      {
        id: 'sec-1',
        title: 'Teaching',
        description: null,
        items: [
          {
            id: 'item-1',
            sortOrder: 1,
            itemType: 'RATING',
            prompt: 'Classroom management',
            helpText: null,
            respondent: 'REVIEWER',
            required: true,
            weight: null,
            competency: null,
            scaleLevels: levels,
            scaleMin: null,
            scaleMax: null,
          },
        ],
      },
    ],
    responses: {
      'item-1': {
        reviewer: {
          ratingValue: 5,
          ratingLabel: 'Exceptional',
          numericValue: null,
          booleanValue: null,
          textValue: 'Calm, well-organized classroom',
          submitted: true,
          recordType: 'ORIGINAL',
        },
      },
    },
    goals: [],
    evidence: [],
    calculatedScore: null,
    overallRating: { value: 5, label: 'Exceptional' },
    finalizedAt: '2026-12-02T12:00:00.000Z',
    acknowledgedAt: null,
    closedAt: null,
    closeReason: null,
    acknowledgement: null,
    events: [],
    actions: actions({ canAcknowledge: true }),
    ...overrides,
  };
}

async function mockMyPerformance(page: Page, queue: unknown[] = []) {
  await page.route(`${API}/performance/me`, (route) =>
    json(route, {
      employeeId: 'emp-1',
      assignments: [
        {
          id: 'asg-1',
          status: 'ACTIVE',
          isPrimary: true,
          positionName: 'Grade 3 Teacher',
          organization: { id: 'org-1', name: 'Camp' },
        },
      ],
    }),
  );
  await page.route(`${API}/performance/me/reviews`, (route) =>
    json(route, {
      items: [
        {
          id: 'rev-1',
          cycle: {
            id: 'cyc-1',
            code: 'ANNUAL-2026',
            name: 'Annual review 2026',
            status: 'OPEN',
            periodStart: '2026-01-01',
            periodEnd: '2026-12-31',
          },
          positionName: 'Grade 3 Teacher',
          reviewer: { id: 'emp-2', displayName: 'Grace Hopper' },
          status: 'FINALIZED',
          selfStatus: 'SUBMITTED',
          reviewerStatus: 'SUBMITTED',
          overallRating: { value: 5, label: 'Exceptional' },
          calculatedScore: null,
          finalizedAt: '2026-12-02T12:00:00.000Z',
          acknowledgedAt: null,
          closeReason: null,
          awaitingAcknowledgement: true,
        },
      ],
    }),
  );
  await page.route(`${API}/performance/me/goals`, (route) => json(route, { items: [] }));
  await page.route(`${API}/performance/me/evidence`, (route) =>
    json(route, {
      items: [
        {
          id: 'ev-1',
          organizationId: 'org-1',
          employmentAssignment: null,
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          channel: 'SYNC',
          title: 'Staff Code of Conduct Quiz 2026',
          sourceName: 'Code of Conduct quiz',
          completedAt: '2026-09-01T14:30:00.000Z',
          score: '17.00',
          maxScore: '20.00',
          percentage: '85.00',
          passed: true,
          passThresholdPercent: '80.00',
          status: 'ACTIVE',
          withdrawalReason: null,
          revision: 1,
          importedAt: '2026-09-01T15:00:00.000Z',
          sync: { lastSyncedAt: '2026-09-01T15:00:00.000Z', lastSyncStatus: 'OK' },
        },
      ],
    }),
  );
  await page.route(`${API}/performance/reviewing`, (route) => json(route, { items: queue }));
}

test('an employee sees their Code of Conduct quiz result and acknowledges their review', async ({
  page,
}) => {
  await mockSession(page, []);
  await mockMyPerformance(page);
  let acknowledged: unknown = null;
  await page.route(`${API}/performance/reviews/rev-1`, (route) => json(route, review()));
  await page.route(`${API}/performance/reviews/rev-1/acknowledge`, (route) => {
    acknowledged = route.request().postDataJSON();
    return json(
      route,
      review({
        status: 'ACKNOWLEDGED',
        acknowledgedAt: '2026-12-03T10:00:00.000Z',
        acknowledgement: { acknowledgedAt: '2026-12-03T10:00:00.000Z', comment: 'Thank you' },
        actions: actions(),
      }),
      201,
    );
  });
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Performance', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'My Performance' }).click();
  await expect(page.getByRole('heading', { name: 'My performance' })).toBeVisible();
  await page.getByRole('tab', { name: 'Assessments & training' }).click();
  await expect(page.getByText('Staff Code of Conduct Quiz 2026')).toBeVisible();
  await expect(page.getByText('17.00 / 20.00 (85.00%) · Passed')).toBeVisible();
  await page.getByRole('tab', { name: 'My reviews' }).click();
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByText('Overall rating: 5 — Exceptional')).toBeVisible();
  const form = page.getByRole('form', { name: 'Acknowledge review' });
  await form.getByLabel('Comment (optional)').fill('Thank you');
  await form.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Review acknowledged.')).toBeVisible();
  await expect(page.getByText('“Thank you”')).toBeVisible();
  expect(acknowledged).toEqual({ comment: 'Thank you' });
});

test('a reviewer rates and submits a review assigned to them', async ({ page }) => {
  await mockSession(page, []);
  await mockMyPerformance(page, [
    {
      id: 'rev-2',
      cycle: {
        id: 'cyc-1',
        name: 'Annual review 2026',
        reviewerDueDate: '2026-12-01',
        windowEnd: '2026-12-15',
      },
      employee: { id: 'emp-3', employeeNumber: 'E-3', displayName: 'Alan Turing' },
      positionName: 'Grade 4 Teacher',
      status: 'NOT_STARTED',
      selfStatus: 'NOT_STARTED',
      reviewerStatus: 'NOT_STARTED',
      overdue: [],
    },
  ]);
  const writing = review({
    id: 'rev-2',
    status: 'NOT_STARTED',
    selfStatus: 'NOT_STARTED',
    reviewerStatus: 'NOT_STARTED',
    viewer: 'REVIEWER',
    employee: { id: 'emp-3', employeeNumber: 'E-3', displayName: 'Alan Turing' },
    responses: {},
    overallRating: null,
    finalizedAt: null,
    actions: actions({ canEditReviewer: true }),
  });
  const saved: unknown[] = [];
  await page.route(`${API}/performance/reviews/rev-2`, (route) => json(route, writing));
  await page.route(`${API}/performance/reviews/rev-2/reviewer`, (route) => {
    saved.push(route.request().postDataJSON());
    return json(route, writing, 201);
  });
  await page.route(`${API}/performance/reviews/rev-2/reviewer/submit`, (route) =>
    json(
      route,
      { ...writing, status: 'SUBMITTED', reviewerStatus: 'SUBMITTED', actions: actions() },
      201,
    ),
  );
  await signIn(page);
  await page.getByRole('link', { name: 'My Performance' }).click();
  await page.getByRole('tab', { name: 'Reviews to write (1)' }).click();
  await page.getByRole('link', { name: 'Write review' }).click();
  const form = page.getByRole('form', { name: 'Review form' });
  await form.getByLabel('Classroom management rating').selectOption('3');
  await form.getByLabel('Overall rating').selectOption('3');
  await form.getByRole('button', { name: 'Submit review' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Submit review' }).click();
  await expect(page.getByText('Submitted.')).toBeVisible();
  expect(saved).toEqual([
    {
      answers: [
        {
          itemId: 'item-1',
          ratingValue: 3,
          numericValue: null,
          booleanValue: null,
          textValue: null,
        },
      ],
      overallRatingValue: 3,
    },
  ]);
});
