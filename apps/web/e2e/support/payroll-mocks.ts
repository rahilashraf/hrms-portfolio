import { expect, type Page, type Route } from '@playwright/test';
import { API } from './api-origin';
import { expectNoSeriousA11yViolations } from './axe';

/**
 * Mocked-API building blocks for the payroll screens, moved unchanged from batch-6a.spec.ts so
 * later specs (Batch 10D) can reuse the stateful payroll server.
 */
export const ORG = '11111111-1111-4111-8111-111111111111';
export const GROUP = '22222222-2222-4222-8222-222222222222';
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
export const PAYROLL = [
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
  'report.read',
  'report.export',
];

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
export const path = (pathname: string) => (url: URL) =>
  url.origin === API && url.pathname === pathname;
export const prefix = (pathname: string) => (url: URL) =>
  url.origin === API && url.pathname.startsWith(pathname);

export async function session(page: Page) {
  const identity = {
    id: 'payroll-admin',
    personId: 'person-payroll-admin',
    email: 'payroll-admin@example.com',
    status: 'ACTIVE',
    emailVerifiedAt: null,
    mustChangePassword: false,
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '6a-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: PAYROLL.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Parker Pay' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['PAYROLL', 'COMPENSATION'],
          permissions: PAYROLL,
          isEmployee: false,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
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

export const money = (value: number) => value.toFixed(2);
export const PAY_GROUP = { id: GROUP, code: 'BW', name: 'Biweekly' };

/** An in-memory payroll API with the backend's rules for the steps exercised. */
export function payrollServer() {
  const state = {
    calendars: [] as Array<Record<string, unknown>>,
    periods: [] as Array<Record<string, unknown>>,
    run: null as null | { status: string; calculated: boolean },
    adjustments: [] as Array<Record<string, unknown> & { id: string; status: string }>,
    printed: 0,
    csvQuery: null as Record<string, string> | null,
  };
  const SALARY = 2000;
  const applied = () =>
    state.adjustments.filter(
      (a) => a.status !== 'CANCELLED' && (a.payrollRunId === 'run-1' || a.status === 'APPLIED'),
    );
  const totals = () => {
    if (!state.run?.calculated) return { gross: 0, deductions: 0 };
    const adj = applied();
    const sum = (kind: string) =>
      adj.filter((a) => a.kind === kind).reduce((total, a) => total + Number(a.amount), 0);
    return { gross: SALARY + sum('EARNING'), deductions: sum('DEDUCTION') };
  };
  const period = {
    id: 'period-1',
    organizationId: ORG,
    payGroupId: GROUP,
    payrollCalendarId: 'cal-1',
    periodStart: '2026-10-04',
    periodEnd: '2026-10-17',
    payDate: '2026-10-22',
    processingCutoffAt: '2026-10-20T04:00:00.000Z',
    timezone: 'America/Toronto',
    status: 'OPEN',
    timePeriodId: 'tp-1',
    timesheetsMaterializedAt: null,
    payGroup: { code: 'BW', name: 'Biweekly' },
  };
  const summary = () => {
    const t = totals();
    const status = state.run!.status;
    return {
      id: 'run-1',
      organizationId: ORG,
      status,
      currency: 'CAD',
      payGroup: PAY_GROUP,
      period: { ...period, status: status === 'FINALIZED' ? 'FINALIZED' : 'PROCESSING' },
      calculatedAt: state.run!.calculated ? '2026-10-18T12:00:00.000Z' : null,
      calculationVersion: state.run!.calculated ? 'PAYROLL_GROSS_V1' : null,
      sourceFingerprint: null,
      approvedAt: ['APPROVED', 'FINALIZED'].includes(status) ? '2026-10-19T12:00:00.000Z' : null,
      finalizedAt: status === 'FINALIZED' ? '2026-10-20T12:00:00.000Z' : null,
      voidedAt: null,
      voidReason: null,
      statutoryStatus: 'NOT_CALCULATED',
      totals: {
        grossAmount: state.run!.calculated ? money(t.gross) : null,
        deductionAmount: state.run!.calculated ? money(t.deductions) : null,
        employerContributionAmount: state.run!.calculated ? '0.00' : null,
        netAmount: null,
        netStatus: 'STATUTORY_NOT_CALCULATED',
      },
      employeeCount: state.run!.calculated ? 1 : 0,
    };
  };
  const employeeRow = () => {
    const t = totals();
    return {
      id: 're-1',
      employeeId: 'emp-1',
      employeeNumber: 'E-100',
      displayName: 'Ada Lovelace',
      grossAmount: money(t.gross),
      deductionAmount: money(t.deductions),
      employerContributionAmount: '0.00',
      assignments: [
        {
          id: 'ra-1',
          employmentAssignmentId: 'asg-1',
          positionName: 'Counsellor',
          employmentType: 'FULL_TIME',
          grossAmount: money(t.gross),
          deductionAmount: money(t.deductions),
          employerContributionAmount: '0.00',
        },
      ],
    };
  };
  const detail = () => {
    const s = summary();
    const status = s.status;
    return {
      ...s,
      organization: { id: ORG, name: 'Northwind Academy' },
      issueCounts: { ERROR: 0, WARNING: 0, INFO: state.run!.calculated ? 1 : 0 },
      employees: state.run!.calculated ? [employeeRow()] : [],
      actions: {
        canCalculate: ['DRAFT', 'CALCULATED', 'APPROVED'].includes(status),
        canApprove: status === 'CALCULATED',
        canFinalize: status === 'APPROVED',
        canVoid: ['DRAFT', 'CALCULATED', 'APPROVED'].includes(status),
        canAddManualLines: ['DRAFT', 'CALCULATED'].includes(status),
        canAdjust: true,
      },
    };
  };
  const line = (id: string, extra: Record<string, unknown>) => ({
    id,
    workDate: null,
    periodFrom: null,
    periodTo: null,
    quantity: null,
    quantityUnit: null,
    rateAmount: null,
    currency: 'CAD',
    calculationRule: 'R',
    reason: null,
    reversesLineId: null,
    ...extra,
  });
  const employeeDetail = () => {
    const row = employeeRow();
    const adj = applied();
    return {
      ...row,
      assignments: row.assignments.map((assignment) => ({
        ...assignment,
        timezone: 'America/Toronto',
        sourceFingerprint: 'x',
        earnings: [
          line('e-salary', {
            origin: 'CALCULATED',
            type: 'REGULAR_SALARY',
            description: 'Salary',
            periodFrom: '2026-10-04',
            periodTo: '2026-10-17',
            amount: money(SALARY),
          }),
          ...adj
            .filter((a) => a.kind === 'EARNING')
            .map((a) =>
              line(`e-${a.id}`, {
                origin: 'ADJUSTMENT',
                type: 'RETRO_ADJUSTMENT',
                description: a.description,
                amount: a.amount,
              }),
            ),
        ],
        deductions: [
          {
            id: 'd-benefit',
            category: 'BENEFIT',
            code: null,
            description: 'Dental plan',
            amount: '0.00',
            currency: 'CAD',
            reason: null,
            reversesLineId: null,
          },
        ],
        employerContributions: [],
        issues: [],
      })),
    };
  };
  const adjustmentList = (url: URL) => {
    const status = url.searchParams.get('status');
    const runId = url.searchParams.get('payrollRunId');
    return state.adjustments.filter(
      (a) => (!status || a.status === status) && (!runId || a.payrollRunId === runId),
    );
  };

  return {
    state,
    async install(page: Page) {
      await page.route(path('/payroll/organizations'), (route) =>
        json(route, {
          items: [
            {
              id: ORG,
              name: 'Northwind Academy',
              code: 'NWA',
              timezone: 'America/Toronto',
              actions: {
                canRead: true,
                canManage: true,
                canCalculate: true,
                canApprove: true,
                canFinalize: true,
                canAdjust: true,
              },
            },
          ],
        }),
      );
      await page.route(path('/payroll/pay-groups'), (route) =>
        json(route, {
          items: [
            {
              ...PAY_GROUP,
              organizationId: ORG,
              archived: false,
              periodCount: state.periods.length,
              currentCalendar: null,
            },
          ],
        }),
      );
      await page.route(path(`/payroll/pay-groups/${GROUP}/members`), (route) =>
        json(route, {
          items: [
            {
              employmentAssignmentId: 'asg-1',
              employeeId: 'emp-1',
              employeeNumber: 'E-100',
              displayName: 'Ada Lovelace',
              positionName: 'Counsellor',
              assignmentStatus: 'ACTIVE',
              currencies: ['CAD'],
            },
          ],
        }),
      );
      await page.route(path('/payroll/calendars'), (route) => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON() as Record<string, unknown>;
          const calendar = {
            id: 'cal-1',
            organizationId: ORG,
            ...body,
            effectiveTo: null,
            salaryUnpaidLeaveRule: 'UNCONFIGURED',
            salaryStandardAnnualHours: null,
            periodCount: 0,
            payGroup: PAY_GROUP,
            actions: { canUpdate: true, canEnd: true },
          };
          state.calendars = [calendar];
          return json(route, calendar, 201);
        }
        return json(route, { items: state.calendars });
      });
      await page.route(path('/payroll/calendars/cal-1'), (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        state.calendars = [{ ...state.calendars[0], ...body }];
        return json(route, state.calendars[0]);
      });
      await page.route(path('/payroll/calendars/cal-1/end'), (route) => {
        const { effectiveTo } = route.request().postDataJSON() as { effectiveTo: string };
        if (effectiveTo < '2026-10-17')
          return json(
            route,
            { statusCode: 409, code: 'PAYROLL_CALENDAR_END_BEFORE_PERIODS', message: 'Too early.' },
            409,
          );
        state.calendars = [{ ...state.calendars[0], effectiveTo }];
        return json(route, state.calendars[0], 201);
      });
      await page.route(path('/payroll/periods'), (route) => json(route, { items: state.periods }));
      await page.route(path('/payroll/periods/generate'), (route) => {
        state.periods = [period];
        state.calendars = state.calendars.map((calendar) => ({
          ...calendar,
          periodCount: 1,
          actions: { canUpdate: false, canEnd: true },
        }));
        return json(route, { created: [period] }, 201);
      });
      await page.route(path('/payroll/runs'), (route) => {
        if (route.request().method() === 'POST') {
          state.run = { status: 'DRAFT', calculated: false };
          return json(route, detail(), 201);
        }
        return json(route, { items: state.run ? [summary()] : [] });
      });
      await page.route(path('/payroll/runs/run-1'), (route) => json(route, detail()));
      await page.route(path('/payroll/runs/run-1/issues'), (route) => json(route, { items: [] }));
      await page.route(path('/payroll/runs/run-1/employees/re-1'), (route) =>
        json(route, employeeDetail()),
      );
      await page.route(path('/payroll/runs/run-1/retro-preview'), (route) =>
        json(route, { payrollRunId: 'run-1', items: [] }),
      );
      await page.route(path('/payroll/runs/run-1/calculate'), (route) => {
        state.run = { status: 'CALCULATED', calculated: true };
        state.adjustments = state.adjustments.map((a) =>
          a.status === 'PENDING' ? { ...a, payrollRunId: 'run-1' } : a,
        );
        return json(route, detail(), 201);
      });
      await page.route(path('/payroll/runs/run-1/approve'), (route) => {
        state.run = { ...state.run!, status: 'APPROVED' };
        return json(route, detail(), 201);
      });
      await page.route(path('/payroll/runs/run-1/finalize'), (route) => {
        state.run = { ...state.run!, status: 'FINALIZED' };
        state.adjustments = state.adjustments.map((a) =>
          a.payrollRunId === 'run-1' && a.status === 'PENDING' ? { ...a, status: 'APPLIED' } : a,
        );
        return json(route, detail(), 201);
      });
      await page.route(path('/payroll/adjustments'), (route, request) => {
        if (request.method() === 'POST') {
          const body = request.postDataJSON() as Record<string, unknown>;
          const adjustment = {
            id: `adj-${state.adjustments.length + 1}`,
            ...body,
            employeeId: 'emp-1',
            status: 'PENDING',
            sourceRunId: null,
            payrollRunId: null,
            retroactive: false,
            createdAt: '2026-10-18T12:00:00.000Z',
            displayName: 'Ada Lovelace',
            employeeNumber: 'E-100',
            positionName: 'Counsellor',
          };
          state.adjustments.push(adjustment);
          return json(route, adjustment, 201);
        }
        return json(route, { items: adjustmentList(new URL(request.url())) });
      });
      await page.route(prefix('/payroll/adjustments/'), (route, request) => {
        const id = new URL(request.url()).pathname.split('/')[3];
        state.adjustments = state.adjustments.map((a) =>
          a.id === id ? { ...a, status: 'CANCELLED', payrollRunId: null } : a,
        );
        return json(
          route,
          state.adjustments.find((a) => a.id === id),
          201,
        );
      });

      // Reports: the payroll register (finalized runs only).
      const register = {
        key: 'payroll.register',
        title: 'Payroll register',
        description:
          'One row per finalized payroll run and employee, by pay date. Net pay is not calculated: statutory deductions are not part of payroll yet.',
        sourcePermissions: ['payroll.read'],
        organizationPermissions: [],
        dateMode: 'RANGE',
        filters: [
          'from',
          'to',
          'organizationalUnitId',
          'departmentId',
          'teamId',
          'positionId',
          'employmentType',
        ],
        sensitive: false,
        excludesSelf: false,
        columns: [
          { key: 'payDate', label: 'Pay date', type: 'date' },
          { key: 'payGroupCode', label: 'Pay group', type: 'string' },
          { key: 'employeeNumber', label: 'Employee number', type: 'string' },
          { key: 'employeeName', label: 'Employee', type: 'string' },
          { key: 'currency', label: 'Currency', type: 'string' },
          { key: 'gross', label: 'Gross', type: 'money' },
          { key: 'deductions', label: 'Recorded deductions', type: 'money' },
          {
            key: 'adjustmentEarnings',
            label: 'Adjustment earnings (included in gross)',
            type: 'money',
          },
          {
            key: 'grossLessRecordedDeductions',
            label: 'Gross less recorded deductions (NOT net pay)',
            type: 'money',
          },
          { key: 'netPay', label: 'Net pay', type: 'string' },
        ],
        canExport: true,
      };
      await page.route(path('/reports/organizations'), (route) =>
        json(route, {
          items: [{ id: ORG, name: 'Northwind Academy', code: 'NWA', timezone: 'America/Toronto' }],
        }),
      );
      await page.route(path('/reports/catalog'), (route) =>
        json(route, { organizationId: ORG, items: [{ area: 'payroll', reports: [register] }] }),
      );
      for (const resource of ['units', 'departments', 'teams', 'positions']) {
        await page.route(path(`/organizations/${ORG}/${resource}`), (route) => json(route, []));
      }
      const rows = () => {
        if (state.run?.status !== 'FINALIZED') return [];
        const t = totals();
        const adjustmentEarnings = applied()
          .filter((a) => a.kind === 'EARNING')
          .reduce((sum, a) => sum + Number(a.amount), 0);
        return [
          {
            payDate: '2026-10-22',
            payGroupCode: 'BW',
            employeeNumber: 'E-100',
            employeeName: 'Ada Lovelace',
            currency: 'CAD',
            gross: t.gross,
            deductions: t.deductions,
            adjustmentEarnings,
            grossLessRecordedDeductions: t.gross - t.deductions,
            netPay: 'Not calculated',
          },
        ];
      };
      await page.route(path('/reports/payroll.register'), (route, request) => {
        const query = Object.fromEntries(new URL(request.url()).searchParams);
        return json(route, {
          reportKey: 'payroll.register',
          area: 'payroll',
          title: 'Payroll register',
          generatedAt: '2026-10-21T12:00:00.000Z',
          filters: query,
          scopeSummary: {
            organizationId: ORG,
            placement: 'ORGANIZATION',
            organizationWide: true,
            scopes: [{ type: 'ORGANIZATION', id: ORG }],
            positions: 3,
            openings: null,
            selfExcluded: false,
          },
          columns: register.columns,
          rows: rows(),
          suppressed: 0,
          notes: [
            'Adjustment earnings and adjustment deductions are already included in Gross and Recorded deductions; they are shown as a breakdown and must not be added again.',
            `Totals (CAD): gross ${totals().gross}, recorded deductions ${totals().deductions}.`,
          ],
          truncated: false,
        });
      });
      await page.route(path('/reports/payroll.register/export.csv'), (route, request) => {
        state.csvQuery = Object.fromEntries(new URL(request.url()).searchParams);
        const [row] = rows();
        return route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="payroll.register-2026-10-21.csv"',
            'Access-Control-Expose-Headers': 'Content-Disposition',
          },
          body: `Pay date,Employee,Gross,Gross less recorded deductions (NOT net pay),Net pay\r\n${row!.payDate},${row!.employeeName},${row!.gross},${row!.grossLessRecordedDeductions},Not calculated\r\n`,
        });
      });
    },
  };
}

/** Batch 10F: moved unchanged from e2e/batch-10d.spec.ts. A calculated run (run-1) with a calendar and a period, as after the 6A workflow's first steps. */
export async function calculatedRun(page: Page) {
  await session(page);
  const server = payrollServer();
  await server.install(page);
  server.state.calendars.push({
    id: 'cal-1',
    organizationId: ORG,
    payGroupId: '22222222-2222-4222-8222-222222222222',
    payGroup: { id: '22222222-2222-4222-8222-222222222222', code: 'BW', name: 'Biweekly' },
    cadence: 'BIWEEKLY',
    anchorDate: '2026-10-04',
    payDateOffsetDays: 5,
    processingCutoffOffsetDays: 2,
    effectiveFrom: '2026-10-04',
    effectiveTo: null,
    timezone: 'America/Toronto',
    salaryUnpaidLeaveRule: 'UNCONFIGURED',
    salaryStandardAnnualHours: null,
    periodCount: 1,
    actions: { canUpdate: false, canEnd: true },
  });
  server.state.run = { status: 'CALCULATED', calculated: true };
  return server;
}
