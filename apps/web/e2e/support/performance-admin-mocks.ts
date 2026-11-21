import { expect, type Page, type Route } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';

// Batch 10E-2: moved unchanged from e2e/batch-7b-performance-admin.spec.ts so batch-10e2.spec.ts can reuse it.
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

const identity = {
  id: 'performance-admin',
  personId: 'person-performance-admin',
  email: 'performance-admin@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function signedIn(page: Page, permissions: string[]) {
  let signed = false;
  await page.route('**/auth/refresh', (route) =>
    signed ? json(route, { accessToken: '7b-admin', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signed = true;
    return json(route, { accessToken: '7b-admin', identity }, 201);
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

export async function checkAt(page: Page) {
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

export const ALL = [
  'performance.manage',
  'performance.template.manage',
  'performance.cycle.manage',
  'performance.evidence.manage',
];

type Json = Record<string, unknown>;

/** A small in-memory Performance API (only what the admin page uses). */
export function mockApi() {
  const cycleActions = (status: string) => ({
    canEdit: status !== 'ARCHIVED',
    canAddReviews: status === 'DRAFT' || status === 'OPEN',
    canOpen: status === 'DRAFT',
    canClose: status === 'OPEN',
    canArchive: status === 'CLOSED',
    canDiscard: status === 'DRAFT',
  });
  const state = {
    cycles: [] as Json[],
    reviews: [] as Json[],
    calls: [] as Array<{ method: string; path: string; body: unknown }>,
    evidence: {
      id: 'ev-1',
      organizationId: 'org-1',
      employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
      employmentAssignment: null,
      provider: 'CERTIFICATION',
      kind: 'CERTIFICATION',
      channel: 'MANUAL',
      title: 'First Aid',
      sourceName: null,
      completedAt: '2026-05-20T12:00:00.000Z',
      score: null,
      maxScore: null,
      percentage: null,
      passed: true,
      passThresholdPercent: null,
      status: 'ACTIVE',
      withdrawalReason: null,
      revision: 1,
      importedAt: '2026-05-20T12:00:00.000Z',
      sync: null,
      notes: 'Confidential HR note',
      actions: { canManage: true },
    } as Json,
    history: [] as Json[],
    intakeRejected: false,
  };
  const template = {
    id: 'tpl-1',
    code: 'ANNUAL',
    name: 'Annual review',
    description: null,
    status: 'ACTIVE',
    scoringMode: 'NONE',
    overallRatingEnabled: true,
    ratingScale: { id: 'sc-1', code: 'FIVE', name: 'Five point' },
    sectionCount: 1,
    itemCount: 2,
    cycleCount: 0,
  };
  const competency = {
    id: 'k1',
    code: 'COMM',
    name: 'Communication',
    description: null,
    category: null,
    archived: false,
  };
  const scale = {
    id: 'sc-1',
    code: 'FIVE',
    name: 'Five point',
    description: null,
    status: 'ACTIVE',
    levels: [
      { value: 1, label: 'Needs Improvement', description: null },
      { value: 5, label: 'Exceptional', description: null },
    ],
  };
  const intake = {
    id: 'in-1',
    source: { id: 'src-1', code: 'COC', name: 'Code of Conduct quiz', provider: 'GOOGLE_FORMS' },
    externalResultId: 'resp-1',
    respondentEmail: null,
    respondentReference: 'Unverified email: visitor@example.org',
    result: { title: 'Code of Conduct quiz', score: '18', maxScore: '20' },
    status: 'PENDING_MATCH',
    reason: 'EMAIL_UNVERIFIED',
    receivedAt: '2026-09-01T15:00:00.000Z',
  };

  async function handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*?\/performance/, '/performance');
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    if (method !== 'GET') state.calls.push({ method, path, body });
    const cycle = state.cycles[0];

    if (path === '/performance/organizations')
      return json(route, {
        items: [
          {
            id: 'org-1',
            name: 'Harbourline',
            code: 'HBL',
            timezone: 'America/Toronto',
            actions: { canManageTemplates: true, canManageCycles: true, canManageEvidence: true },
          },
        ],
      });
    if (path === '/performance/templates') return json(route, { items: [template] });
    if (path === '/performance/competencies') return json(route, { items: [competency] });
    if (path === '/performance/competencies/k1' && method === 'PATCH') {
      Object.assign(competency, body);
      return json(route, competency);
    }
    if (path === '/performance/rating-scales') return json(route, { items: [scale] });
    if (path === '/performance/rating-scales/sc-1/archive')
      return json(
        route,
        {
          statusCode: 409,
          code: 'PERFORMANCE_CONFIG_IN_USE',
          message: 'Active templates use it: ANNUAL.',
          templates: [{ id: 'tpl-1', code: 'ANNUAL', name: 'Annual review' }],
        },
        409,
      );
    if (path === '/performance/options') {
      const kind = url.searchParams.get('kind');
      if (kind === 'assignment')
        return json(route, {
          items: [
            {
              id: 'asg-1',
              label: 'Ada Lovelace',
              description: 'E-1 · Teacher',
              employeeId: 'emp-1',
            },
          ],
          nextAfterId: null,
        });
      return json(route, {
        items: [{ id: 'emp-1', label: 'Ada Lovelace', description: 'E-1' }],
        nextAfterId: null,
      });
    }
    if (path === '/performance/cycles' && method === 'GET')
      return json(route, { items: state.cycles });
    if (path === '/performance/cycles' && method === 'POST') {
      const created = {
        id: 'cyc-1',
        description: null,
        acknowledgementEnabled: true,
        scoringMode: null,
        overallRatingEnabled: null,
        ...(body as Json),
        status: 'DRAFT',
        template: { id: 'tpl-1', code: 'ANNUAL', name: 'Annual review' },
        reviewCounts: {},
        actions: cycleActions('DRAFT'),
      };
      state.cycles.push(created);
      return json(route, created, 201);
    }
    if (cycle && path === '/performance/cycles/cyc-1/reviews' && method === 'POST') {
      state.reviews.push({
        id: 'rev-1',
        employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
        employmentAssignment: { id: 'asg-1', positionName: 'Teacher' },
        reviewer: { id: 'emp-2', displayName: 'Grace Hopper' },
        status: 'NOT_STARTED',
        selfStatus: 'NOT_STARTED',
        reviewerStatus: 'NOT_STARTED',
        overdue: [],
      });
      cycle.reviewCounts = { NOT_STARTED: 1 };
      return json(route, { added: 1, skipped: 0, withoutReviewer: 0, excludedOwn: 0 }, 201);
    }
    if (cycle && path === '/performance/cycles/cyc-1/reviews')
      return json(route, { items: state.reviews, nextAfterId: null, total: state.reviews.length });
    for (const [action, status] of [
      ['open', 'OPEN'],
      ['close', 'CLOSED'],
    ] as const) {
      if (cycle && path === `/performance/cycles/cyc-1/${action}`) {
        cycle.status = status;
        cycle.actions = cycleActions(status);
        return json(route, cycle, 201);
      }
    }
    if (path === '/performance/attention') return json(route, { items: [], nextAfterId: null });
    if (path === '/performance/evidence-sources')
      return json(route, {
        items: [
          {
            id: 'src-1',
            code: 'COC',
            name: 'Code of Conduct quiz',
            provider: 'GOOGLE_FORMS',
            kind: 'ASSESSMENT',
            externalResourceId: 'form-1',
            resourceTitle: null,
            resourceUrl: null,
            passThresholdPercent: '80.00',
            lastSyncedAt: null,
            lastSyncStatus: null,
            lastSyncMessage: null,
            archived: false,
            evidenceCount: 0,
            pendingMatches: 1,
          },
        ],
      });
    if (path === '/performance/evidence' && method === 'POST')
      return json(route, state.evidence, 201);
    if (path === '/performance/employees/emp-1/evidence')
      return json(route, { items: [state.evidence] });
    if (path === '/performance/evidence/ev-1/correct') {
      const before = {
        ...state.evidence,
        correctionReason: null,
        supersededAt: '2026-11-07T10:00:00.000Z',
        recordedBy: { userId: 'u1', displayName: 'Hana HR' },
      };
      const changes: Json = { ...(body as Json), revision: 2 };
      delete changes.reason;
      Object.assign(state.evidence, changes);
      state.history = [
        {
          ...state.evidence,
          correctionReason: (body as Json).reason,
          supersededAt: null,
          recordedBy: { userId: identity.id, displayName: 'Pat Admin' },
        },
        before,
      ];
      return json(route, state.evidence, 201);
    }
    if (path === '/performance/evidence/ev-1/history') return json(route, { items: state.history });
    if (path === '/performance/evidence-intake')
      return json(route, {
        items:
          url.searchParams.get('status') === 'PENDING_MATCH' && !state.intakeRejected
            ? [intake]
            : [],
        nextAfterId: null,
      });
    if (path === '/performance/evidence-intake/in-1/resolve') {
      state.intakeRejected = true;
      return json(route, { status: 'REJECTED' }, 201);
    }
    return json(route, { message: `Unmocked ${method} ${path}` }, 404);
  }
  return { state, handle };
}
