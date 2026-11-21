import type { Page, Route } from '@playwright/test';
import { API } from './api-origin';

/**
 * Batch 10E-1 — a mocked recruitment and onboarding API for the UI modernization checks
 * (batch-10e1.spec.ts). Names are deliberately long so tables, forms and badges are tested at a
 * phone width with realistic content. Everything is read-only unless a test adds its own route.
 */
export const ORG = '11111111-1111-4111-8111-111111111111';
export const EMP = '22222222-2222-4222-8222-222222222222';

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
export const path = (pathname: string) => (url: URL) =>
  url.origin === API && url.pathname === pathname;

export const RECRUITER = [
  'recruitment.read',
  'recruitment.manage',
  'recruitment.offer.approve',
  'recruitment.hire',
  'recruitment.pipeline.manage',
  'recruitment.intake.manage',
];
export const ONBOARDING_HR = [
  'onboarding.read',
  'onboarding.manage',
  'offboarding.read',
  'offboarding.manage',
  'onboarding.template.manage',
];

/** A signed-in user with these permissions in the organization (optionally answered late). */
export async function session(
  page: Page,
  permissions: string[],
  options: { authorizationDelayMs?: number; isEmployee?: boolean } = {},
) {
  const identity = {
    id: 'user-hr',
    personId: 'person-hr',
    email: 'hr@example.com',
    status: 'ACTIVE',
    emailVerifiedAt: null,
    mustChangePassword: false,
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '10e1-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, async (route) => {
    if (options.authorizationDelayMs)
      await new Promise((resolve) => setTimeout(resolve, options.authorizationDelayMs));
    await json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    });
  });
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
          enabledModules: ['RECRUITMENT', 'ONBOARDING'],
          permissions,
          isEmployee: options.isEmployee ?? false,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

// ─── Recruitment ────────────────────────────────────────────────────────────

const LONG_TITLE = 'Senior Early Childhood Educator and Before-and-After School Coordinator';
const LONG_NAME = 'Alexandria Montgomery-Fitzgerald';

export const STAGES = [
  ['s-1', 'APPLIED', 'Applied'],
  ['s-2', 'SCREENING', 'Phone screening'],
  ['s-3', 'INTERVIEW', 'Panel interview'],
  ['s-4', 'ASSESSMENT', 'Classroom assessment'],
  ['s-5', 'REFERENCE_CHECK', 'Reference checks'],
  ['s-6', 'OFFER', 'Offer'],
  ['s-7', 'HIRED', 'Hired'],
].map(([id, kind, name], index) => ({
  id: id!,
  code: kind!,
  name: name!,
  kind: kind!,
  sortOrder: (index + 1) * 10,
  archivedAt: null,
}));

export const opening = (overrides: Record<string, unknown> = {}) => ({
  id: 'op-1',
  organization: { id: ORG, name: 'Northwind Academy' },
  code: 'REQ-2026-0042',
  title: LONG_TITLE,
  description: 'Leads a classroom team.',
  status: 'OPEN',
  statusReason: null,
  employmentType: 'FULL_TIME',
  openingCount: 2,
  hiredCount: 0,
  position: { id: 'pos-1', name: 'Early childhood educator', code: 'ECE' },
  organizationalUnit: null,
  department: null,
  team: null,
  workLocation: { id: 'wl-1', name: 'Toronto campus' },
  hiringManager: { id: 'emp-2', displayName: 'Grace Hopper' },
  recruiterUserId: null,
  expectedStartDate: '2026-12-01',
  postedOn: '2026-09-01',
  closesOn: '2026-12-31',
  compensation: { payBasis: 'SALARY', min: '52000.00', max: '61000.00', currency: 'CAD' },
  openedAt: '2026-09-01T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-08-30T00:00:00.000Z',
  actions: { canManage: true, canApproveOffers: true, canHire: true, isHiringManager: false },
  applications: { ACTIVE: 1 },
  ...overrides,
});

