import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 7B — the review journey and goals against a mocked API: the employee submits a self
 * review, the reviewer submits with an overall rating, HR finalizes and the employee
 * acknowledges (each submit/finalize confirmed); HR corrects a reviewer answer and the overall
 * rating with a reason; an employee cannot complete a goal their manager set; My Performance
 * keeps its other sections when one request fails, and the failed one retries. axe
 * (serious/critical) and no page-wide horizontal scroll at desktop, tablet and a 375 px phone.
 */

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

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

async function signedIn(page: Page, permissions: string[] = []) {
  let signed = false;
  await page.route('**/auth/refresh', (route) =>
    signed ? json(route, { accessToken: '7b-token', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signed = true;
    return json(route, { accessToken: '7b-token', identity }, 201);
  });
  await page.route('**/auth/me', (route) =>
    signed ? json(route, identity) : json(route, {}, 401),
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
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
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

const answer = (ratingValue: number, label: string) => ({
  ratingValue,
  ratingLabel: label,
  numericValue: null,
  booleanValue: null,
  textValue: null,
  submitted: true,
  recordType: 'ORIGINAL',
});

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-1',
    status: 'IN_PROGRESS',
    selfStatus: 'NOT_STARTED',
    reviewerStatus: 'NOT_STARTED',
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
            id: 'item-comm',
            sortOrder: 1,
            itemType: 'RATING',
            prompt: 'Communication',
            helpText: null,
            respondent: 'BOTH',
            required: true,
            weight: null,
            competency: null,
            scaleLevels: levels,
            scaleMin: null,
            scaleMax: null,
          },
          {
            id: 'item-class',
            sortOrder: 2,
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
    responses: {},
    goals: [],
    evidence: [],
    calculatedScore: null,
    overallRating: null,
    finalizedAt: null,
    acknowledgedAt: null,
    closedAt: null,
    closeReason: null,
    acknowledgement: null,
    events: [],
    actions: actions({ canEditSelf: true }),
    ...overrides,
  };
}

const quiz = {
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
};

const managerGoal = {
  id: 'goal-1',
  organizationId: 'org-1',
  employmentAssignmentId: 'asg-1',
  positionName: 'Grade 3 Teacher',
  title: 'Mentor a new teacher',
  description: null,
  measure: 'Weekly check-ins',
  startDate: '2026-01-15',
  dueDate: '2026-06-30',
  status: 'IN_PROGRESS',
  progressPercent: 30,
  completionNotes: null,
  cancellationReason: null,
  setBy: 'MANAGER',
  createdBy: { userId: 'u-2', displayName: 'Grace Hopper' },
};

async function mockMyPerformance(
  page: Page,
  { failEvidenceOnce = false }: { failEvidenceOnce?: boolean } = {},
) {
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
          status: 'IN_PROGRESS',
          selfStatus: 'NOT_STARTED',
          reviewerStatus: 'NOT_STARTED',
          overallRating: null,
          calculatedScore: null,
          finalizedAt: null,
          acknowledgedAt: null,
          closeReason: null,
          awaitingAcknowledgement: false,
        },
      ],
    }),
  );
  await page.route(`${API}/performance/me/goals`, (route) => json(route, { items: [managerGoal] }));
  let evidenceFailures = failEvidenceOnce ? 1 : 0;
  await page.route(`${API}/performance/me/evidence`, (route) => {
    if (evidenceFailures > 0) {
      evidenceFailures -= 1;
      return json(route, { message: 'Internal server error' }, 500);
    }
    return json(route, { items: [quiz] });
  });
  await page.route(`${API}/performance/reviewing`, (route) => json(route, { items: [] }));
}

