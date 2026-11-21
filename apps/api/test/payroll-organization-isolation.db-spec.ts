import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  d,
  FixedPayrollClock,
  PAYROLL_PERMISSION_KEYS,
  payGroup,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  afterPeriodEnd,
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
} from './support/time-fixtures.js';
import { addOrganizationBAssignment } from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** The SELECT statements of the 4B historical checks, in file order (checks 1 to 6). */
const HISTORICAL_CHECKS = readFileSync(
  new URL(
    '../../../docs/security/sql/batch-4b-organization-isolation-checks.sql',
    import.meta.url,
  ),
  'utf8',
)
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.startsWith('SELECT'));

const USERS = {
  self1: [
    { permissions: ['time.clock'], scope: 'org' as const },
    { permissions: ['time.clock'], scope: 'orgB' as const },
  ],
  managerAB: [
    { permissions: TIME_PERMISSIONS, scope: 'org' as const },
    { permissions: TIME_PERMISSIONS, scope: 'orgB' as const },
  ],
  payrollB: [{ permissions: PAYROLL_PERMISSION_KEYS, scope: 'orgB' as const }],
  approverB: [
    {
      permissions: ['payroll.read', 'payroll.approve'],
      scope: 'orgB' as const,
    },
  ],
  finalizerB: [
    {
      permissions: ['payroll.read', 'payroll.finalize'],
      scope: 'orgB' as const,
    },
  ],
};

/**
 * Batch 4B (R4, D3) — payroll and timesheets of an employee working in two organizations.
 *
 * Organization B pays the employee's B time from B's own timesheet and finalizes the run. A
 * timesheet of Organization A written before 4B also carries a segment of the B assignment (the
 * refresh used to read every organization's entries): it is never deleted or recalculated, but
 * it takes no part in anything. Reopening A's timesheet records no retro requirement against
 * B's run (R4), leaves the B segment as it was, and B's finalized run and claims never change.
 */
