import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  payGroupA: string;
  payGroupB: string;
  calendarA: string;
  timePeriodA: string;
}

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const identity = { employeeNumber: 'E-1', displayName: 'Employee' };
const snapshotOf = (fx: SchedulingFixtures) => ({
  organizationId: fx.orgA,
  positionId: fx.positionTeamA,
  positionName: 'Position',
  employmentType: 'FULL_TIME' as const,
  assignmentStatus: 'ACTIVE' as const,
  assignmentStartDate: d('2026-01-01'),
});
/** The database's own words, so each case proves which constraint refused it. */
const rejected = async (tx: Tx, run: () => Promise<unknown>) => {
  const error = await violation(tx, run);
  return `${String(error)} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}`;
};

/**
 * Phase 10 Batch 1: the payroll foundation's structural integrity lives in the database, so
 * later workflows (and anything outside them) cannot create cross-organization, cross-pay-group
 * or cross-employee payroll records, malformed periods or runs, or rewrite a final run.
 */
describe('Payroll foundation (database)', () => {
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
          const fx = await createSchedulingFixtures(tx, {}, []);
          const payGroup = (organizationId: string, code: string) =>
            tx.payGroup.create({
              data: { organizationId, code, name: code },
            });
          const payGroupA = (await payGroup(fx.orgA, `PG-A-${fx.suffix}`)).id;
          const payGroupB = (await payGroup(fx.orgB, `PG-B-${fx.suffix}`)).id;
          const calendarA = (
            await tx.payrollCalendar.create({
              data: {
                organizationId: fx.orgA,
                payGroupId: payGroupA,
                cadence: 'BIWEEKLY',
                timezone: 'America/Toronto',
                anchorDate: d('2026-11-01'),
                payDateOffsetDays: 6,
                processingCutoffOffsetDays: 3,
                effectiveFrom: d('2026-11-01'),
              },
            })
          ).id;
          const timePeriodA = (
            await tx.timePeriod.create({
              data: {
                organizationId: fx.orgA,
                startDate: d('2026-11-01'),
                endDate: d('2026-11-14'),
                status: 'OPEN',
                openedAt: new Date(),
              },
            })
          ).id;
          await run({ tx, fx, payGroupA, payGroupB, calendarA, timePeriodA });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const periodData = (h: Harness, extra: Record<string, unknown> = {}) => ({
    organizationId: h.fx.orgA,
    payGroupId: h.payGroupA,
    payrollCalendarId: h.calendarA,
    periodStart: d('2026-11-01'),
    periodEnd: d('2026-11-14'),
    payDate: d('2026-11-20'),
    processingCutoffAt: new Date('2026-11-17T22:00:00.000Z'),
    timezone: 'America/Toronto',
    timePeriodId: h.timePeriodA,
    ...extra,
  });

  it('keeps calendars and periods inside their pay group and organization', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      // A calendar of org A cannot use org B's pay group.
      expect(
        await rejected(tx, () =>
          tx.payrollCalendar.create({
            data: {
              organizationId: fx.orgA,
              payGroupId: h.payGroupB,
              cadence: 'MONTHLY',
              timezone: 'America/Toronto',
              anchorDate: d('2026-11-01'),
              payDateOffsetDays: 0,
              processingCutoffOffsetDays: 2,
              effectiveFrom: d('2026-11-01'),
            },
          }),
        ),
      ).toMatch(/PayrollCalendar_payGroupId_organizationId_fkey/);
      // Nor can a period of pay group B use pay group A's calendar.
      expect(
        await rejected(tx, () =>
          tx.payrollPeriod.create({
            data: periodData(h, {
              organizationId: fx.orgB,
              payGroupId: h.payGroupB,
            }),
          }),
        ),
      ).toMatch(/PayrollPeriod_payrollCalendarId_payGroupId_fkey/);
      const period = await tx.payrollPeriod.create({ data: periodData(h) });
      expect(period.status).toBe('UPCOMING');
      // Exact duplicates of a period start or end in the pay group are refused.
      expect(
        await rejected(tx, () =>
          tx.payrollPeriod.create({
            data: periodData(h, { periodEnd: d('2026-11-07') }),
          }),
        ),
      ).toMatch(/PayrollPeriod_payGroupId_periodStart_key|Unique constraint/);
    });
  });

  it('refuses malformed calendars and periods', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const calendar = (extra: Record<string, unknown>) =>
        tx.payrollCalendar.create({
          data: {
            organizationId: fx.orgA,
            payGroupId: h.payGroupA,
            cadence: 'BIWEEKLY',
            timezone: 'America/Toronto',
            anchorDate: d('2027-01-01'),
            payDateOffsetDays: 6,
            processingCutoffOffsetDays: 3,
            effectiveFrom: d('2027-01-01'),
            ...extra,
          },
        });
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ timezone: '  ' }, /PayrollCalendar_timezone_check/],
        [
          { effectiveTo: d('2026-12-31') },
          /PayrollCalendar_effective_period_check/,
        ],
        [{ payDateOffsetDays: 61 }, /PayrollCalendar_pay_date_offset_check/],
        [
          { processingCutoffOffsetDays: -1 },
          /PayrollCalendar_cutoff_offset_check/,
        ],
        [
          { cadence: 'SEMIMONTHLY', anchorDate: d('2027-01-02') },
          /PayrollCalendar_anchor_check/,
        ],
        [
          { cadence: 'MONTHLY', anchorDate: d('2027-01-29') },
          /PayrollCalendar_anchor_check/,
        ],
      ];
      for (const [extra, constraint] of cases) {
        expect(await rejected(tx, () => calendar(extra))).toMatch(constraint);
      }
      const periodCases: Array<[Record<string, unknown>, RegExp]> = [
        [
          { periodStart: d('2026-11-15'), periodEnd: d('2026-11-14') },
          /PayrollPeriod_dates_check/,
        ],
        [
          { periodEnd: d('2026-12-02'), payDate: d('2026-12-05') },
          /PayrollPeriod_length_check/,
        ],
        [{ payDate: d('2026-10-31') }, /PayrollPeriod_pay_date_check/],
        [{ timezone: '' }, /PayrollPeriod_timezone_check/],
      ];
      for (const [extra, constraint] of periodCases) {
        expect(
          await rejected(tx, () =>
            tx.payrollPeriod.create({ data: periodData(h, extra) }),
          ),
        ).toMatch(constraint);
      }
    });
  });

  it('keeps one live run per period and currency, with a lifecycle that matches its status', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const period = await tx.payrollPeriod.create({ data: periodData(h) });
      const runData = (extra: Record<string, unknown> = {}) => ({
        organizationId: fx.orgA,
        payGroupId: h.payGroupA,
        payrollPeriodId: period.id,
        currency: 'CAD',
        createdByUserId: fx.selfUser1,
        ...extra,
      });
      // A run's period must be of its own pay group and organization.
      expect(
        await rejected(tx, () =>
          tx.payrollRun.create({
            data: runData({ organizationId: fx.orgB, payGroupId: h.payGroupB }),
          }),
        ),
      ).toMatch(/PayrollRun_payrollPeriodId_organizationId_payGroupId_fkey/);
      expect(
        await rejected(tx, () =>
          tx.payrollRun.create({ data: runData({ currency: 'cad' }) }),
        ),
      ).toMatch(/PayrollRun_currency_check/);
      // Status and lifecycle columns must agree.
      const shapeCases: Array<[Record<string, unknown>, RegExp]> = [
        [{ status: 'CALCULATED' }, /PayrollRun_calculation_shape_check/],
        [
          {
            status: 'APPROVED',
            calculatedAt: new Date(),
            calculationVersion: 'v1',
            sourceFingerprint: 'f',
          },
          /PayrollRun_approval_shape_check/,
        ],
        [{ finalizedAt: new Date() }, /PayrollRun_finalization_shape_check/],
        [
          {
            status: 'VOIDED',
            voidedAt: new Date(),
            voidedByUserId: fx.selfUser1,
          },
          /PayrollRun_void_shape_check/,
        ],
        [
          {
            status: 'VOIDED',
            voidedAt: new Date(),
            voidedByUserId: fx.selfUser1,
            voidReason: ' ',
          },
          /PayrollRun_text_check/,
        ],
      ];
      for (const [extra, constraint] of shapeCases) {
        expect(
          await rejected(tx, () =>
            tx.payrollRun.create({ data: runData(extra) }),
          ),
        ).toMatch(constraint);
      }

      const first = await tx.payrollRun.create({ data: runData() });
      expect(first.status).toBe('DRAFT');
      // A second live CAD run of the period is refused; another currency is a separate run.
      expect(
        await rejected(tx, () => tx.payrollRun.create({ data: runData() })),
      ).toMatch(
        /PayrollRun_one_live_per_period_currency_key|Unique constraint/,
      );
      await tx.payrollRun.create({ data: runData({ currency: 'USD' }) });
      // Voiding frees the slot; the voided run is then final.
      await tx.payrollRun.update({
        where: { id: first.id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedByUserId: fx.selfUser1,
          voidReason: 'Created against the wrong period',
        },
      });
      const second = await tx.payrollRun.create({ data: runData() });
      expect(
        await rejected(tx, () =>
          tx.payrollRun.update({
            where: { id: first.id },
            data: { voidReason: 'Rewritten' },
          }),
        ),
      ).toMatch(/voided payroll run is final/);
      expect(
        await rejected(tx, () =>
          tx.payrollRun.delete({ where: { id: first.id } }),
        ),
      ).toMatch(/voided payroll run is final/);
      // Any run keeps its identity; a finalized run is never changed or deleted.
      expect(
        await rejected(tx, () =>
          tx.payrollRun.update({
            where: { id: second.id },
            data: { currency: 'USD' },
          }),
        ),
      ).toMatch(/keeps the period, pay group, currency and creator/);
      const now = new Date();
      await tx.payrollRun.update({
        where: { id: second.id },
        data: {
          status: 'FINALIZED',
          calculatedAt: now,
          calculationVersion: 'v1',
          sourceFingerprint: 'sha256:abc',
          approvedAt: now,
          approvedByUserId: fx.selfUser1,
          finalizedAt: now,
          finalizedByUserId: fx.selfUser2,
          grossAmount: '0.00',
          deductionAmount: '0.00',
          employerContributionAmount: '0.00',
        },
      });
      expect(
        await rejected(tx, () =>
          tx.payrollRun.update({
            where: { id: second.id },
            data: { sourceFingerprint: 'sha256:changed' },
          }),
        ),
      ).toMatch(/finalized payroll run is final/);
    });
  });

  it('keeps run employees, assignments and issues within their run and employee', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const period = await tx.payrollPeriod.create({ data: periodData(h) });
      const run = (currency: string) =>
        tx.payrollRun.create({
          data: {
            organizationId: fx.orgA,
            payGroupId: h.payGroupA,
            payrollPeriodId: period.id,
            currency,
            createdByUserId: fx.selfUser1,
          },
        });
      const runA = await run('CAD');
      const runB = await run('USD');
      const employee1 = await tx.payrollRunEmployee.create({
        data: { payrollRunId: runA.id, employeeId: fx.employee1, ...identity },
      });
      const employee2 = await tx.payrollRunEmployee.create({
        data: { payrollRunId: runA.id, employeeId: fx.employee2, ...identity },
      });
      expect(
        await rejected(tx, () =>
          tx.payrollRunEmployee.create({
            data: {
              payrollRunId: runA.id,
              employeeId: fx.employee1,
              ...identity,
            },
          }),
        ),
      ).toMatch(
        /PayrollRunEmployee_payrollRunId_employeeId_key|Unique constraint/,
      );
      const assignment = await tx.payrollRunAssignment.create({
        data: {
          payrollRunId: runA.id,
          payrollRunEmployeeId: employee1.id,
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          ...snapshotOf(fx),
        },
      });
      // Another employee's assignment, or one filed under another run, is refused.
      expect(
        await rejected(tx, () =>
          tx.payrollRunAssignment.create({
            data: {
              payrollRunId: runA.id,
              payrollRunEmployeeId: employee1.id,
              employeeId: fx.employee1,
              employmentAssignmentId: fx.otherTeamA,
              ...snapshotOf(fx),
            },
          }),
        ),
      ).toMatch(/PayrollRunAssignment_employmentAssignmentId_employeeId_fkey/);
      expect(
        await rejected(tx, () =>
          tx.payrollRunAssignment.create({
            data: {
              payrollRunId: runB.id,
              payrollRunEmployeeId: employee1.id,
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentDeptB,
              ...snapshotOf(fx),
            },
          }),
        ),
      ).toMatch(
        /PayrollRunAssignment_payrollRunEmployeeId_payrollRunId_employeeId_fkey|PayrollRunAssignment_payrollRunEmployeeId_payrollRunId_emp/,
      );

      // Issues: run, employee and assignment level, each provably within the run.
      await tx.payrollValidationIssue.createMany({
        data: [
          {
            payrollRunId: runA.id,
            severity: 'WARNING',
            code: 'STALE_SOURCE_DATA',
            message: 'Source data changed after calculation.',
          },
          {
            payrollRunId: runA.id,
            payrollRunEmployeeId: employee1.id,
            payrollRunAssignmentId: assignment.id,
            severity: 'ERROR',
            code: 'MISSING_COMPENSATION',
            message: 'No compensation covers the period.',
            metadata: { employmentAssignmentId: fx.assignmentTeamA },
          },
        ],
      });
      const issue = (extra: Record<string, unknown>) =>
        tx.payrollValidationIssue.create({
          data: {
            payrollRunId: runA.id,
            severity: 'ERROR',
            code: 'MISSING_COMPENSATION',
            message: 'No compensation covers the period.',
            ...extra,
          },
        });
      const issueCases: Array<[Record<string, unknown>, RegExp]> = [
        [{ code: 'missing compensation' }, /PayrollValidationIssue_code_check/],
        [{ message: ' ' }, /PayrollValidationIssue_message_check/],
        [
          { payrollRunAssignmentId: assignment.id },
          /PayrollValidationIssue_subject_check/,
        ],
        // The assignment belongs to employee 1, not employee 2.
        [
          {
            payrollRunEmployeeId: employee2.id,
            payrollRunAssignmentId: assignment.id,
          },
          /PayrollValidationIssue_payrollRunAssignmentId_payrollRunEm_fkey/,
        ],
        // An employee of run A cannot carry an issue of run B.
        [
          { payrollRunId: runB.id, payrollRunEmployeeId: employee1.id },
          /PayrollValidationIssue_payrollRunEmployeeId_payrollRunId_fkey/,
        ],
      ];
      for (const [extra, constraint] of issueCases) {
        expect(await rejected(tx, () => issue(extra))).toMatch(constraint);
      }
      expect(
        await tx.payrollValidationIssue.count({
          where: { payrollRunId: runA.id },
        }),
      ).toBe(2);
    });
  });
});