test('self review → reviewer with overall rating → HR finalizes → employee acknowledges', async ({
  page,
}) => {
  let current: Record<string, unknown> = review();
  const posted: Record<string, unknown> = {};
  await signedIn(page, ['performance.read', 'performance.manage']);
  await page.route(`${API}/performance/reviews/rev-1`, (route) => json(route, current));
  await page.route(`${API}/performance/reviews/rev-1/self`, (route) => {
    posted.self = route.request().postDataJSON();
    return json(route, current, 201);
  });
  await page.route(`${API}/performance/reviews/rev-1/self/submit`, (route) => {
    current = review({
      selfStatus: 'SUBMITTED',
      responses: { 'item-comm': { self: answer(5, 'Exceptional') } },
      actions: actions(),
    });
    return json(route, current, 201);
  });
  await page.route(`${API}/performance/reviews/rev-1/reviewer`, (route) => {
    posted.reviewer = route.request().postDataJSON();
    return json(route, current, 201);
  });
  await page.route(`${API}/performance/reviews/rev-1/reviewer/submit`, (route) => {
    current = { ...current, status: 'SUBMITTED', reviewerStatus: 'SUBMITTED', actions: actions() };
    return json(route, current, 201);
  });
  await page.route(`${API}/performance/reviews/rev-1/finalize`, (route) => {
    current = {
      ...current,
      status: 'FINALIZED',
      finalizedAt: '2026-12-02T12:00:00.000Z',
      actions: actions(),
    };
    return json(route, current, 201);
  });
  await page.route(`${API}/performance/reviews/rev-1/acknowledge`, (route) => {
    posted.acknowledge = route.request().postDataJSON();
    current = {
      ...current,
      status: 'ACKNOWLEDGED',
      acknowledgedAt: '2026-12-03T10:00:00.000Z',
      acknowledgement: { acknowledgedAt: '2026-12-03T10:00:00.000Z', comment: 'Thank you' },
      actions: actions(),
    };
    return json(route, current, 201);
  });

  // The employee's self review: only their item, submitted after confirming.
  await page.goto('/performance/reviews/rev-1');
  const selfForm = page.getByRole('form', { name: 'Review form' });
  await expect(selfForm.getByLabel(/ rating$/)).toHaveCount(1);
  await selfForm.getByLabel('Communication rating').selectOption('5');
  await selfForm.getByRole('button', { name: 'Submit self review' }).click();
  const confirmSelf = page.getByRole('alertdialog', { name: 'Submit your self review?' });
  await checkAt(page);
  await confirmSelf.getByRole('button', { name: 'Submit self review' }).click();
  await expect(page.getByText('Submitted.')).toBeVisible();
  expect(posted.self).toMatchObject({
    answers: [expect.objectContaining({ itemId: 'item-comm', ratingValue: 5 })],
  });

  // The reviewer rates both items and the overall rating.
  current = { ...current, viewer: 'REVIEWER', actions: actions({ canEditReviewer: true }) };
  await page.reload();
  const reviewerForm = page.getByRole('form', { name: 'Review form' });
  await reviewerForm.getByLabel('Communication rating').selectOption('3');
  await reviewerForm.getByLabel('Classroom management rating').selectOption('5');
  await reviewerForm.getByLabel('Overall rating').selectOption('3');
  await reviewerForm.getByRole('button', { name: 'Submit review' }).click();
  await page
    .getByRole('alertdialog', { name: 'Submit this review?' })
    .getByRole('button', { name: 'Submit review' })
    .click();
  await expect(page.getByText('Submitted.')).toBeVisible();
  expect(posted.reviewer).toMatchObject({ overallRatingValue: 3 });

  // HR finalizes after confirming.
  current = {
    ...current,
    viewer: 'HR',
    responses: {
      'item-comm': { self: answer(5, 'Exceptional'), reviewer: answer(3, 'Meets Expectations') },
      'item-class': { reviewer: answer(5, 'Exceptional') },
    },
    overallRating: { value: 3, label: 'Meets Expectations' },
    actions: actions({ canFinalize: true, canReopenReviewer: true, canClose: true }),
  };
  await page.reload();
  const hr = page.getByRole('region', { name: 'HR actions' });
  await expect(hr).toBeVisible();
  await checkAt(page);
  await hr.getByRole('button', { name: 'Finalize' }).click();
  await page
    .getByRole('alertdialog', { name: 'Finalize this review?' })
    .getByRole('button', { name: 'Finalize review' })
    .click();
  await expect(page.getByText('Review finalized and shared with the employee.')).toBeVisible();

  // The employee sees the outcome and acknowledges.
  current = { ...current, viewer: 'SELF', actions: actions({ canAcknowledge: true }) };
  await page.reload();
  await expect(page.getByText('Overall rating: 3 — Meets Expectations')).toBeVisible();
  const ack = page.getByRole('form', { name: 'Acknowledge review' });
  await ack.getByLabel('Comment (optional)').fill('Thank you');
  await ack.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Review acknowledged.')).toBeVisible();
  expect(posted.acknowledge).toEqual({ comment: 'Thank you' });
});