const recruitmentOrganization = {
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

const candidate = {
  id: 'cand-1',
  organizationId: ORG,
  displayName: LONG_NAME,
  firstName: 'Alexandria',
  lastName: 'Montgomery-Fitzgerald',
  preferredName: null,
  status: 'ACTIVE',
  source: 'REFERRAL',
  internal: false,
  internalEmployee: null,
  mergedIntoCandidateId: null,
  hired: false,
  email: 'alexandria.montgomery-fitzgerald@example.org',
  phone: '+1 416 555 0100',
  location: 'Toronto',
  notes: null,
  createdAt: '2026-09-02T00:00:00.000Z',
  applicationCount: 1,
};

export const interview = {
  id: 'int-1',
  applicationId: 'app-1',
  type: 'PANEL',
  title: 'Panel interview with the leadership team',
  scheduledStart: '2026-10-20T15:00:00.000Z',
  durationMinutes: 45,
  location: 'Room 12',
  meetingUrl: null,
  status: 'SCHEDULED',
  feedbackDueAt: '2026-10-22T15:00:00.000Z',
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  interviewers: [
    { userId: 'u-9', email: 'grace.hopper@example.org', feedbackSubmitted: false },
    { userId: 'u-10', email: 'ken.thompson@example.org', feedbackSubmitted: true },
  ],
  feedback: [],
  pendingFeedback: 1,
  feedbackOverdue: false,
  isInterviewer: false,
};

export function application(view: 'FULL' | 'INTERVIEWER' = 'FULL') {
  const full = view === 'FULL';
  return {
    id: 'app-1',
    view,
    status: 'ACTIVE',
    source: 'REFERRAL',
    sourceDetail: null,
    appliedAt: '2026-09-02T00:00:00.000Z',
    stageEnteredAt: '2026-09-10T00:00:00.000Z',
    stage: { id: 's-3', name: 'Panel interview', kind: 'INTERVIEW' },
    organization: { id: ORG, name: 'Northwind Academy' },
    opening: {
      id: 'op-1',
      code: 'REQ-2026-0042',
      title: LONG_TITLE,
      status: 'OPEN',
      positionId: 'pos-1',
      employmentType: 'FULL_TIME',
    },
    candidate: full
      ? candidate
      : {
          ...candidate,
          email: undefined,
          phone: undefined,
          location: undefined,
          notes: undefined,
        },
    interviews: [{ ...interview, isInterviewer: !full }],
    documents: [],
    dispositionReason: null,
    dispositionAt: null,
    transitions: full
      ? [
          {
            id: 'tr-1',
            fromStageName: 'Applied',
            toStageName: 'Panel interview',
            note: 'Strong references',
            createdAt: '2026-09-10T00:00:00.000Z',
          },
        ]
      : undefined,
    activity: full
      ? [{ id: 'act-1', occurredAt: '2026-09-02T00:00:00.000Z', summary: 'Application received' }]
      : undefined,
    hire: null,
    screening: full
      ? {
          outcome: 'ADVANCE',
          meetsMinimumQualifications: true,
          workAuthorizationConfirmed: true,
          requiredCertificationsHeld: null,
          availableFrom: '2026-11-15',
          notes: 'Experienced lead educator.',
          screenedByUserId: 'user-hr',
          screenedAt: '2026-09-05T00:00:00.000Z',
        }
      : null,
    offers: full ? [] : undefined,
    actions: {
      canManage: full,
      canMoveStage: full,
      canScreen: full,
      canScheduleInterview: full,
      canWithdraw: full,
      canReject: full,
      canCreateOffer: full,
      canApproveOffer: full,
      canHire: false,
    },
  };
}

const submission = (id: string, status: string) => ({
  id,
  sourceId: 'src-1',
  externalResponseId: `resp-${id}`,
  status,
  reason: status === 'PENDING_OPENING' ? 'OPENING_NOT_FOUND' : null,
  submission: {
    openingCode: 'REQ-UNKNOWN-2026',
    candidate: {
      firstName: 'Bartholomew',
      lastName: `Featherstonehaugh ${id}`,
      email: `bartholomew.featherstonehaugh.${id}@example.org`,
    },
  },
  submittedAt: '2026-10-01T00:00:00.000Z',
  correctionCount: 0,
  candidateId: null,
  applicationId: status === 'APPLIED' ? `app-${id}` : null,
  receivedAt: '2026-10-01T00:00:00.000Z',
  lastReceivedAt: '2026-10-01T00:00:00.000Z',
  resolvedAt: status === 'PENDING_OPENING' ? null : '2026-10-02T00:00:00.000Z',
});

/** Every recruitment endpoint the screens read, with long realistic values. */
export async function recruitmentServer(page: Page) {
  const calls = { moveStage: 0 };
  await page.route(path('/recruitment/organizations'), (route) =>
    json(route, { items: [recruitmentOrganization] }),
  );
  await page.route(path('/recruitment/dashboard'), (route) =>
    json(route, {
      today: '2026-10-06',
      openings: { byStatus: { OPEN: 3, ON_HOLD: 1, DRAFT: 2 }, total: 6 },
      pipeline: [
        {
          opening: opening(),
          stages: STAGES.map((stage, index) => ({
            stageId: stage.id,
            name: stage.name,
            kind: stage.kind,
            count: index + 1,
          })),
        },
      ],
      attention: {
        overdueFeedback: [
          {
            interviewId: 'int-1',
            applicationId: 'app-1',
            candidate: LONG_NAME,
            title: 'Panel interview with the leadership team',
            feedbackDueAt: '2026-10-02T00:00:00.000Z',
            missing: 1,
          },
        ],
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
  await page.route(path('/recruitment/openings'), (route) =>
    json(route, {
      items: [
        opening(),
        opening({
          id: 'op-2',
          code: 'REQ-2026-0043',
          title: 'Kitchen assistant (part-time, weekends)',
          status: 'ON_HOLD',
          statusReason: 'Budget review',
          employmentType: 'PART_TIME',
          compensation: { payBasis: 'HOURLY', min: '18.50', max: '21.00', currency: 'CAD' },
        }),
        opening({ id: 'op-3', code: 'REQ-2026-0044', title: 'Bus driver', status: 'DRAFT' }),
      ],
      truncated: false,
    }),
  );
  await page.route(path('/recruitment/openings/op-1'), (route) =>
    json(route, { ...opening(), events: [] }),
  );
  await page.route(path('/recruitment/stages'), (route) => json(route, { items: STAGES }));
  await page.route(path('/recruitment/applications'), (route) =>
    json(route, {
      items: [
        {
          id: 'app-1',
          status: 'ACTIVE',
          source: 'REFERRAL',
          appliedAt: '2026-09-02T00:00:00.000Z',
          stageEnteredAt: '2026-09-10T00:00:00.000Z',
          candidate: { id: 'cand-1', displayName: LONG_NAME, internal: true },
          opening: { id: 'op-1', code: 'REQ-2026-0042', title: LONG_TITLE, status: 'OPEN' },
          stage: { id: 's-3', name: 'Panel interview', kind: 'INTERVIEW', sortOrder: 30 },
          view: 'FULL',
        },
      ],
    }),
  );
  await page.route(path('/recruitment/candidates'), (route) => json(route, { items: [candidate] }));
  await page.route(path('/recruitment/candidates/cand-1'), (route) =>
    json(route, {
      ...candidate,
      applications: [
        {
          id: 'app-1',
          status: 'ACTIVE',
          opening: { id: 'op-1', code: 'REQ-2026-0042', title: LONG_TITLE, status: 'OPEN' },
          stage: { id: 's-3', name: 'Panel interview', kind: 'INTERVIEW' },
          appliedAt: '2026-09-02T00:00:00.000Z',
        },
      ],
      documents: [],
      activity: [],
      actions: { canEdit: true, canMerge: true, canMarkInternal: true },
    }),
  );
  await page.route(path('/recruitment/intake-sources'), (route) =>
    json(route, {
      items: [
        {
          id: 'src-1',
          organizationId: ORG,
          code: 'CAREERS-FORM-2026',
          name: 'Careers site application form (Google Forms)',
          provider: 'GOOGLE_FORMS',
          externalResourceId: '1FAIpQLSf-very-long-external-form-identifier-0042',
          resourceUrl: null,
          defaultOpeningId: 'op-1',
          lastSyncedAt: '2026-10-01T00:00:00.000Z',
          lastSyncStatus: 'SUCCEEDED',
          lastSyncMessage: null,
          archivedAt: null,
          pendingOpening: 1,
        },
      ],
    }),
  );
  await page.route(path('/recruitment/intake'), (route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    return json(route, {
      items: [submission('s1', status ?? 'PENDING_OPENING')],
      nextAfterId: null,
    });
  });
  await page.route(path('/recruitment/options'), (route) =>
    json(route, { items: [], nextAfterId: null }),
  );
  await page.route(path('/recruitment/applications/app-1/stage'), async (route) => {
    calls.moveStage += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return json(route, application());
  });
  return calls;
}

// ─── Onboarding ─────────────────────────────────────────────────────────────

const noActions = {
  canStart: false,
  canComplete: false,
  canAcknowledge: false,
  canWaive: false,
  canReopen: false,
  canReassign: false,
};
const progress = {
  total: 3,
  done: 1,
  percent: 33,
  requiredTotal: 3,
  requiredDone: 1,
  overdue: 1,
  allDone: false,
  requiredComplete: false,
};

export function task(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workflowId: 'wf-1',
    sortOrder: 10,
    title,
    description: null,
    category: 'PAPERWORK',
    ownerType: 'HR',
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
    actions: { ...noActions, canComplete: true, canWaive: true, canReassign: true },
    ...overrides,
  };
}

export const workflow = (overrides: Record<string, unknown> = {}) => ({
  id: 'wf-1',
  view: 'HR',
  kind: 'ONBOARDING',
  status: 'ACTIVE',
  templateName: 'Educator onboarding (full-time, Toronto campus)',
  templateCode: 'EDU-ONBOARD',
  anchorDate: '2026-11-02',
  plannedEndDate: null,
  startedAt: '2026-10-01T12:00:00.000Z',
  completedAt: null,
  cancelledAt: null,
  reason: null,
  recruitmentHireId: 'hire-1',
  cancellationReason: null,
  organization: { id: ORG, name: 'Northwind Academy' },
  employee: { id: EMP, employeeNumber: 'E-2026-0099', displayName: LONG_NAME },
  position: { id: 'pos-1', name: 'Early childhood educator' },
  progress,
  tasks: [
    task('tk-1', 'Sign the employment agreement and the confidentiality acknowledgement', {
      status: 'COMPLETED',
      completedAt: '2026-10-02T00:00:00.000Z',
      actions: noActions,
    }),
    task('tk-2', 'Provision the staff account and the building access card', {
      overdue: true,
      status: 'IN_PROGRESS',
    }),
    task('tk-3', 'Waived paperwork', { status: 'WAIVED', waiverReason: 'Not applicable' }),
  ],
  events: [],
  coreHr: null,
  actions: { canManage: true, canCancel: true, canComplete: false },
  ...overrides,
});

const template = {
  id: 'tpl-1',
  organizationId: ORG,
  kind: 'ONBOARDING',
  code: 'EDU-ONBOARD',
  name: 'Educator onboarding (full-time, Toronto campus)',
  description: null,
  status: 'ACTIVE',
  isDefault: true,
  workflowCount: 4,
  activatedAt: '2026-09-01T00:00:00.000Z',
  archivedAt: null,
  tasks: [
    {
      id: 'tt-1',
      sortOrder: 10,
      title: 'Sign the employment agreement',
      description: null,
      category: 'PAPERWORK',
      ownerType: 'EMPLOYEE',
      ownerUserId: null,
      dueOffsetDays: 0,
      required: true,
      evidenceRequired: false,
      acknowledgementRequired: false,
      acknowledgementStatement: null,
      referenceType: 'EXTERNAL_URL',
      referenceUrl: 'https://forms.example.org/agreement',
      referenceExternalId: null,
      referenceLabel: 'Employment agreement',
      systemAction: 'NONE',
    },
  ],
};

/** Every onboarding endpoint the admin screens read. */
export async function onboardingServer(page: Page) {
  await page.route(path('/onboarding/organizations'), (route) =>
    json(route, {
      items: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          actions: {
            canManageTemplates: true,
            onboarding: true,
            offboarding: true,
            canImportOnboarding: true,
            canImportOffboarding: true,
          },
        },
      ],
    }),
  );
  await page.route(path('/onboarding/workflows'), (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind') ?? 'ONBOARDING';
    return json(route, {
      today: '2026-10-06',
      kind,
      truncated: false,
      items: [
        {
          id: 'wf-1',
          status: 'ACTIVE',
          templateName: 'Educator onboarding (full-time, Toronto campus)',
          anchorDate: '2026-11-02',
          plannedEndDate: kind === 'OFFBOARDING' ? '2026-11-30' : null,
          employee: { id: EMP, employeeNumber: 'E-2026-0099', displayName: LONG_NAME },
          position: { id: 'pos-1', name: 'Early childhood educator' },
          assignmentStatus: 'PLANNED',
          assignmentEndDate: null,
          progress,
        },
      ],
      attention: {
        overdueTasks: [
          {
            taskId: 'tk-2',
            workflowId: 'wf-1',
            employee: LONG_NAME,
            title: 'Provision the staff account and the building access card',
            dueDate: '2026-10-01',
            ownerType: 'HR',
            owner: 'hr@example.com',
          },
        ],
        unassignedTasks: [],
        upcoming: [],
        coreHrPending: [],
      },
    });
  });
  await page.route(path('/onboarding/workflows/wf-1'), (route) => json(route, workflow()));
  await page.route(path('/onboarding/templates'), (route) => json(route, { items: [template] }));
  await page.route(path('/onboarding/options'), (route) =>
    json(route, { items: [], nextAfterId: null }),
  );
}
