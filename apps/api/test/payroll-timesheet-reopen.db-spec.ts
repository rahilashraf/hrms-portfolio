import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  FixedPayrollClock,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  issueCodes,
  PAYROLL_WORLD_USERS,
  world,
  type World,
} from './support/payroll-world.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
} from './support/scheduling-fixtures.js';
import {
  afterPeriodEnd,
  FixedClock,
  seedTimePolicy,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/**
 * Batch 4A — reopening time a FINALIZED payroll run already paid. The finalized run and its
 * claims never change; the reopen needs time.timesheet.manage and a reason, is audited, names
 * every finalized run that claimed the time (not only the latest) and records a retro
 * requirement for it; the corrected time is never paid again by a later run, which instead warns
 * PRIOR_PERIOD_SOURCE_CHANGED against the run that paid it.
 */
describe('Reopening timesheets paid by finalized payroll (Batch 4A, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (w: World) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, PAYROLL_WORLD_USERS);
          const svc = payrollServices(
            rollbackClient(tx),
            new FixedPayrollClock(),
          );
          await run(await world(tx, fx, svc)).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('names every finalized run that paid the reopened time, never changes them, and never pays the time twice', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin, payGroupId } = w;
      await seedTimePolicy(tx, fx.orgA);
      const clock = new FixedClock();
      const time = timeServices(rollbackClient(tx), clock).time;
      const hr = fx.users.hr!;
      await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-11-14' },
        admin,
      );
      const periods = await tx.payrollPeriod.findMany({
        where: { payGroupId },
        orderBy: { periodStart: 'asc' },
      });
      expect(periods).toHaveLength(3);

      /** Employee 1 (hourly) works 09:00–17:00 EDT on `date`; their timesheet is approved. */
      const approveWork = async (
        period: (typeof periods)[number],
        date: string,
      ) => {
        clock.value = new Date(`${date}T13:00:00.000Z`);
        await time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
        clock.value = new Date(`${date}T21:00:00.000Z`);
        await time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
        await svc.timeOrchestration.materialize(period.id, admin);
        const sheet = await tx.timesheet.findFirstOrThrow({
          where: {
            employeeId: fx.employee1,
            timePeriodId: period.timePeriodId,
          },
          include: { segments: true },
        });
        afterPeriodEnd(clock, period.periodEnd);
        await time.submitTimesheet(fx.selfUser1, sheet.id, ctx(fx.selfUser1));
        for (const segment of sheet.segments) {
          await time.approveTimesheetSegment(
            hr,
            segment.id,
            undefined,
            ctx(hr),
          );
        }
        return sheet.id;
      };
      const finalizeRun = async (period: (typeof periods)[number]) => {
        const run = await svc.runs.createRun(
          { payrollPeriodId: period.id, currency: 'CAD' },
          admin,
        );
        await svc.runs.calculate(run.id, admin);
        await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
        await svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!));
        return run.id;
      };

      const firstSheet = await approveWork(periods[0]!, '2026-10-05');
      const run1 = await finalizeRun(periods[0]!);
      await approveWork(periods[1]!, '2026-10-19');
      const run2 = await finalizeRun(periods[1]!);
      const snapshot = async (runId: string) => ({
        run: await tx.payrollRun.findUniqueOrThrow({
          where: { id: runId },
          select: { status: true, grossAmount: true, sourceFingerprint: true },
        }),
        claims: await tx.payrollSourceClaim.findMany({
          where: { payrollRunId: runId },
          select: { kind: true, workDate: true, employmentAssignmentId: true },
          orderBy: [{ workDate: 'asc' }, { kind: 'asc' }],
        }),
        lines: await tx.payrollEarningLine.count({
          where: { payrollRunId: runId },
        }),
      });
      const run1Before = await snapshot(run1);
      expect(run1Before.run.status).toBe('FINALIZED');
      expect(
        run1Before.claims.some(
          (claim) =>
            claim.kind === 'WORKED_TIME' &&
            claim.workDate.toISOString().startsWith('2026-10-05'),
        ),
      ).toBe(true);

      // A reason is mandatory.
      await expect(
        time.reopenTimesheet(hr, firstSheet, ' ', ctx(hr)),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'TIMESHEET_REASON_REQUIRED',
        }),
      });
      const reopened = await time.reopenTimesheet(
        hr,
        firstSheet,
        'Missed overtime on Oct 6',
        ctx(hr),
      );
      expect(reopened).toMatchObject({
        status: 'OPEN',
        version: 2,
        retroAdjustment: { required: true, finalizedPayrollRunIds: [run1] },
      });
      expect(
        await tx.payrollRetroRequirement.findMany({
          where: { timesheetId: firstSheet },
        }),
      ).toEqual([
        expect.objectContaining({
          payrollRunId: run1,
          employmentAssignmentId: fx.assignmentTeamA,
          timesheetVersion: 1,
          firstWorkDate: new Date('2026-10-05T00:00:00.000Z'),
          lastWorkDate: new Date('2026-10-05T00:00:00.000Z'),
          reason: 'Missed overtime on Oct 6',
          createdByUserId: hr,
        }),
      ]);
      expect(
        await tx.auditLog.findFirstOrThrow({
          where: { entityId: firstSheet, action: 'TIMESHEET_REOPENED' },
        }),
      ).toMatchObject({
        metadata: expect.objectContaining({
          retroAdjustmentRequired: true,
          finalizedPayrollRunIds: [run1],
        }),
      });
      // The finalized run, its claims and lines are exactly as they were.
      expect(await snapshot(run1)).toEqual(run1Before);

      // Correct the reopened period and approve it again (version 2).
      clock.value = new Date('2026-10-20T13:00:00.000Z');
      await time.addEntry(
        hr,
        fx.employee1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          startAt: '2026-10-06T17:00',
          endAt: '2026-10-06T19:00',
          reason: 'Missed overtime',
        },
        ctx(hr),
      );
      await time.submitTimesheet(fx.selfUser1, firstSheet, ctx(fx.selfUser1));
      for (const segment of await tx.timesheetSegment.findMany({
        where: { timesheetId: firstSheet },
      })) {
        await time.approveTimesheetSegment(hr, segment.id, undefined, ctx(hr));
      }
      expect(
        (await time.approvedPayrollTimeOutputs(firstSheet)).workDateOutputs
          .map((o) => [o.workDate, o.approvedWorkedMinutes, o.timesheetVersion])
          .sort((a, b) => String(a).localeCompare(String(b))),
      ).toEqual([
        ['2026-10-05', 480, 2],
        ['2026-10-06', 120, 2],
      ]);
      expect(await snapshot(run1)).toEqual(run1Before);

      // The next run (period 3): run 2 is the latest finalized run and its sources did not
      // change, yet the warning names run 1, the run that paid the reopened time. Nothing of
      // period 1 is claimed (paid) again.
      await approveWork(periods[2]!, '2026-11-02');
      const run3 = await svc.runs.createRun(
        { payrollPeriodId: periods[2]!.id, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run3.id, admin);
      expect(await issueCodes(tx, run3.id, fx.employee1)).toContain(
        'WARNING:PRIOR_PERIOD_SOURCE_CHANGED',
      );
      const warnings = await tx.payrollValidationIssue.findMany({
        where: { payrollRunId: run3.id, code: 'PRIOR_PERIOD_SOURCE_CHANGED' },
      });
      expect(
        warnings.map(
          (issue) => (issue.metadata as { sourceRunId: string }).sourceRunId,
        ),
      ).toEqual([run1]);
      expect(warnings.map((issue) => issue.metadata)).not.toContainEqual({
        sourceRunId: run2,
      });
      const run3Dates = (
        await tx.payrollSourceClaim.findMany({
          where: {
            payrollRunId: run3.id,
            employmentAssignmentId: fx.assignmentTeamA,
          },
        })
      ).map((claim) => claim.workDate.toISOString().slice(0, 10));
      expect(run3Dates.filter((date) => date < '2026-11-01')).toEqual([]);
      expect(await snapshot(run1)).toEqual(run1Before);
    });
  });
});