describe('Payroll and timesheet organization isolation (Batch 4B, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('never names another organization’s finalized run when a legacy mixed timesheet is reopened, and leaves its history unchanged', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          return body(tx).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
    async function body(tx: Tx) {
      const fx = await createSchedulingFixtures(tx, USERS, [
        ...TIME_PERMISSIONS,
      ]);
      await seedTimePolicy(tx, fx.orgA);
      const orgB = await addOrganizationBAssignment(tx, fx);
      const clock = new FixedClock();
      const client = rollbackClient(tx);
      const time = timeServices(client, clock).time;
      const payroll = payrollServices(client, new FixedPayrollClock());
      const manager = fx.users.managerAB!;
      const payrollB = ctx(fx.users.payrollB!);

      // Organization B pays the B assignment hourly, bi-weekly from 2026-10-04.
      const group = await payGroup(tx, fx.orgB, `PGB-${fx.suffix}`);
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: orgB.assignmentId,
          organizationId: fx.orgB,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '30',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
          payGroupId: group.id,
        },
      });
      await payroll.calendars.createCalendar(
        {
          payGroupId: group.id,
          cadence: 'BIWEEKLY',
          timezone: 'America/Toronto',
          anchorDate: '2026-10-04',
          payDateOffsetDays: 5,
          processingCutoffOffsetDays: 2,
          effectiveFrom: '2026-10-04',
        },
        payrollB,
      );
      await payroll.calendars.generatePeriods(
        { payGroupId: group.id, throughDate: '2026-10-04' },
        payrollB,
      );
      const periodB = await tx.payrollPeriod.findFirstOrThrow({
        where: { payGroupId: group.id },
      });

      // Work: A on Monday Oct 5 (Team A), B on Tuesday Oct 6, 09:00–17:00 EDT each.
      const work = async (assignmentId: string, date: string) => {
        clock.value = new Date(`${date}T13:00:00.000Z`);
        await time.clockIn(fx.selfUser1, assignmentId, ctx(fx.selfUser1));
        clock.value = new Date(`${date}T21:00:00.000Z`);
        await time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
      };
      await work(fx.assignmentTeamA, '2026-10-05');
      await work(orgB.assignmentId, '2026-10-06');
      const approve = async (sheetId: string) => {
        await time.submitTimesheet(fx.selfUser1, sheetId, ctx(fx.selfUser1));
        for (const segment of await tx.timesheetSegment.findMany({
          where: { timesheetId: sheetId },
        })) {
          await time.approveTimesheetSegment(
            manager,
            segment.id,
            undefined,
            ctx(manager),
          );
        }
      };

      // B's timesheet (B's time period) holds B's time only; B's run pays it and is finalized.
      await payroll.timeOrchestration.materialize(periodB.id, payrollB);
      const sheetB = await tx.timesheet.findFirstOrThrow({
        where: {
          employeeId: fx.employee1,
          timePeriodId: periodB.timePeriodId!,
        },
        include: { segments: true },
      });
      expect(
        sheetB.segments.map((segment) => segment.employmentAssignmentId),
      ).toEqual([orgB.assignmentId]);
      afterPeriodEnd(clock, periodB.periodEnd);
      await approve(sheetB.id);
      const run = await payroll.runs.createRun(
        { payrollPeriodId: periodB.id, currency: 'CAD' },
        payrollB,
      );
      await payroll.runs.calculate(run.id, payrollB);
      await payroll.lifecycle.approve(run.id, ctx(fx.users.approverB!));
      await payroll.lifecycle.finalize(run.id, ctx(fx.users.finalizerB!));
      const frozen = async () => ({
        run: await tx.payrollRun.findUniqueOrThrow({
          where: { id: run.id },
          select: {
            status: true,
            grossAmount: true,
            sourceFingerprint: true,
          },
        }),
        claims: await tx.payrollSourceClaim.findMany({
          where: { payrollRunId: run.id },
          orderBy: [{ workDate: 'asc' }, { kind: 'asc' }],
        }),
        snapshots: await tx.payrollTimeSnapshot.findMany({
          where: { payrollRunId: run.id },
          orderBy: { id: 'asc' },
        }),
      });
      const before = await frozen();
      expect(before.run.status).toBe('FINALIZED');
      expect(
        before.claims.map((claim) => [
          claim.kind,
          claim.employmentAssignmentId,
          claim.workDate.toISOString().slice(0, 10),
        ]),
      ).toEqual([['WORKED_TIME', orgB.assignmentId, '2026-10-06']]);

      // Organization A's weekly timesheet (Oct 4–10), approved with A's time only...
      await time.generateTimePeriods(
        manager,
        {
          organizationId: fx.orgA,
          startDate: '2026-10-04',
          cadence: 'WEEKLY',
        },
        ctx(manager),
      );
      const periodA = await tx.timePeriod.findFirstOrThrow({
        where: { organizationId: fx.orgA, startDate: d('2026-10-04') },
      });
      const sheetA = await time.materializeTimesheetForEmployeePeriod(
        fx.employee1,
        periodA.id,
      );
      await approve(sheetA.id);
      // ...then given what the pre-4B refresh wrote: an approved segment of the B assignment.
      const legacy = await tx.timesheetSegment.create({
        data: {
          timesheetId: sheetA.id,
          employmentAssignmentId: orgB.assignmentId,
          status: 'APPROVED',
          reviewedByUserId: manager,
          reviewedAt: new Date('2026-10-12T14:00:00.000Z'),
          grossMinutes: 480,
          netWorkedMinutes: 480,
          approvedWorkedMinutes: 480,
        },
      });
      // The read-only historical checks find exactly this timesheet (checks 1 and 2).
      expect(HISTORICAL_CHECKS).toHaveLength(6);
      const check = (index: number) =>
        tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          HISTORICAL_CHECKS[index]!,
        );
      expect(
        (await check(0)).filter((row) => row.timesheet_id === sheetA.id),
      ).toEqual([
        expect.objectContaining({
          segment_id: legacy.id,
          segment_organization: fx.orgB,
          period_organization: fx.orgA,
        }),
      ]);
      expect(
        (await check(1)).filter((row) => row.timesheet_id === sheetA.id),
      ).toEqual([expect.objectContaining({ foreign_segments: 1n })]);
      const storedTotals = (
        await tx.timesheet.findUniqueOrThrow({ where: { id: sheetA.id } })
      ).totals;

      // Readers never see the B segment or its minutes; the stored snapshot is unchanged.
      const shown = (await time.selfTimesheet(
        fx.selfUser1,
        sheetA.id,
      )) as unknown as {
        segments: Array<{ employmentAssignmentId: string }>;
        totals: Record<string, unknown>;
      };
      expect(shown.segments.map((s) => s.employmentAssignmentId)).toEqual([
        fx.assignmentTeamA,
      ]);
      expect(shown.totals).toMatchObject({
        netWorkedMinutes: 480,
        limitedToShownSegments: true,
      });
      expect(
        (await time.payrollTimesheet({
          employeeId: fx.employee1,
          timePeriodId: periodA.id,
        }))!.segments.map((segment) => segment.employmentAssignmentId),
      ).toEqual([fx.assignmentTeamA]);

      // R4: reopening A's timesheet names no finalized run (B's run never paid from it).
      clock.value = new Date('2026-10-25T14:00:00.000Z');
      const reopened = (await time.reopenTimesheet(
        manager,
        sheetA.id,
        'Review Monday',
        ctx(manager),
      )) as { retroAdjustment: { finalizedPayrollRunIds: string[] } };
      expect(reopened.retroAdjustment.finalizedPayrollRunIds).toEqual([]);
      // No requirement names another organization's run (check 4 finds none for this sheet).
      expect(
        (await check(3)).filter((row) => row.timesheetId === sheetA.id),
      ).toEqual([]);
      expect(
        await tx.payrollRetroRequirement.count({
          where: { timesheetId: sheetA.id },
        }),
      ).toBe(0);
      // The legacy B segment is left exactly as it was (never deleted or recalculated)...
      expect(
        await tx.timesheetSegment.findUniqueOrThrow({
          where: { id: legacy.id },
        }),
      ).toEqual(legacy);
      // ...A's own segment reopened, and B's run, claims and snapshots never changed.
      expect(
        (
          await tx.timesheetSegment.findMany({
            where: { timesheetId: sheetA.id },
            select: { employmentAssignmentId: true, status: true },
            orderBy: { createdAt: 'asc' },
          })
        ).find((s) => s.employmentAssignmentId === fx.assignmentTeamA),
      ).toMatchObject({ status: 'PENDING' });
      expect(await frozen()).toEqual(before);
      expect(storedTotals).not.toBeNull();

      // Batch 4E-3 (C3): the review-before-submit guard compares what the employee is shown (the
      // period organization's segments), never the legacy mixed totals: as shown, it is never
      // refused as changed (it may still be refused for other reasons, such as the period).
      const view = (await time.selfTimesheet(
        fx.selfUser1,
        sheetA.id,
      )) as unknown as {
        version: number;
        totals: { netWorkedMinutes: number };
      };
      const attempt = await time
        .submitTimesheet(fx.selfUser1, sheetA.id, ctx(fx.selfUser1), {
          expectedNetWorkedMinutes: view.totals.netWorkedMinutes,
          expectedVersion: view.version,
        })
        .then(
          () => null,
          (error: unknown) =>
            (error as { getResponse?: () => { code?: string } }).getResponse?.()
              ?.code ?? 'UNKNOWN',
        );
      expect(attempt).not.toBe('TIMESHEET_TOTALS_CHANGED');
      throw new RollbackFixtures();
    }
  });
});
