import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { ReportResult } from '../src/reporting/reporting-common.js';
import type { RawReportFilters } from '../src/reporting/reporting-domain.js';
import type { ReportingService } from '../src/reporting/reporting.service.js';
import {
  connectOAuth,
  FixedGoogleClock,
  googleTestServices,
  type GoogleTestServices,
} from './support/google-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  FixedReportingClock,
  REPORTING_USERS,
  reportingServices,
  seedReportingWorld,
  type ReportingWorld,
} from './support/reporting-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const H1 = { from: '2026-02-01', to: '2026-06-30' };

describe('Reporting & analytics (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  interface Ctx {
    tx: Tx;
    fx: SchedulingFixtures;
    world: ReportingWorld;
    svc: ReportingService;
    google: GoogleTestServices;
    run: (
      user: string,
      key: string,
      filters?: RawReportFilters,
      organizationId?: string,
    ) => Promise<ReportResult>;
  }

  async function scenario(body: (c: Ctx) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, REPORTING_USERS);
          const world = await seedReportingWorld(tx, fx).catch(
            (error: unknown) => {
              console.error('SEED FAILURE', error);
              throw error;
            },
          );
          const client = rollbackClient(tx);
          const google = googleTestServices(client, new FixedGoogleClock());
          const svc = reportingServices(
            client,
            new FixedReportingClock(),
            google.sheets,
          );
          const run = (
            user: string,
            key: string,
            filters: RawReportFilters = {},
            organizationId = fx.orgA,
          ) => svc.run(fx.users[user]!, key, organizationId, filters);
          await body({ tx, fx, world, svc, google, run }).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const byKey = <T extends Record<string, unknown>>(
    rows: readonly T[],
    key: string,
  ) => Object.fromEntries(rows.map((row) => [String(row[key]), row]));

  it('lists only the reports the caller can run, per organization', async () => {
    await scenario(async ({ fx, svc }) => {
      const catalog = await svc.catalog(fx.users.hr!, fx.orgA);
      const areas = catalog.items.map((item) => item.area);
      expect(areas).toEqual([
        'workforce',
        'time',
        'scheduling',
        'leave',
        'compensation',
        'payroll',
        'benefits',
        'performance',
        'recruitment',
        'onboarding',
        'documents',
      ]);
      const workforce = catalog.items[0]!.reports[0] as {
        key: string;
        canExport: boolean;
        filters: string[];
        columns: unknown[];
      };
      expect(workforce).toMatchObject({
        key: 'workforce.headcount_trend',
        canExport: true,
      });
      expect(workforce.filters).toContain('departmentId');

      const team = await svc.catalog(fx.users.teamLead!, fx.orgA);
      // Payroll is organization-level: a team grant never reaches it.
      expect(team.items.map((item) => item.area)).not.toContain('payroll');
      expect(team.items.map((item) => item.area)).toContain('compensation');
      expect(
        team.items.every((item) =>
          item.reports.every(
            (report) => (report as { canExport: boolean }).canExport === false,
          ),
        ),
      ).toBe(true);

      expect(
        (await svc.catalog(fx.users.offboarder!, fx.orgA)).items.map(
          (item) => item.area,
        ),
      ).toEqual(['offboarding']);
      for (const user of ['reportOnly', 'sourceOnly', 'split', 'orgBAdmin'])
        expect((await svc.catalog(fx.users[user]!, fx.orgA)).items).toEqual([]);

      const organizations = await svc.organizations(fx.users.teamLead!);
      expect(organizations.items.map((o) => o.id)).toEqual([fx.orgA]);
      expect((await svc.organizations(fx.users.sourceOnly!)).items).toEqual([]);
    });
  });

  it('requires report.read and the source permission over the same scope', async () => {
    await scenario(async ({ fx, world, run }) => {
      // report.read alone, the source permission alone, or each over a different scope: refused.
      for (const user of ['reportOnly', 'sourceOnly', 'split', 'offboarder'])
        expect(
          await failure(run(user, 'workforce.headcount_trend')),
        ).toMatchObject({ status: 403, code: 'REPORT_ACCESS_DENIED' });
      // Another organization's grants never reach this one (nor this one's the other).
      expect(
        await failure(run('orgBAdmin', 'workforce.distribution')),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(run('hr', 'workforce.distribution', {}, fx.orgB)),
      ).toMatchObject({ status: 403 });
      // An unknown organization looks the same as one without access.
      expect(
        await failure(
          run(
            'hr',
            'workforce.distribution',
            {},
            '00000000-0000-4000-8000-000000000099',
          ),
        ),
      ).toMatchObject({ status: 403 });
      // Payroll is organization-level: Team A payroll.read never reaches it.
      expect(
        await failure(run('teamLead', 'payroll.period_totals', H1)),
      ).toMatchObject({ status: 403 });
      // Unknown reports and unsupported filters.
      expect(await failure(run('hr', 'workforce.salaries'))).toMatchObject({
        status: 404,
        code: 'REPORT_NOT_FOUND',
      });
      expect(
        await failure(
          run('hr', 'workforce.assignment_status', { from: '2026-01-01' }),
        ),
      ).toMatchObject({ status: 400, code: 'REPORT_FILTER_UNSUPPORTED' });
      expect(
        await failure(
          run('hr', 'workforce.turnover', { from: '2020-01-01', to: H1.to }),
        ),
      ).toMatchObject({ status: 400, code: 'REPORT_RANGE_TOO_LONG' });

      // Filters only narrow: outside the scope (or another organization's) is a 404.
      for (const filters of [
        { departmentId: fx.deptB },
        { departmentId: fx.deptA }, // contains Team A but is wider than the grant
        { organizationalUnitId: fx.unitChild },
        { positionId: fx.positionDeptB },
        { positionId: world.positionOrgB },
        { teamId: '00000000-0000-4000-8000-000000000099' },
      ]) {
        expect(
          await failure(run('teamLead', 'workforce.distribution', filters)),
        ).toMatchObject({ status: 404, code: 'REPORT_FILTER_NOT_FOUND' });
      }
      expect(
        await failure(
          run('hr', 'workforce.distribution', {
            positionId: world.positionOrgB,
          }),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        (await run('teamLead', 'workforce.distribution', { teamId: fx.teamA }))
          .rows,
      ).toHaveLength(1);
    });
  });

  it('computes workforce headcount, movements, turnover and distributions within scope', async () => {
    await scenario(async ({ fx, run }) => {
      const trend = await run('hr', 'workforce.headcount_trend', H1);
      expect(trend.columns.map((c) => c.key)).toEqual([
        'month',
        'headcountStart',
        'headcountEnd',
        'hires',
        'terminations',
        'turnoverRate',
      ]);
      const months = byKey(trend.rows, 'month');
      expect(Object.keys(months)).toEqual([
        '2026-02',
        '2026-03',
        '2026-04',
        '2026-05',
        '2026-06',
      ]);
      expect(months['2026-03']).toMatchObject({
        headcountStart: 12,
        headcountEnd: 13,
        hires: 1,
        terminations: 0,
      });
      expect(months['2026-05']).toMatchObject({
        headcountStart: 13,
        headcountEnd: 12,
        terminations: 1,
      });
      expect(trend.scopeSummary).toMatchObject({
        organizationId: fx.orgA,
        organizationWide: true,
        selfExcluded: false,
      });

      expect((await run('hr', 'workforce.turnover', H1)).rows[0]).toEqual({
        from: '2026-02-01',
        to: '2026-06-30',
        headcountStart: 12,
        headcountEnd: 12,
        averageHeadcount: 12,
        hires: 1,
        terminations: 1,
        turnoverRate: 8.33,
      });
      // Team A only: E1, E2, T3–T5 plus T7 (leaves) / T6 (joins).
      const team = await run('teamLead', 'workforce.turnover', H1);
      expect(team.rows[0]).toMatchObject({
        headcountStart: 6,
        headcountEnd: 6,
        hires: 1,
        terminations: 1,
        turnoverRate: 16.67,
      });
      expect(team.scopeSummary).toMatchObject({
        organizationWide: false,
        scopes: [{ type: 'TEAM', id: fx.teamA }],
        positions: 1,
      });
      // Dept A reaches Team A and A1's department-level position.
      expect(
        (await run('deptReader', 'workforce.turnover', H1)).rows[0],
      ).toMatchObject({ headcountStart: 7, headcountEnd: 7 });

      const distribution = await run('hr', 'workforce.distribution', {
        asOf: '2026-06-30',
      });
      expect(
        distribution.rows.map((r) => [
          r.groupLabel,
          r.headcount,
          r.assignments,
        ]),
      ).toEqual([
        ['Dept A', 7, 7],
        ['Dept B', 6, 6],
        ['(No department)', 1, 1],
      ]);
      const partTime = await run('hr', 'workforce.distribution', {
        asOf: '2026-06-30',
        groupBy: 'employmentType',
        employmentType: 'PART_TIME',
      });
      expect(partTime.rows).toEqual([
        {
          groupKey: 'PART_TIME',
          groupLabel: 'PART_TIME',
          headcount: 7,
          assignments: 7,
        },
      ]);
      expect(partTime.scopeSummary.organizationWide).toBe(false);
      const status = byKey(
        (await run('teamLead', 'workforce.assignment_status')).rows,
        'status',
      );
      expect(status.ACTIVE).toMatchObject({ assignments: 6, employees: 6 });
      expect(status.ENDED).toMatchObject({ assignments: 1 });
    });
  });

  it('reports time, scheduling and leave from their own records', async () => {
    await scenario(async ({ run }) => {
      const march = { from: '2026-03-01', to: '2026-03-31' };
      const hours = await run('hr', 'time.hours', march);
      expect(hours.rows).toEqual([
        {
          groupKey: '2026-03',
          groupLabel: '2026-03',
          closedEntries: 3,
          openEntries: 1,
          employees: 4,
          grossMinutes: 1200,
          unpaidBreakMinutes: 30,
          netMinutes: 1170,
          netHours: 19.5,
        },
      ]);
      const byDepartment = await run('hr', 'time.hours', {
        ...march,
        groupBy: 'department',
      });
      expect(
        byDepartment.rows.map((r) => [r.groupLabel, r.netMinutes]),
      ).toEqual([
        ['Dept A', 930],
        ['Dept B', 240],
      ]);
      const exceptions = byKey(
        (await run('hr', 'time.exceptions', march)).rows,
        'type',
      );
      expect(exceptions.LATE_ARRIVAL).toMatchObject({ total: 1, open: 1 });
      expect(exceptions.MISSING_CLOCK_OUT).toMatchObject({
        total: 1,
        resolved: 1,
      });
      // Team A sees its own late arrival but not Dept B's missing clock-out.
      const teamExceptions = byKey(
        (await run('teamLead', 'time.exceptions', march)).rows,
        'type',
      );
      expect(teamExceptions.LATE_ARRIVAL!.total).toBe(1);
      expect(teamExceptions.MISSING_CLOCK_OUT!.total).toBe(0);
      expect(
        byKey((await run('hr', 'time.corrections', march)).rows, 'type')
          .CHANGE_CLOCK_OUT,
      ).toMatchObject({ total: 1, approved: 1 });

      expect((await run('hr', 'scheduling.hours', march)).rows).toEqual([
        {
          groupKey: '2026-03',
          groupLabel: '2026-03',
          shifts: 2,
          employees: 2,
          scheduledMinutes: 960,
          scheduledHours: 16,
        },
      ]);
      expect((await run('hr', 'scheduling.adherence', march)).rows).toEqual([
        {
          groupKey: '2026-03',
          groupLabel: '2026-03',
          shifts: 2,
          shiftsWorked: 1,
          shiftsNotWorked: 1,
          coverageRate: 50,
          scheduledMinutes: 960,
          workedMinutes: 450,
          adherenceRate: 46.88,
          unscheduledEntries: 2,
        },
      ]);
      // Adherence also needs time.view: schedule.read alone (Team A lead has none) is refused.
      expect(
        await failure(run('teamLead', 'scheduling.adherence', march)),
      ).toMatchObject({ status: 403 });

      expect((await run('hr', 'leave.usage', H1)).rows).toEqual([
        {
          month: '2026-03',
          leaveTypeCode: 'VAC',
          leaveTypeName: 'Vacation',
          classification: 'PAID',
          days: 2,
          minutes: 960,
          hours: 16,
          employees: 1,
        },
      ]);
      expect(
        (await run('hr', 'leave.balances', { asOf: '2026-06-30' })).rows,
      ).toEqual([
        {
          leaveTypeCode: 'VAC',
          leaveTypeName: 'Vacation',
          accounts: 2,
          totalMinutes: 3840,
          averageMinutes: 1920,
          totalHours: 64,
        },
      ]);
      expect((await run('hr', 'leave.requests', H1)).rows).toEqual([
        {
          leaveTypeCode: 'VAC',
          leaveTypeName: 'Vacation',
          total: 2,
          pending: 1,
          approved: 1,
          rejected: 0,
          cancelled: 0,
        },
      ]);
      // Team A: only T3's balance.
      expect(
        (await run('teamLead', 'leave.balances', { asOf: '2026-06-30' }))
          .rows[0],
      ).toMatchObject({ accounts: 1, totalMinutes: 3840 });
    });
  });

  it('suppresses small compensation groups and never returns per-person pay', async () => {
    await scenario(async ({ fx, run }) => {
      const distribution = await run('hr', 'compensation.distribution', {
        asOf: '2026-06-30',
      });
      expect(distribution.rows).toEqual([
        {
          payBasis: 'HOURLY',
          salaryArrangement: null,
          currency: 'CAD',
          bucketFrom: 15,
          bucketTo: 20,
          employees: 5,
          suppressed: false,
        },
        {
          payBasis: 'HOURLY',
          salaryArrangement: null,
          currency: 'CAD',
          bucketFrom: 20,
          bucketTo: 25,
          employees: 5,
          suppressed: false,
        },
        {
          payBasis: 'HOURLY',
          salaryArrangement: null,
          currency: 'CAD',
          bucketFrom: 30,
          bucketTo: 35,
          employees: null,
          suppressed: true,
        },
        {
          payBasis: 'HOURLY',
          salaryArrangement: null,
          currency: 'CAD',
          bucketFrom: 40,
          bucketTo: 45,
          employees: null,
          suppressed: true,
        },
        {
          payBasis: 'SALARY',
          salaryArrangement: 'ANNUAL',
          currency: 'CAD',
          bucketFrom: 60000,
          bucketTo: 70000,
          employees: null,
          suppressed: true,
        },
      ]);
      expect(distribution.suppressed).toBe(3);
      // Team A: one bucket of 5 and a lone bucket of 1 — both hidden (the 5 would reveal the 1).
      const team = await run('teamLead', 'compensation.distribution', {
        asOf: '2026-06-30',
      });
      expect(team.suppressed).toBe(2);
      expect(team.rows.every((r) => r.employees === null && r.suppressed)).toBe(
        true,
      );

      const byGroup = await run('hr', 'compensation.by_group', {
        asOf: '2026-06-30',
      });
      expect(byGroup.rows).toEqual([
        {
          groupKey: fx.deptA,
          groupLabel: 'Dept A',
          payBasis: 'HOURLY',
          salaryArrangement: null,
          currency: 'CAD',
          employees: 7,
          averageRate: 24.93,
          medianRate: 23,
          suppressed: false,
        },
        {
          groupKey: fx.deptB,
          groupLabel: 'Dept B',
          payBasis: 'HOURLY',
          salaryArrangement: null,
          currency: 'CAD',
          employees: 6,
          averageRate: 21,
          medianRate: 17.5,
          suppressed: false,
        },
        {
          groupKey: null,
          groupLabel: '(No department)',
          payBasis: 'SALARY',
          salaryArrangement: 'ANNUAL',
          currency: 'CAD',
          employees: null,
          averageRate: null,
          medianRate: null,
          suppressed: true,
        },
      ]);
      // Narrowing to one position cannot single anyone out.
      const one = await run('hr', 'compensation.by_group', {
        asOf: '2026-06-30',
        positionId: fx.positionOrg,
      });
      expect(one.rows.every((r) => r.suppressed)).toBe(true);

      const changes = byKey(
        (await run('hr', 'compensation.changes', H1)).rows,
        'month',
      );
      expect(changes['2026-04']).toEqual({
        month: '2026-04',
        changes: 1,
        corrections: 0,
        assignments: 1,
      });
      expect(changes['2026-02']!.changes).toBe(0);
    });
  });

  it('reports finalized payroll only, with period-over-period change and group suppression', async () => {
    await scenario(async ({ fx, run }) => {
      const totals = await run('hr', 'payroll.period_totals', H1);
      expect(
        totals.rows.map((r) => [
          r.payDate,
          r.employees,
          r.gross,
          r.deductions,
          r.employerContributions,
          r.grossLessRecordedDeductions,
          r.netPay,
          r.totalCost,
          r.grossChange,
          r.totalCostChange,
          r.suppressed,
        ]),
      ).toEqual([
        [
          '2026-03-06',
          8,
          6800,
          1180,
          585,
          5620,
          'Not calculated',
          7385,
          null,
          null,
          false,
        ],
        [
          '2026-03-20',
          8,
          7000,
          1150,
          575,
          5850,
          'Not calculated',
          7575,
          200,
          190,
          false,
        ],
      ]);
      expect(totals.notes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Net pay is not calculated/),
        ]),
      );
      // Narrowed to Team A (5 people): shown; to Dept B (3 people): suppressed.
      const team = await run('hr', 'payroll.period_totals', {
        ...H1,
        teamId: fx.teamA,
      });
      expect(team.rows.map((r) => [r.gross, r.grossChange])).toEqual([
        [5000, null],
        [5500, 500],
      ]);
      const deptB = await run('hr', 'payroll.period_totals', {
        ...H1,
        departmentId: fx.deptB,
      });
      expect(deptB.suppressed).toBe(2);
      expect(deptB.rows.every((r) => r.gross === null && r.suppressed)).toBe(
        true,
      );

      const groups = await run('hr', 'payroll.by_group', H1);
      expect(groups.rows).toEqual([
        {
          groupKey: fx.deptA,
          groupLabel: 'Dept A',
          currency: 'CAD',
          employees: 5,
          gross: 10500,
          deductions: 2000,
          employerContributions: 1000,
          grossLessRecordedDeductions: 8500,
          netPay: 'Not calculated',
          totalCost: 11500,
          suppressed: false,
        },
        expect.objectContaining({
          groupLabel: 'Dept B',
          employees: null,
          gross: null,
          suppressed: true,
        }),
        expect.objectContaining({
          groupLabel: '(No department)',
          gross: null,
          suppressed: true,
        }),
      ]);
      expect(groups.suppressed).toBe(2);
      expect(groups.notes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Net pay is not calculated/),
        ]),
      );
    });
  });

  it('reports benefit enrollment and finalized benefit costs', async () => {
    await scenario(async ({ fx, run }) => {
      const enrollment = await run('hr', 'benefits.enrollment', {
        asOf: '2026-06-30',
      });
      expect(enrollment.rows).toEqual([
        {
          planCode: `HEALTH-${fx.suffix}`,
          planName: 'Health',
          benefitType: 'HEALTH',
          enrolledEmployees: 6,
          waivedEmployees: 1,
          headcount: 12,
          participationRate: 50,
          suppressed: false,
        },
      ]);
      // Batch 7C (B16): a plan elected by fewer than five employees in scope is suppressed.
      const enrollmentDeptB = await run('hr', 'benefits.enrollment', {
        asOf: '2026-06-30',
        departmentId: fx.deptB,
      });
      expect(enrollmentDeptB.rows[0]).toMatchObject({
        planCode: `HEALTH-${fx.suffix}`,
        enrolledEmployees: null,
        waivedEmployees: null,
        participationRate: null,
        suppressed: true,
      });
      const costs = await run('hr', 'benefits.contributions', H1);
      expect(costs.rows).toEqual([
        {
          planCode: `HEALTH-${fx.suffix}`,
          planName: 'Health',
          currency: 'CAD',
          employees: 6,
          employeeDeductions: 300,
          employerContributions: 600,
          totalCost: 900,
          suppressed: false,
        },
      ]);
      const deptB = await run('hr', 'benefits.contributions', {
        ...H1,
        departmentId: fx.deptB,
      });
      expect(deptB.rows[0]).toMatchObject({
        employees: null,
        employeeDeductions: null,
        suppressed: true,
      });
    });
  });

  it('reports performance completion, suppressed ratings and goals, never the caller’s own review', async () => {
    await scenario(async ({ fx, world, run }) => {
      const completion = await run('hr', 'performance.cycle_completion', H1);
      expect(completion.rows).toEqual([
        {
          cycleCode: `C1-${fx.suffix}`,
          cycleName: 'H1 2026',
          cycleStatus: 'OPEN',
          reviews: 11,
          completed: 9,
          completionRate: 81.82,
          selfSubmitted: 9,
          reviewerSubmitted: 9,
          acknowledged: 0,
          overdueSelf: 2,
          overdueReviewer: 2,
        },
      ]);
      const ratings = await run('hr', 'performance.rating_distribution', {
        ...H1,
        cycleId: world.cycleId,
      });
      expect(
        ratings.rows.map((r) => [r.ratingValue, r.reviews, r.suppressed]),
      ).toEqual([
        [3, 5, false],
        [4, null, true],
        [5, null, true],
      ]);
      // Employee 1 reports over the organization but never over their own review.
      const self = await run('self1', 'performance.cycle_completion', H1);
      expect(self.rows[0]).toMatchObject({ reviews: 10, completed: 8 });
      expect(self.scopeSummary.selfExcluded).toBe(true);
      const selfRatings = await run(
        'self1',
        'performance.rating_distribution',
        H1,
      );
      expect(selfRatings.rows.every((r) => r.suppressed)).toBe(true);
      // Team A: 6 reviews; ratings 3 (5) and 4 (1) → both hidden.
      const team = await run('teamLead', 'performance.rating_distribution', H1);
      expect(team.suppressed).toBe(2);

      const goals = await run('hr', 'performance.goals', H1);
      expect(goals.rows).toEqual([
        {
          groupKey: fx.deptA,
          groupLabel: 'Dept A',
          goals: 2,
          notStarted: 1,
          inProgress: 0,
          completed: 1,
          cancelled: 0,
          overdue: 1,
          completionRate: 50,
        },
        {
          groupKey: fx.deptB,
          groupLabel: 'Dept B',
          goals: 1,
          notStarted: 0,
          inProgress: 1,
          completed: 0,
          cancelled: 0,
          overdue: 1,
          completionRate: 0,
        },
      ]);
      const evidence = await run('hr', 'performance.evidence', H1);
      expect(evidence.rows).toEqual([
        {
          kind: 'ASSESSMENT',
          provider: 'GOOGLE_FORMS',
          records: 5,
          employees: 5,
          passed: 4,
          failed: 1,
          passRate: 80,
          suppressed: false,
        },
        expect.objectContaining({ kind: 'CERTIFICATION', suppressed: true }),
        expect.objectContaining({ kind: 'TRAINING', suppressed: true }),
      ]);
      expect(
        await failure(
          run('hr', 'performance.cycle_completion', {
            ...H1,
            cycleId: '00000000-0000-4000-8000-000000000099',
          }),
        ),
      ).toMatchObject({ status: 404 });
    });
  });

  it('reports recruitment by opening placement, without anyone’s own candidacy', async () => {
    await scenario(async ({ fx, world, run }) => {
      const openings = byKey(
        (await run('hr', 'recruitment.openings', H1)).rows,
        'openingTitle',
      );
      expect(openings['Opening O1']).toMatchObject({
        status: 'OPEN',
        openingCount: 2,
        hiredCount: 1,
        remaining: 1,
        applications: 3,
        active: 2,
        hired: 1,
      });
      expect(openings['Opening O2']).toMatchObject({
        applications: 1,
        rejected: 1,
      });
      // Employee 1 never counts their own (internal) application.
      const self = await run('self1', 'recruitment.openings', {
        ...H1,
        openingId: world.openings.O1,
      });
      expect(self.rows).toHaveLength(1);
      expect(self.rows[0]).toMatchObject({ applications: 2, active: 1 });
      // Team A reaches only the Team A opening.
      const team = await run('teamLead', 'recruitment.openings', H1);
      expect(team.rows.map((r) => r.openingTitle)).toEqual(['Opening O1']);
      expect(team.scopeSummary.openings).toBe(1);
      expect(
        await failure(
          run('teamLead', 'recruitment.sources', {
            ...H1,
            openingId: world.openings.O2,
          }),
        ),
      ).toMatchObject({ status: 404 });

      const sources = byKey(
        (await run('hr', 'recruitment.sources', H1)).rows,
        'source',
      );
      expect(sources.REFERRAL).toMatchObject({ applications: 2, hired: 0 });
      expect(sources.JOB_BOARD).toMatchObject({
        applications: 1,
        hired: 1,
        hireRate: 100,
      });
      expect(sources.DIRECT).toMatchObject({ applications: 1 });

      const stages = byKey(
        (await run('hr', 'recruitment.stages', H1)).rows,
        'stageCode',
      );
      expect(stages.APPLIED).toMatchObject({
        currentApplications: 1,
        entered: 2,
        completedStays: 2,
        averageDaysInStage: 3,
      });
      expect(stages.INTERVIEW).toMatchObject({
        currentApplications: 1,
        entered: 2,
        completedStays: 1,
        averageDaysInStage: 6,
      });
      expect(stages.OFFER).toMatchObject({
        entered: 1,
        completedStays: 0,
        averageDaysInStage: null,
      });
      const offers = byKey(
        (await run('hr', 'recruitment.offers', H1)).rows,
        'status',
      );
      expect(offers.ACCEPTED).toEqual({
        status: 'ACCEPTED',
        offers: 1,
        share: 50,
      });
      expect(offers.DECLINED!.offers).toBe(1);
      // No candidate data anywhere in a result.
      expect(
        JSON.stringify(await run('hr', 'recruitment.openings', H1)),
      ).not.toMatch(/Candidate/);
      expect(fx.orgA).toBeTruthy();
    });
  });

  it('keeps offboarding behind offboarding.read and never returns reasons', async () => {
    await scenario(async ({ run }) => {
      const onboarding = await run('hr', 'onboarding.workflows', H1);
      expect(onboarding.rows).toEqual([
        {
          groupKey: '2026-02',
          groupLabel: '2026-02',
          workflows: 1,
          active: 1,
          completed: 0,
          cancelled: 0,
          completionRate: 0,
          overdueTasks: 1,
          medianDaysToComplete: null,
        },
        {
          groupKey: '2026-03',
          groupLabel: '2026-03',
          workflows: 1,
          active: 0,
          completed: 1,
          cancelled: 0,
          completionRate: 100,
          overdueTasks: 0,
          medianDaysToComplete: 10,
        },
      ]);
      // onboarding.read never reaches offboarding, and the reverse.
      expect(
        await failure(run('hr', 'offboarding.workflows', H1)),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(run('offboarder', 'onboarding.workflows', H1)),
      ).toMatchObject({ status: 403 });
      const offboarding = await run('offboarder', 'offboarding.workflows', H1);
      expect(offboarding.rows).toEqual([
        expect.objectContaining({
          groupKey: '2026-05',
          workflows: 1,
          completed: 1,
          medianDaysToComplete: 14,
        }),
      ]);
      expect(JSON.stringify(offboarding)).not.toMatch(/reason/i);
    });
  });

  it('counts confidential documents only with the matching read permission', async () => {
    await scenario(async ({ fx, run }) => {
      // document.read: CERT (manager-visible) only; the HR-only BG requirement is excluded.
      const requirements = await run('hr', 'documents.requirements');
      expect(requirements.rows).toEqual([
        {
          typeCode: 'CERT',
          typeName: 'CERT',
          employees: 7,
          satisfied: 2,
          missing: 4,
          expired: 1,
          completionRate: 28.57,
        },
      ]);
      const expiry = await run('hr', 'documents.expiry');
      expect(expiry.rows).toEqual([
        {
          typeCode: 'CERT',
          typeName: 'CERT',
          confidentiality: 'MANAGER_VISIBLE',
          documents: 3,
          expired: 1,
          expiringSoon: 1,
          valid: 1,
        },
      ]);
      // document.confidential.read adds HR-only (BG) but never restricted (ID) documents.
      const confidential = byKey(
        (await run('docsConfidential', 'documents.requirements')).rows,
        'typeCode',
      );
      expect(confidential.BG).toMatchObject({
        employees: 6,
        expired: 1,
        missing: 5,
      });
      const confidentialExpiry = await run(
        'docsConfidential',
        'documents.expiry',
      );
      expect(confidentialExpiry.rows.map((r) => r.typeCode)).toEqual([
        'BG',
        'CERT',
      ]);
      expect(JSON.stringify(confidentialExpiry)).not.toMatch(/RESTRICTED/);
      // Team A: its own employees only.
      const team = await run('teamLead', 'documents.requirements');
      expect(team.rows[0]).toMatchObject({ employees: 6, satisfied: 2 });

      const acknowledgements = await run('hr', 'documents.acknowledgements');
      expect(acknowledgements.rows).toEqual([
        {
          policyCode: `CONDUCT-${fx.suffix}`,
          policyTitle: 'Code of conduct',
          versionNumber: 1,
          versionLabel: 'v1',
          current: true,
          audience: 12,
          acknowledged: 2,
          pending: 10,
          completionRate: 16.67,
        },
      ]);
      expect(
        (await run('teamLead', 'documents.acknowledgements')).rows[0],
      ).toMatchObject({ audience: 6, acknowledged: 2 });
    });
  });

  it('Batch 4F: timesheet detail and sign-in reports, every exception type, row scope and marked truncation', async () => {
    await scenario(async ({ tx, fx, world, svc, run, google }) => {
      const { employees, assignments } = world;
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      const period = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: new Date('2026-03-02T00:00:00.000Z'),
          endDate: new Date('2026-03-08T00:00:00.000Z'),
        },
      });
      const sheet = await tx.timesheet.create({
        data: {
          employeeId: employees.E1!,
          timePeriodId: period.id,
          status: 'APPROVED',
          submittedByUserId: fx.users.hr!,
          submittedAt: new Date('2026-03-09T12:00:00Z'),
          approvedByUserId: fx.users.hr!,
          approvedAt: new Date('2026-03-09T13:00:00Z'),
        },
      });
      // Team A approved at 480; time recorded later moved the live figure to 510.
      await tx.timesheetSegment.create({
        data: {
          timesheetId: sheet.id,
          employmentAssignmentId: assignments.E1!,
          status: 'APPROVED',
          reviewedByUserId: fx.users.hr!,
          reviewedAt: new Date('2026-03-09T13:00:00Z'),
          grossMinutes: 540,
          policyDeductionMinutes: 30,
          netWorkedMinutes: 510,
          approvedWorkedMinutes: 480,
        },
      });
      await tx.timesheetSegment.create({
        data: {
          timesheetId: sheet.id,
          employmentAssignmentId: assignments.E1B!,
          status: 'PENDING',
          grossMinutes: 240,
          netWorkedMinutes: 240,
        },
      });
      const signIn = (assignment: string, at: string) =>
        tx.attendanceSignIn.create({
          data: {
            employeeId: employees.E1!,
            employmentAssignmentId: assignment,
            signedInAt: new Date(at),
            timezone: 'America/Toronto',
            workDate: new Date(`${at.slice(0, 10)}T00:00:00.000Z`),
            source: 'MANUAL',
            recordedByUserId: fx.users.hr!,
            reason: 'Seeded',
          },
        });
      await signIn(assignments.E1!, '2026-03-03T14:05:00Z');
      await signIn(assignments.E1B!, '2026-03-04T14:10:00Z');
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employmentAssignmentId: assignments.E1! },
      });
      // A no-show and a time recording after approval: both types are reported now.
      // Only this scenario's shifts: other spec files commit shifts of their own organizations
      // to the same database while this one runs.
      const shift = await tx.scheduledShift.findFirstOrThrow({
        where: {
          revisions: { some: {} },
          schedule: { organizationId: fx.orgA },
        },
        include: { revisions: { take: 1 }, employmentAssignment: true },
      });
      await tx.attendanceException.create({
        data: {
          employeeId: shift.employmentAssignment.employeeId,
          employmentAssignmentId: shift.employmentAssignmentId,
          scheduledShiftId: shift.id,
          scheduledShiftRevisionId: shift.revisions[0]!.id,
          type: 'NO_SHOW',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'OPEN',
          detectedAt: new Date('2026-03-05T15:00:00Z'),
        },
      });
      await tx.attendanceException.create({
        data: {
          employeeId: employees.E1!,
          employmentAssignmentId: assignments.E1!,
          timeEntryId: entry.id,
          type: 'RECORDED_AFTER_APPROVAL',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'OPEN',
          detectedAt: new Date('2026-03-05T16:00:00Z'),
        },
      });
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
      const march = { from: '2026-03-01', to: '2026-03-31' };

      const detail = await run('hr', 'time.timesheet-detail', march);
      expect(
        detail.rows.map((r) => [
          r.position,
          r.segmentStatus,
          r.approvedMinutes,
          r.liveNetMinutes,
          r.differsFromApproved,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [expect.any(String), 'APPROVED', 480, 510, true],
          [expect.any(String), 'PENDING', null, 240, null],
        ]),
      );
      expect(detail.rows).toHaveLength(2);
      expect(detail.truncated).toBe(false);
      // No contact details or identifiers beyond the employee number.
      expect(detail.columns.map((column) => column.key)).not.toEqual(
        expect.arrayContaining([
          'email',
          'personalEmail',
          'phone',
          'employeeId',
        ]),
      );
      // Row-level scope: Team A's lead sees Team A's segment only.
      const team = await run('teamLead', 'time.timesheet-detail', march);
      expect(team.rows.map((r) => r.segmentStatus)).toEqual(['APPROVED']);
      // Another organization's administrator gets nothing of Organization A.
      expect(
        await failure(run('orgBAdmin', 'time.timesheet-detail', march)),
      ).toMatchObject({ status: 403 });

      const signIns = await run('hr', 'time.sign-ins', march);
      expect(signIns.rows.map((r) => [r.workDate, r.signedInAt])).toEqual([
        ['2026-03-03', '2026-03-03 09:05'],
        ['2026-03-04', '2026-03-04 09:10'],
      ]);
      expect(
        (await run('teamLead', 'time.sign-ins', march)).rows.map(
          (r) => r.workDate,
        ),
      ).toEqual(['2026-03-03']);

      const exceptions = byKey(
        (await run('hr', 'time.exceptions', march)).rows,
        'type',
      );
      expect(exceptions.NO_SHOW).toMatchObject({ total: 1, open: 1 });
      expect(exceptions.RECORDED_AFTER_APPROVAL).toMatchObject({
        total: 1,
        open: 1,
      });

      // Exports need report.export, and a capped export says so in the file.
      expect(
        await failure(
          svc.exportCsv(
            'time.sign-ins',
            fx.orgA,
            march,
            ctx(fx.users.teamLead!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const csv = await svc.exportCsv(
        'time.sign-ins',
        fx.orgA,
        march,
        ctx(fx.users.hr!, 'export-4f'),
      );
      expect(csv.truncated).toBe(false);
      expect(csv.content).not.toContain('TRUNCATED');
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      await tx.attendanceSignIn.createMany({
        data: Array.from({ length: 5001 }, (_, index) => ({
          employeeId: employees.E1!,
          employmentAssignmentId: assignments.E1!,
          signedInAt: new Date(
            Date.parse('2026-03-10T12:00:00Z') + index * 60_000,
          ),
          timezone: 'America/Toronto',
          workDate: new Date('2026-03-10T00:00:00.000Z'),
          source: 'MANUAL' as const,
          recordedByUserId: fx.users.hr!,
          reason: 'Seeded',
        })),
      });
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
      const capped = await svc.exportCsv(
        'time.sign-ins',
        fx.orgA,
        march,
        ctx(fx.users.hr!, 'export-4f-capped'),
      );
      expect(capped.truncated).toBe(true);
      const lines = capped.content.trimEnd().split('\r\n');
      expect(lines).toHaveLength(1 + 5000 + 1);
      expect(lines.at(-1)).toMatch(/^"?TRUNCATED: /);
      // Google Sheets: the same cap, the marker as the last row and the flag in the response.
      await connectOAuth(
        google,
        fx.orgA,
        fx.users.googleAdmin!,
        ['SHEETS_EXPORT'],
        'auth-code-4f',
      );
      const sheetExport = await svc.exportGoogleSheets(
        'time.sign-ins',
        fx.orgA,
        march,
        ctx(fx.users.hr!, 'export-4f-sheet'),
      );
      expect(sheetExport.truncated).toBe(true);
      const exported = google.fake.spreadsheets.find(
        (s) => s.id === sheetExport.spreadsheetId,
      )!;
      expect(exported.rows).toHaveLength(1 + 5000 + 1);
      expect(String(exported.rows.at(-1)![0])).toMatch(/^TRUNCATED: /);
      expect(
        exported.rows
          .at(-1)!
          .slice(1)
          .every((cell) => cell === null),
      ).toBe(true);
    });
  });

  it('exports CSV and Google Sheets only with report.export, and audits every export', async () => {
    await scenario(async ({ tx, fx, svc, google }) => {
      expect(
        await failure(
          svc.exportCsv(
            'workforce.distribution',
            fx.orgA,
            {},
            ctx(fx.users.teamLead!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const csv = await svc.exportCsv(
        'workforce.distribution',
        fx.orgA,
        { asOf: '2026-06-30' },
        ctx(fx.users.hr!, 'export-1'),
      );
      expect(csv.fileName).toBe('workforce-distribution-2026-10-06.csv');
      expect(csv.content.split('\r\n')).toEqual([
        'Group key,Group,Employees,Assignments',
        `${fx.deptA},Dept A,7,7`,
        `${fx.deptB},Dept B,6,6`,
        ',(No department),1,1',
        '',
      ]);
      const audits = await tx.auditLog.findMany({
        where: { action: 'REPORT_EXPORTED', actorUserId: fx.users.hr! },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        entityType: 'Organization',
        entityId: fx.orgA,
        correlationId: 'export-1',
        metadata: {
          reportKey: 'workforce.distribution',
          format: 'CSV',
          rowCount: 3,
          suppressed: 0,
          filters: {
            organizationId: fx.orgA,
            asOf: '2026-06-30',
            groupBy: 'department',
          },
        },
      });
      expect(JSON.stringify(audits[0]!.metadata)).not.toMatch(/Dept A/);

      // Sheets: no connection → 409; nothing exported, nothing audited.
      expect(
        await failure(
          svc.exportGoogleSheets(
            'compensation.distribution',
            fx.orgA,
            { asOf: '2026-06-30' },
            ctx(fx.users.hr!),
          ),
        ),
      ).toMatchObject({ status: 409, code: 'GOOGLE_CONNECTION_REQUIRED' });
      // A connection without the Sheets capability is not enough either.
      await connectOAuth(google, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      expect(
        await failure(
          svc.exportGoogleSheets(
            'compensation.distribution',
            fx.orgA,
            { asOf: '2026-06-30' },
            ctx(fx.users.hr!),
          ),
        ),
      ).toMatchObject({ status: 409, code: 'GOOGLE_CONNECTION_REQUIRED' });
      await google.connections.disconnect(fx.orgA, ctx(fx.users.googleAdmin!));
      await connectOAuth(
        google,
        fx.orgA,
        fx.users.googleAdmin!,
        ['SHEETS_EXPORT'],
        'auth-code-2',
      );
      // report.export is still required.
      expect(
        await failure(
          svc.exportGoogleSheets(
            'workforce.distribution',
            fx.orgA,
            {},
            ctx(fx.users.teamLead!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const sheet = await svc.exportGoogleSheets(
        'compensation.distribution',
        fx.orgA,
        { asOf: '2026-06-30' },
        ctx(fx.users.hr!, 'export-2'),
      );
      // Batch 4F (Q9): the response says whether the export was capped.
      expect(sheet).toEqual({
        spreadsheetId: expect.any(String),
        truncated: false,
      });
      const exported = google.fake.spreadsheets.find(
        (s) => s.id === sheet.spreadsheetId,
      )!;
      expect(exported.title).toBe('Pay distribution 2026-10-06');
      expect(exported.rows[0]).toEqual([
        'Pay basis',
        'Salary arrangement',
        'Currency',
        'From',
        'To (exclusive)',
        'Employees',
        'Suppressed',
      ]);
      expect(exported.rows[3]).toEqual([
        'HOURLY',
        null,
        'CAD',
        30,
        35,
        null,
        true,
      ]);
      const sheetAudit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'REPORT_EXPORTED', correlationId: 'export-2' },
      });
      expect(sheetAudit.metadata).toMatchObject({
        reportKey: 'compensation.distribution',
        format: 'GOOGLE_SHEETS',
        rowCount: 5,
        suppressed: 3,
        spreadsheetId: sheet.spreadsheetId,
      });
      // Running a report is a read: not audited.
      await svc.run(fx.users.hr!, 'workforce.turnover', fx.orgA, H1);
      expect(
        await tx.auditLog.count({
          where: { action: 'REPORT_EXPORTED', actorUserId: fx.users.hr! },
        }),
      ).toBe(2);
    });
  });
});
