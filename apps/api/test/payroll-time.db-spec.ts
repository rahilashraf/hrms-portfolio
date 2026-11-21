import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { preparePayrollPeriods } from '../src/payroll/payroll-jobs.js';
import {
  d,
  FixedPayrollClock,
  PAYROLL_USERS,
  payGroup,
  payrollServices,
  type PayrollServices,
} from './support/payroll-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  svc: PayrollServices;
  admin: ReturnType<typeof ctx>;
}

const calendar = (payGroupId: string) => ({
  payGroupId,
  cadence: 'BIWEEKLY' as const,
  timezone: 'America/Toronto',
  anchorDate: '2026-10-04',
  payDateOffsetDays: 5,
  processingCutoffOffsetDays: 2,
  effectiveFrom: '2026-10-04',
});

/**
 * Phase 10 Batch 3: every pay period has its Time-owned TimePeriod, and Payroll asks Time to
 * materialize the timesheets of exactly the employees the pay group will pay — idempotently,
 * never touching finalized time.
 */
describe('Payroll time orchestration (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, PAYROLL_USERS);
          const svc = payrollServices(
            rollbackClient(tx),
            new FixedPayrollClock(),
          );
          await run({ tx, fx, svc, admin: ctx(fx.users.payrollAdmin!) });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('creates each pay period with the TimePeriod of exactly its dates, shared across pay groups', async () => {
    await scenario(async ({ tx, fx, svc, admin }) => {
      // Time already has a period for the first dates: it is reused, not duplicated.
      const existing = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: d('2026-10-04'),
          endDate: d('2026-10-17'),
          status: 'OPEN',
          openedAt: new Date(),
        },
      });
      const groupA = await payGroup(tx, fx.orgA, `PG-A-${fx.suffix}`);
      const groupB = await payGroup(tx, fx.orgA, `PG-B-${fx.suffix}`);
      for (const group of [groupA, groupB]) {
        await svc.calendars.createCalendar(calendar(group.id), admin);
        await svc.calendars.generatePeriods(
          { payGroupId: group.id, throughDate: '2026-10-31' },
          admin,
        );
      }
      const periods = await tx.payrollPeriod.findMany({
        where: { payGroupId: { in: [groupA.id, groupB.id] } },
        include: { timePeriod: true },
        orderBy: [{ periodStart: 'asc' }, { payGroupId: 'asc' }],
      });
      expect(periods).toHaveLength(4);
      for (const period of periods) {
        expect(period.timePeriod).toMatchObject({
          organizationId: fx.orgA,
          startDate: period.periodStart,
          endDate: period.periodEnd,
          status: 'OPEN',
        });
      }
      expect(periods[0]!.timePeriodId).toBe(existing.id);
      expect(periods[1]!.timePeriodId).toBe(existing.id);
      expect(periods[2]!.timePeriodId).toBe(periods[3]!.timePeriodId);
      expect(
        await tx.timePeriod.count({ where: { organizationId: fx.orgA } }),
      ).toBe(2);
      // The database refuses a pay period pointing at a TimePeriod of other dates.
      const error = await violation(tx, () =>
        tx.payrollPeriod.update({
          where: { id: periods[2]!.id },
          data: { timePeriodId: existing.id },
        }),
      );
      expect(String(error)).toMatch(/foreign key|PayrollPeriod_timePeriodId/i);
    });
  });

  it('materializes timesheets for the pay group employees only, idempotently, never touching final time', async () => {
    await scenario(async ({ tx, fx, svc, admin }) => {
      const group = await payGroup(tx, fx.orgA, `PG-${fx.suffix}`);
      // Employee 1 is in the pay group; employee 2 is paid elsewhere.
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '24.5',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
          payGroupId: group.id,
        },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.otherTeamA,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '20',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
        },
      });
      await svc.calendars.createCalendar(calendar(group.id), admin);
      await svc.calendars.generatePeriods(
        { payGroupId: group.id, throughDate: '2026-10-04' },
        admin,
      );
      const period = await tx.payrollPeriod.findFirstOrThrow({
        where: { payGroupId: group.id },
      });
      const first = await svc.timeOrchestration.materialize(period.id, admin);
      expect(first).toMatchObject({ employees: 1, created: 1, failed: [] });
      const sheet = await tx.timesheet.findUniqueOrThrow({
        where: {
          employeeId_timePeriodId: {
            employeeId: fx.employee1,
            timePeriodId: period.timePeriodId,
          },
        },
      });
      expect(sheet.status).toBe('OPEN');
      expect(
        await tx.timesheet.count({
          where: {
            employeeId: fx.employee2,
            timePeriodId: period.timePeriodId,
          },
        }),
      ).toBe(0);
      expect(
        (await tx.payrollPeriod.findUniqueOrThrow({ where: { id: period.id } }))
          .timesheetsMaterializedAt,
      ).not.toBeNull();
      // Finalized time is never touched by a retry.
      await tx.timesheet.update({
        where: { id: sheet.id },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedByUserId: fx.users.payrollAdmin!,
          totals: { frozen: true },
        },
      });
      const again = await svc.timeOrchestration.materialize(period.id, admin);
      expect(again).toMatchObject({ employees: 1, created: 0, failed: [] });
      expect(
        await tx.timesheet.findUniqueOrThrow({ where: { id: sheet.id } }),
      ).toMatchObject({
        status: 'APPROVED',
        totals: { frozen: true },
        version: 1,
      });
      expect(
        await tx.auditLog.count({
          where: {
            action: 'PAYROLL_TIMESHEETS_MATERIALIZED',
            entityId: period.id,
          },
        }),
      ).toBe(2);
      // Only payroll managers of the organization may ask for it.
      await expect(
        svc.timeOrchestration.materialize(
          period.id,
          ctx(fx.users.payrollReader!),
        ),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it('prepares upcoming periods and materializes open ones in the background, idempotently', async () => {
    await scenario(async ({ tx, fx, svc, admin }) => {
      const group = await payGroup(tx, fx.orgA, `PG-JOB-${fx.suffix}`);
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'SALARY',
          rateAmount: '52000',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
          payGroupId: group.id,
        },
      });
      await svc.calendars.createCalendar(calendar(group.id), admin);
      const clock = new FixedPayrollClock();
      const client = rollbackClient(tx);
      const mine = (
        outcome: Awaited<ReturnType<typeof preparePayrollPeriods>>,
      ) => outcome.failed.filter((failure) => failure.payGroupId === group.id);
      const first = await preparePayrollPeriods(client, clock);
      expect(mine(first)).toEqual([]);
      const periods = await tx.payrollPeriod.findMany({
        where: { payGroupId: group.id },
        orderBy: { periodStart: 'asc' },
      });
      // 2026-11-01 + 62 days = 2027-01-02: periods starting through then exist.
      expect(
        periods.map((p) => p.periodStart.toISOString().slice(0, 10)),
      ).toEqual([
        '2026-10-04',
        '2026-10-18',
        '2026-11-01',
        '2026-11-15',
        '2026-11-29',
        '2026-12-13',
        '2026-12-27',
      ]);
      // Started periods have their timesheets; future ones do not yet.
      const sheets = await tx.timesheet.findMany({
        where: {
          employeeId: fx.employee1,
          timePeriodId: { in: periods.map((p) => p.timePeriodId) },
        },
      });
      expect(sheets.map((sheet) => sheet.timePeriodId).sort()).toEqual(
        periods
          .filter((p) => p.status === 'OPEN')
          .map((p) => p.timePeriodId)
          .sort(),
      );
      const second = await preparePayrollPeriods(client, clock);
      expect(mine(second)).toEqual([]);
      expect(
        await tx.payrollPeriod.count({ where: { payGroupId: group.id } }),
      ).toBe(7);
      // Preparation never creates runs or anything financial.
      expect(
        await tx.payrollRun.count({ where: { payGroupId: group.id } }),
      ).toBe(0);
    });
  });
});
