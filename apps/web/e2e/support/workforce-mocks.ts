import { expect, type Page, type Route } from '@playwright/test';
import { API } from './api-origin';
import { expectNoSeriousA11yViolations } from './axe';

/**
 * Mocked-API building blocks for the workforce screens (time, attendance, scheduling), moved
 * unchanged from batch-4f.spec.ts so later specs (Batch 10C) can reuse them.
 */
export const ORG = '11111111-1111-4111-8111-111111111111';
export const ORG2 = '22222222-2222-4222-8222-222222222222';

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;
export type Viewport = keyof typeof VIEWPORTS;
export const ALL: Viewport[] = ['desktop', 'tablet', 'phone'];

export const identity = {
  id: 'user-4f',
  personId: 'person-4f',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

export const ALL_MODULES = [
  'ATTENDANCE',
  'SCHEDULING',
  'LEAVE',
  'COMPENSATION',
  'PAYROLL',
  'BENEFITS',
  'PERFORMANCE',
  'RECRUITMENT',
  'ONBOARDING',
  'DOCUMENTS',
  'NOTIFICATIONS',
  'GOOGLE_WORKSPACE',
  'REPORTING',
];

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Matches an API path regardless of its query string. */
export const path = (pathname: string) => (url: URL) =>
  url.origin === API && url.pathname === pathname;

/** A restored session (no login form) with organization permissions in a workspace. */
export async function session(
  page: Page,
  permissions: string[],
  options: { isEmployee?: boolean } = {},
) {
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '4f-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Ada Lovelace' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ALL_MODULES,
          permissions,
          isEmployee: options.isEmployee ?? false,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

export async function noHorizontalScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

/** axe (serious and critical) and no page-wide horizontal scroll at each width. */
export async function checkAt(page: Page, viewports: Viewport[] = ALL) {
  for (const name of viewports) {
    await page.setViewportSize(VIEWPORTS[name]);
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

export const assignmentView = (
  id: string,
  position: string,
  org: { id: string; name: string },
) => ({
  id,
  employmentType: 'PART_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: null,
  isPrimary: id === 'assignment-1',
  position: { id: `position-${id}`, name: position, code: position.slice(0, 3).toUpperCase() },
  jobTitle: { id: `job-${id}`, name: position, code: position.slice(0, 3).toUpperCase() },
  organization: { ...org, code: org.name.slice(0, 3).toUpperCase() },
  placement: null,
  workLocation: null,
});
export const coordinator = assignmentView('assignment-1', 'Coordinator', {
  id: ORG,
  name: 'Northwind Academy',
});
export const instructor = assignmentView('assignment-2', 'Instructor', {
  id: ORG2,
  name: 'Harbor School',
});

export const entry = (
  id: string,
  day: string,
  view: ReturnType<typeof assignmentView>,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  employeeId: 'employee-1',
  employeeNumber: 'E-100',
  employeeName: 'Ada Lovelace',
  employmentAssignmentId: view.id,
  assignment: view,
  workDate: day,
  clockInAt: `${day}T13:00:00.000Z`,
  clockOutAt: `${day}T21:00:00.000Z`,
  timezone: 'America/Toronto',
  status: 'CLOSED',
  source: 'LIVE_CLOCK',
  grossMinutes: 480,
  paidBreakMinutes: 0,
  unpaidBreakMinutes: 0,
  breakMinutes: 0,
  netWorkedMinutes: 480,
  policyDeductionMinutes: 30,
  payableMinutes: 450,
  scheduledShiftId: null,
  breaks: [],
  exceptions: [],
  corrections: [],
  ...overrides,
});

export function todayInToronto() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function mockMyTime(page: Page) {
  const today = todayInToronto();
  const capability = (view: typeof coordinator, enabled: boolean) => ({
    employmentAssignmentId: view.id,
    position: { id: view.position.id, name: view.position.name },
    organization: { id: view.organization.id, name: view.organization.name },
    timezone: 'America/Toronto',
    attendanceEnabled: enabled,
    clockEnabled: enabled,
    canCapture: enabled,
    trackingMode: 'TIME_CLOCK',
    captureMode: 'SELF_SERVICE',
    selfServiceCapture: enabled,
    kioskLocationRule: 'ANY_IN_ORGANIZATION',
    signOutEnabled: false,
    breakMode: 'AUTO_DEDUCT',
    assignmentSwitching: false,
    correctionRequestsEnabled: true,
    missedPunchSelfResolutionEnabled: true,
    allowEarlySubmission: false,
    unavailableReason: enabled ? null : 'ATTENDANCE_DISABLED',
    explanation: enabled
      ? null
      : 'Time & attendance is switched off for this organization. Earlier records stay visible.',
  });
  const expected = {
    from: today,
    to: today,
    items: [
      {
        scheduledShiftId: 'shift-1',
        scheduledShiftRevisionId: 'rev-1',
        revisionNumber: 1,
        shiftStatus: 'ACTIVE',
        employmentAssignmentId: 'assignment-1',
        position: { id: 'position-assignment-1', name: 'Coordinator' },
        organization: { id: ORG, name: 'Northwind Academy' },
        workDate: today,
        startsAt: `${today}T13:00:00.000Z`,
        endsAt: `${today}T21:00:00.000Z`,
        timezone: 'America/Toronto',
        trackingMode: 'TIME_CLOCK',
        status: 'UPCOMING',
        minutesAfterStart: null,
        signIn: null,
        timeEntries: [],
        exceptions: [],
      },
    ],
    truncated: true,
    limit: 1000,
  };
  await page.route(`${API}/time/**`, (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case '/time/me/status':
        return json(route, {
          state: 'OFF_CLOCK',
          serverTime: new Date().toISOString(),
          currentTimeEntry: null,
          currentAssignment: null,
          currentBreakEntry: null,
          breakStartedAt: null,
          clockedInAt: null,
          eligibleAssignments: [coordinator],
          activeExceptions: [],
          availableActions: ['CLOCK_IN'],
          attendanceModes: [],
          assignmentCapabilities: [capability(coordinator, true), capability(instructor, false)],
        });
      case '/time/me/entries':
        return json(route, {
          items: [
            entry('entry-1', '2026-10-24', coordinator),
            entry('entry-2', '2026-10-23', instructor),
          ],
          nextAfterId: null,
          attendanceDisabledOrganizationIds: [ORG2],
        });
      case '/time/me/expected-attendance':
        return json(route, { ...expected, attendanceDisabledOrganizationIds: [ORG2] });
      case '/time/me/exceptions':
        return json(route, {
          exceptions: [],
          nextAfterId: null,
          attendanceDisabledOrganizationIds: [ORG2],
        });
      case '/time/me/corrections':
        return json(route, {
          corrections: [],
          nextAfterId: null,
          attendanceDisabledOrganizationIds: [ORG2],
        });
      case '/time/me/timesheets':
        return json(route, { timesheets: [], attendanceDisabledOrganizationIds: [ORG2] });
      case '/time/me/sign-ins':
        return json(route, { items: [] });
      case '/time/me/attendance-pin':
        return json(route, { hasPin: true });
      default:
        return json(route, {}, 404);
    }
  });
  await page.route(path('/scheduling/me'), (route) =>
    json(route, {
      employeeId: 'employee-1',
      range: { from: '', to: '' },
      items: [
        {
          id: 'shift-1',
          schedule: { id: 'schedule-1', name: 'Week' },
          assignment: {
            id: 'assignment-1',
            isPrimary: true,
            position: { id: 'position-1', name: 'Coordinator', code: 'COO' },
            organization: { id: ORG, name: 'Northwind Academy' },
          },
          workLocation: null,
          workDate: today,
          startsAt: `${today}T13:00:00.000Z`,
          endsAt: `${today}T21:00:00.000Z`,
          timezone: 'America/Toronto',
          durationMinutes: 480,
          status: 'ACTIVE',
        },
        {
          id: 'shift-h',
          schedule: { id: 'schedule-2', name: 'Week' },
          assignment: {
            id: 'assignment-2',
            isPrimary: false,
            position: { id: 'position-2', name: 'Instructor', code: 'INS' },
            organization: { id: ORG2, name: 'Harbor School' },
          },
          workLocation: null,
          workDate: today,
          startsAt: `${today}T22:00:00.000Z`,
          endsAt: `${today}T23:00:00.000Z`,
          timezone: 'America/Toronto',
          durationMinutes: 60,
          status: 'ACTIVE',
        },
      ],
    }),
  );
}

export const MANAGER_PERMISSIONS = [
  'time.view',
  'time.correct',
  'time.approve',
  'time.timesheet.approve',
  'time.manage_policy',
  'time.device.manage',
  'schedule.read',
];

export const fullActions = {
  canViewSignIns: true,
  canCorrectSignIns: true,
  canManageDevices: false,
  canManagePolicies: false,
  canManagePins: false,
  canViewAttendance: true,
  canCorrectTime: true,
  canReviewExceptions: true,
  canReviewCorrections: true,
  canApproveTimesheets: true,
  canManageTimesheets: false,
  canManagePeriods: false,
};

export const northwind = {
  id: ORG,
  name: 'Northwind Academy',
  code: 'NWA',
  timezone: 'America/Toronto',
  workLocations: [],
  physicalSites: [],
  attendanceEnabled: true,
  actions: fullActions,
};
export const harbor = {
  ...northwind,
  id: ORG2,
  name: 'Harbor School',
  code: 'HAR',
  attendanceEnabled: false,
  actions: {
    ...Object.fromEntries(Object.keys(fullActions).map((key) => [key, false])),
    canViewAttendance: true,
    canViewSignIns: true,
  },
};

export const period = {
  id: 'period-1',
  organizationId: ORG,
  startDate: '2026-10-19',
  endDate: '2026-10-25',
  status: 'CLOSED',
  cadence: 'WEEKLY',
  openedAt: null,
  closedAt: null,
  lockedAt: null,
};

export const harborPeriod = {
  ...period,
  id: 'period-h',
  organizationId: ORG2,
  startDate: '2026-09-14',
  endDate: '2026-09-20',
  attendanceEnabled: false,
};

export function sheet() {
  return {
    id: 'sheet-1',
    employeeId: 'employee-1',
    timePeriodId: 'period-1',
    status: 'SUBMITTED',
    submittedByUserId: 'user-ada',
    submittedAt: '2026-10-26T12:00:00.000Z',
    approvedByUserId: null,
    approvedAt: null,
    lockedByUserId: null,
    lockedAt: null,
    reopenedByUserId: null,
    reopenedAt: null,
    reviewerNote: null,
    version: 2,
    totals: { netWorkedMinutes: 900 },
    period,
    employee: { id: 'employee-1', employeeNumber: 'E-100', name: 'Ada Lovelace' },
    segments: [
      {
        id: 'segment-1',
        employmentAssignmentId: 'assignment-1',
        status: 'PENDING',
        reviewedByUserId: null,
        reviewedAt: null,
        reviewerNote: null,
        grossMinutes: 960,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        policyDeductionMinutes: 60,
        netWorkedMinutes: 900,
        approvedWorkedMinutes: 0,
        calculatedAt: null,
        assignment: coordinator,
      },
    ],
    events: [],
    actors: { 'user-ada': 'Ada Lovelace' },
  };
}

export const varianceRow = (
  workDate: string,
  name: string,
  overrides: Record<string, unknown> = {},
) => ({
  workDate,
  employeeId: `employee-${name}`,
  employmentAssignmentId: `assignment-${name}`,
  employeeNumber: `E-${name.length}00`,
  employeeName: name,
  positionName: 'Coordinator',
  scheduledShiftCount: 1,
  scheduledMinutes: 480,
  scheduledShiftIds: ['shift-1'],
  closedEntryCount: 1,
  openEntryCount: 0,
  grossMinutes: 480,
  actualMinutes: 450,
  linkedActualMinutes: 450,
  unscheduledActualMinutes: 0,
  varianceMinutes: -30,
  ...overrides,
});

export interface ManagerWorld {
  requests: Array<{ method: string; path: string; body: unknown }>;
  linkFailsOnce: boolean;
}

export async function mockManager(page: Page): Promise<ManagerWorld> {
  const world: ManagerWorld = { requests: [], linkFailsOnce: true };
  await page.route(`${API}/time/**`, (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = route.request().postDataJSON() as unknown;
    world.requests.push({ method, path: `${url.pathname}${url.search}`, body });
    const params = url.searchParams;
    const historical = params.get('includeDisabledOrganizations') === 'true';
    const forHarbor = params.get('organizationId') === ORG2;
    const page_ = (items: unknown[], extra: Record<string, unknown> = {}) =>
      json(route, { items, nextAfterId: null, attendanceDisabledOrganizationIds: [], ...extra });
    if (forHarbor && !historical && method === 'GET') {
      return json(route, { statusCode: 403, code: 'FEATURE_DISABLED', module: 'ATTENDANCE' }, 403);
    }
    switch (`${method} ${url.pathname}`) {
      case 'GET /time/manage/organizations':
        return json(route, { items: historical ? [northwind, harbor] : [northwind] });
      case 'GET /time/manage/entries':
        if (forHarbor) {
          return page_([entry('entry-h', '2026-09-14', instructor)], {
            attendanceDisabledOrganizationIds: [ORG2],
          });
        }
        return page_([
          entry('entry-1', '2026-10-20', coordinator, { scheduledShiftId: 'shift-1' }),
          entry('entry-2', '2026-10-21', coordinator),
        ]);
      case 'GET /time/manage/corrections':
        return page_(
          forHarbor
            ? []
            : [
                {
                  id: 'correction-1',
                  employeeId: 'employee-1',
                  employeeName: 'Ada Lovelace',
                  requestorUserId: 'user-ada',
                  reviewerUserId: null,
                  timeEntryId: 'entry-2',
                  breakEntryId: null,
                  employmentAssignmentId: 'assignment-1',
                  targetEmploymentAssignmentId: null,
                  type: 'CHANGE_CLOCK_OUT',
                  status: 'PENDING',
                  reason: 'Stayed for the parent meeting',
                  reviewerNote: null,
                  requestedValues: { clockOutAt: '2026-10-21T22:00:00.000Z' },
                  currentValues: { clockOutAt: '2026-10-21T21:00:00.000Z' },
                  requestedAt: '2026-10-22T12:00:00.000Z',
                  reviewedAt: null,
                  cancelledAt: null,
                  adjustmentId: null,
                  workDate: '2026-10-21',
                  timezone: 'America/Toronto',
                  assignment: coordinator,
                  actors: { 'user-ada': 'Ada Lovelace' },
                },
              ],
          forHarbor ? { attendanceDisabledOrganizationIds: [ORG2] } : {},
        );
      case 'GET /time/manage/timesheets': {
        if (forHarbor) {
          return page_(
            [
              {
                ...sheet(),
                id: 'sheet-h',
                timePeriodId: harborPeriod.id,
                period: harborPeriod,
                status: 'APPROVED',
              },
            ],
            { attendanceDisabledOrganizationIds: [ORG2] },
          );
        }
        const status = params.get('status');
        return page_(!status || status === 'SUBMITTED' ? [sheet()] : []);
      }
      case 'GET /time/periods':
        return forHarbor
          ? page_([{ ...harborPeriod, payrollManaged: false, timesheetCount: 1 }], {
              attendanceDisabledOrganizationIds: [ORG2],
            })
          : page_([
              { ...period, payrollManaged: false, timesheetCount: 1, attendanceEnabled: true },
            ]);
      case 'GET /time/manage/scheduled-vs-actual':
        return json(
          route,
          params.get('afterKey')
            ? {
                range: { from: params.get('from'), to: params.get('to') },
                rows: [
                  varianceRow('2026-10-21', 'Grace Hopper', {
                    actualMinutes: 510,
                    varianceMinutes: 30,
                    unscheduledActualMinutes: 30,
                  }),
                ],
                nextAfterKey: null,
              }
            : {
                range: { from: params.get('from'), to: params.get('to') },
                rows: [
                  varianceRow('2026-10-20', 'Ada Lovelace', { openEntryCount: 1 }),
                  varianceRow('2026-10-20', 'Alan Turing', {
                    scheduledShiftCount: 2,
                    scheduledMinutes: 600,
                    actualMinutes: 0,
                    closedEntryCount: 0,
                    varianceMinutes: -600,
                  }),
                ],
                nextAfterKey: '2026-10-20|assignment-Alan Turing',
              },
        );
      case 'POST /time/entries/entry-1/scheduled-shift':
        if (world.linkFailsOnce) {
          world.linkFailsOnce = false;
          return json(
            route,
            { statusCode: 409, code: 'TIME_ENTRY_FINALIZED', message: 'Finalized' },
            409,
          );
        }
        return json(
          route,
          {
            timeEntryId: 'entry-1',
            scheduledShiftId: (body as { scheduledShiftId: string | null }).scheduledShiftId,
            scheduledShiftRevisionId: 'rev-2',
            revisionNumber: 1,
            changed: true,
          },
          201,
        );
      case 'GET /time/manage/sign-ins':
        return json(route, {
          items: [
            {
              id: 'sign-in-1',
              employeeId: 'employee-1',
              employmentAssignmentId: 'assignment-2',
              signedInAt: '2026-11-02T13:05:00.000Z',
              timezone: 'America/Toronto',
              workDate: '2026-11-02',
              source: 'KIOSK',
              attendanceDeviceId: 'device-1',
              workLocationId: null,
              scheduledShiftId: null,
              scheduledShiftRevisionId: null,
              status: 'ACTIVE',
              voidedAt: null,
              voidReason: null,
              replacesSignInId: null,
              recordedByUserId: null,
              reason: null,
              createdAt: '2026-11-02T13:05:00.000Z',
              positionName: 'Instructor',
              employeeNumber: 'E-100',
              employeeName: 'Ada Lovelace',
              device: { id: 'device-1', name: 'Front desk' },
              workLocation: null,
              exceptions: [],
              actions: forHarbor
                ? { canVoid: false, canCorrect: false }
                : { canVoid: true, canCorrect: true },
              signOut: null,
            },
          ],
          truncated: true,
          limit: 1000,
          attendanceDisabledOrganizationIds: forHarbor ? [ORG2] : [],
        });
      case 'GET /time/manage/expected-sign-ins':
        return json(route, {
          items: [
            {
              scheduledShiftId: 'shift-9',
              scheduledShiftRevisionId: 'rev-9',
              employmentAssignmentId: 'assignment-2',
              employeeId: 'employee-1',
              employeeNumber: 'E-100',
              employeeName: 'Ada Lovelace',
              positionName: 'Instructor',
              workDate: '2026-11-02',
              startsAt: '2026-11-02T13:00:00.000Z',
              endsAt: '2026-11-02T14:00:00.000Z',
              timezone: 'America/Toronto',
              status: 'MISSING',
              signIn: null,
            },
          ],
          truncated: true,
          limit: 2000,
        });
      default:
        return method === 'GET' ? page_([]) : json(route, {}, 404);
    }
  });
  await page.route(path('/scheduling'), (route) =>
    json(route, {
      range: { from: '2026-10-19', to: '2026-10-21' },
      items: ['shift-1', 'shift-2'].map((id, index) => ({
        id,
        scheduleId: 'schedule-1',
        employmentAssignmentId: 'assignment-1',
        assignment: { position: { name: 'Coordinator' }, organization: { id: ORG, name: 'N' } },
        workDate: '2026-10-20',
        startsAt: `2026-10-20T${13 + index * 4}:00:00.000Z`,
        endsAt: `2026-10-20T${16 + index * 4}:00:00.000Z`,
        timezone: 'America/Toronto',
        status: 'ACTIVE',
      })),
      nextAfterId: null,
    }),
  );
  return world;
}

export const SCHEDULING_PERMISSIONS = [
  'schedule.read',
  'schedule.manage',
  'schedule.manage_templates',
  'schedule.manage_patterns',
  'schedule.manage_policy',
  'organization.read',
  'employee.read',
];

export async function mockScheduling(page: Page, options: { failTemplatesOnce?: boolean } = {}) {
  let failTemplates = options.failTemplatesOnce ?? false;
  const empty = { items: [], nextAfterId: null };
  await page.route(
    (url) =>
      url.origin === API &&
      /^\/organizations\/[^/]+\/(units|departments|teams|work-locations|positions)$/.test(
        url.pathname,
      ),
    (route) => json(route, []),
  );
  await page.route(path('/scheduling'), (route) => {
    const params = new URL(route.request().url()).searchParams;
    return json(route, {
      range: { from: params.get('from'), to: params.get('to') },
      items: [],
      nextAfterId: null,
    });
  });
  await page.route(path('/schedules'), (route) => json(route, empty));
  await page.route(path('/schedule-templates'), (route) => {
    if (failTemplates) {
      failTemplates = false;
      return json(route, { statusCode: 503, message: 'Unavailable' }, 503);
    }
    return json(route, empty);
  });
  await page.route(path('/schedule-policies'), (route) => json(route, empty));
  await page.route(path('/scheduling/reports/scheduled-hours'), (route) => {
    const params = new URL(route.request().url()).searchParams;
    return json(route, {
      range: { from: params.get('from'), to: params.get('to') },
      groupBy: params.get('groupBy') ?? 'employee',
      filters: { status: null, scheduleStatus: null },
      groups: [],
      nextAfterKey: null,
    });
  });
  await page.route(path('/employees'), (route) =>
    json(route, { items: [], nextAfterId: null, total: 0 }),
  );
}