test('HR corrects a reviewer answer and the overall rating with a reason', async ({ page }) => {
  const finalized = review({
    viewer: 'HR',
    status: 'FINALIZED',
    selfStatus: 'SUBMITTED',
    reviewerStatus: 'SUBMITTED',
    finalizedAt: '2026-12-02T12:00:00.000Z',
    responses: {
      'item-comm': { reviewer: answer(3, 'Meets Expectations') },
      'item-class': { reviewer: answer(3, 'Meets Expectations') },
    },
    overallRating: { value: 3, label: 'Meets Expectations' },
    actions: actions({ canCorrect: true, canClose: true }),
  });
  let corrected: unknown = null;
  await signedIn(page, ['performance.read', 'performance.manage']);
  await page.route(`${API}/performance/reviews/rev-1`, (route) => json(route, finalized));
  await page.route(`${API}/performance/reviews/rev-1/correct`, (route) => {
    corrected = route.request().postDataJSON();
    return json(route, finalized, 201);
  });
  await page.goto('/performance/reviews/rev-1');
  await page
    .getByRole('region', { name: 'HR actions' })
    .getByRole('button', { name: 'Correct review' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Correct review' });
  await dialog.getByLabel('Correct “Classroom management”').check();
  await dialog.getByLabel('Classroom management rating').selectOption('5');
  await dialog.getByLabel('Corrected overall rating').selectOption('5');
  await dialog.getByLabel('Reason for the correction').fill('Calibration meeting');
  await checkAt(page);
  await dialog.getByRole('button', { name: 'Correct review' }).click();
  await page
    .getByRole('alertdialog', { name: 'Save this correction?' })
    .getByRole('button', { name: 'Save correction' })
    .click();
  await expect(page.getByText('Review corrected.')).toBeVisible();
  expect(corrected).toEqual({
    answers: [
      {
        itemId: 'item-class',
        ratingValue: 5,
        numericValue: null,
        booleanValue: null,
        textValue: null,
      },
    ],
    overallRatingValue: 5,
    reason: 'Calibration meeting',
  });
});

test('an employee cannot complete a goal their manager set', async ({ page }) => {
  await signedIn(page);
  await mockMyPerformance(page);
  let patched = false;
  await page.route(`${API}/performance/goals/goal-1`, (route) => {
    patched = true;
    return json(route, { code: 'PERFORMANCE_GOAL_MANAGER_SET' }, 403);
  });
  await page.goto('/performance');
  await page.getByRole('tab', { name: 'My goals' }).click();
  const goals = page.getByRole('region', { name: 'Your goals' });
  await expect(goals.getByText('Set by your manager (Grace Hopper)')).toBeVisible();
  await expect(goals.getByText('Your manager or HR completes or cancels this goal.')).toBeVisible();
  await expect(goals.getByRole('button', { name: /^Complete / })).toHaveCount(0);
  await expect(goals.getByRole('button', { name: /^Cancel / })).toHaveCount(0);
  await expect(goals.getByRole('button', { name: 'Edit Mentor a new teacher' })).toBeVisible();
  await checkAt(page);
  expect(patched).toBe(false);
});

test('My Performance keeps the other sections when one fails, and retries it', async ({ page }) => {
  await signedIn(page);
  await mockMyPerformance(page, { failEvidenceOnce: true });
  await page.goto('/performance');
  await expect(page.getByRole('heading', { name: 'My performance' })).toBeVisible();
  await expect(page.getByText('Annual review 2026')).toBeVisible();
  await page.getByRole('tab', { name: 'Assessments & training' }).click();
  const failure = page
    .getByRole('alert')
    .filter({ hasText: 'Your assessments could not be loaded' });
  await expect(failure).toBeVisible();
  await expect(page.getByText('No assessment or training results')).toHaveCount(0);
  await checkAt(page);
  await failure.getByRole('button', { name: 'Retry your assessments' }).click();
  await expect(page.getByText('Staff Code of Conduct Quiz 2026')).toBeVisible();
  await page.getByRole('tab', { name: 'My goals' }).click();
  await expect(page.getByText('Mentor a new teacher')).toBeVisible();
});
