import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  FixedPayrollClock,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
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
  grantMinutes,
  leaveServices,
  seedLeaveConfig,
} from './support/leave-fixtures.js';
import {
  afterPeriodEnd,
  FixedClock,
  seedTimePolicy,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/**
 * Batch 4A (R1, R2) — resolving retro requirements. Reopening paid time records a requirement
 * naming the version the finalized run paid (from its own time snapshots). The next runs warn
 * PRIOR_PERIOD_SOURCE_CHANGED against that run until a retro adjustment computed from the current
 * sources answers it, or the retro tool finds nothing to pay and records an audited
 * PayrollRetroResolution at the current fingerprint and adjusted sum. Unrelated, manual or
 * insufficient adjustments never answer it; a later change of the sources or of the adjustments
 * brings it back; finalized runs and claims never change.
 */
describe('Retro requirement resolution (Batch 4A, database)', () => {
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
        { timeout: 240_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** Three bi-weekly periods; employee 1 (hourly $24.50) is paid and finalized in the first two. */
  async function paidHistory(w: World) {
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
    const sheetOf = async (period: (typeof periods)[number]) =>
      (
        await tx.timesheet.findFirstOrThrow({
          where: {
            employeeId: fx.employee1,
            timePeriodId: period.timePeriodId,
          },
        })
      ).id;
    const approve = async (sheetId: string, periodEnd: Date) => {
      afterPeriodEnd(clock, periodEnd);
      await time.submitTimesheet(fx.selfUser1, sheetId, ctx(fx.selfUser1));
      for (const segment of await tx.timesheetSegment.findMany({
        where: { timesheetId: sheetId },
      })) {
        await time.approveTimesheetSegment(hr, segment.id, undefined, ctx(hr));
      }
    };
    const work = async (period: (typeof periods)[number], date: string) => {
      clock.value = new Date(`${date}T13:00:00.000Z`);
      await time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
      clock.value = new Date(`${date}T21:00:00.000Z`);
      await time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
      await svc.timeOrchestration.materialize(period.id, admin);
      const sheetId = await sheetOf(period);
      await approve(sheetId, period.periodEnd);
      return sheetId;
    };
    const finalize = async (period: (typeof periods)[number]) => {
      const run = await svc.runs.createRun(
        { payrollPeriodId: period.id, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      await svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!));
      return run.id;
    };
    const sheet1 = await work(periods[0]!, '2026-10-05');
    const run1 = await finalize(periods[0]!);
    const sheet2 = await work(periods[1]!, '2026-10-19');
    const run2 = await finalize(periods[1]!);
    /** Reopen a paid timesheet; optionally add time on `extra`; approve it again. */
    const reopenAndReapprove = async (
      sheetId: string,
      period: (typeof periods)[number],
      reason: string,
      extra?: { start: string; end: string },
    ) => {
      await time.reopenTimesheet(hr, sheetId, reason, ctx(hr));
      if (extra) {
        clock.value = new Date('2026-11-03T12:00:00.000Z');
        await time.addEntry(
          hr,
          fx.employee1,
          {
            employmentAssignmentId: fx.assignmentTeamA,
            startAt: extra.start,
            endAt: extra.end,
            reason,
          },
          ctx(hr),
        );
      }
      await approve(sheetId, period.periodEnd);
    };
    // Period 3: employee 1 works and is approved; its run is calculated (never finalized).
    await work(periods[2]!, '2026-11-02');
    const run3 = await svc.runs.createRun(
      { payrollPeriodId: periods[2]!.id, currency: 'CAD' },
      admin,
    );
    /** The source runs the PRIOR_PERIOD_SOURCE_CHANGED warnings of run 3 name, after recalculating. */
    const warnings = async () => {
      await svc.runs.calculate(run3.id, admin);
      return (
        await tx.payrollValidationIssue.findMany({
          where: { payrollRunId: run3.id, code: 'PRIOR_PERIOD_SOURCE_CHANGED' },
        })
      )
        .map((issue) => (issue.metadata as { sourceRunId: string }).sourceRunId)
        .sort((a, b) => a.localeCompare(b));
    };
    /** Everything finalized about a run: status, money, fingerprint, claims, lines, snapshots. */
    const frozen = async (runId: string) => ({
      run: await tx.payrollRun.findUniqueOrThrow({
        where: { id: runId },
        select: {
          status: true,
          grossAmount: true,
          sourceFingerprint: true,
          finalizedAt: true,
        },
      }),
      claims: await tx.payrollSourceClaim.findMany({
        where: { payrollRunId: runId },
        orderBy: [{ workDate: 'asc' }, { kind: 'asc' }, { id: 'asc' }],
      }),
      lines: await tx.payrollEarningLine.findMany({
        where: { payrollRunId: runId },
        orderBy: { id: 'asc' },
      }),
      snapshots: await tx.payrollTimeSnapshot.findMany({
        where: { payrollRunId: runId },
        orderBy: { id: 'asc' },
      }),
    });
    return {
      periods,
      sheet1,
      sheet2,
      run1,
      run2,
      run3: run3.id,
      reopenAndReapprove,
      warnings,
      frozen,
      retro: (runId: string, reason = 'Retro review') =>
        svc.adjustments.createRetroAdjustments(runId, reason, admin),
    };
  }

  it('unchanged re-approval is resolved once by the retro tool; a later change, a cancellation or an unrelated or insufficient adjustment never resolves it', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin, payGroupId } = w;
      const h = await paidHistory(w);
      const run1Before = await h.frozen(h.run1);
      expect(await h.warnings()).toEqual([]);

      // 1. Reopen paid time and approve the same hours again (version 2). The finalized run's
      // fingerprint covers the timesheet version, so the next run warns...
      await h.reopenAndReapprove(h.sheet1, h.periods[0]!, 'Fix a note');
      // (R2) the requirement names the version run 1 actually paid.
      expect(
        await tx.payrollRetroRequirement.findMany({
          where: { timesheetId: h.sheet1 },
          select: { payrollRunId: true, timesheetVersion: true },
        }),
      ).toEqual([{ payrollRunId: h.run1, timesheetVersion: 1 }]);
      expect(await h.warnings()).toEqual([h.run1]);
      // ...until the retro tool confirms there is nothing to pay.
      expect(await h.retro(h.run1)).toMatchObject({
        created: [],
        resolved: [fx.assignmentTeamA],
      });
      expect(
        await tx.payrollRetroResolution.findMany({
          where: { payrollRunId: h.run1 },
        }),
      ).toEqual([
        expect.objectContaining({
          employmentAssignmentId: fx.assignmentTeamA,
          employeeId: fx.employee1,
          resolvedByUserId: fx.users.payrollAdmin,
          reason: 'Retro review',
        }),
      ]);
      expect(
        await tx.auditLog.count({
          where: { entityId: h.run1, action: 'PAYROLL_RETRO_RESOLVED' },
        }),
      ).toBe(1);
      expect(await h.warnings()).toEqual([]);
      // Repeating the calculation adds nothing.
      expect(await h.retro(h.run1)).toMatchObject({
        created: [],
        resolved: [],
      });
      expect(
        await tx.payrollRetroResolution.count({
          where: { payrollRunId: h.run1 },
        }),
      ).toBe(1);

      // 2 and 5. A real change (2 more hours on Oct 6, version 3): the earlier resolution no
      // longer matches the sources, so the warning is back. Reopening the same paid time again
      // adds no requirement (still version 1, which run 1 paid).
      await h.reopenAndReapprove(h.sheet1, h.periods[0]!, 'Missed overtime', {
        start: '2026-10-06T17:00',
        end: '2026-10-06T19:00',
      });
      expect(
        await tx.payrollRetroRequirement.count({
          where: { timesheetId: h.sheet1 },
        }),
      ).toBe(1);
      expect(await h.warnings()).toEqual([h.run1]);

      // 4. Unrelated or insufficient adjustments don't answer it: another source run, another
      // assignment of the same run, and a manual adjustment for part of the difference.
      const manual = (
        employmentAssignmentId: string,
        sourceRunId: string,
        amount: string,
      ) =>
        svc.adjustments.createAdjustment(
          {
            payGroupId,
            employmentAssignmentId,
            currency: 'CAD',
            kind: 'EARNING',
            amount,
            description: 'Manual',
            reason: 'Manual',
            sourceRunId,
          },
          admin,
        );
      await manual(fx.assignmentTeamA, h.run2, '49.00');
      await manual(fx.otherTeamA, h.run1, '49.00');
      await manual(fx.assignmentTeamA, h.run1, '10.00');
      expect(await h.warnings()).toEqual([h.run1]);

      // 3. The retro tool pays the rest (2 h × $24.50 − $10.00 = $39.00); that answers it.
      const paid = await h.retro(h.run1);
      expect(paid).toMatchObject({ resolved: [] });
      // It also offsets the unrelated $49.00 put on employee 2's assignment against run 1.
      const created = await tx.payrollAdjustment.findMany({
        where: { id: { in: paid.created } },
      });
      expect(
        created
          .map((row) => [row.employmentAssignmentId, row.amount.toFixed(2)])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual(
        [
          [fx.assignmentTeamA, '39.00'],
          [fx.otherTeamA, '-49.00'],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
      expect(await h.warnings()).toEqual([]);
      expect(
        await tx.payrollRetroResolution.findMany({
          where: { payrollRunId: h.run1 },
          select: { outcome: true, adjustedAmount: true },
          orderBy: { createdAt: 'asc' },
        }),
      ).toEqual([
        {
          outcome: 'NO_ADJUSTMENT_REQUIRED',
          adjustedAmount: expect.anything(),
        },
        { outcome: 'ADJUSTED', adjustedAmount: expect.anything() },
      ]);
      // Settled: another call adds neither an adjustment nor a duplicate resolution.
      expect(await h.retro(h.run1)).toMatchObject({
        created: [],
        resolved: [],
      });
      expect(
        await tx.payrollRetroResolution.count({
          where: { payrollRunId: h.run1 },
        }),
      ).toBe(2);

      // Cancelling the manual $10.00 changes what was counted: $10 is owed again, and neither
      // the resolution nor the retro adjustment's fingerprint answers the warning any more.
      const manualTen = await tx.payrollAdjustment.findFirstOrThrow({
        where: {
          sourceRunId: h.run1,
          employmentAssignmentId: fx.assignmentTeamA,
          sourceFingerprint: null,
          amount: '10.00',
        },
      });
      await svc.adjustments.cancelAdjustment(
        manualTen.id,
        'Entered twice',
        admin,
      );
      expect(await h.warnings()).toEqual([h.run1]);
      const again = await h.retro(h.run1);
      expect(again.created).toHaveLength(1);
      expect(
        (
          await tx.payrollAdjustment.findUniqueOrThrow({
            where: { id: again.created[0]! },
          })
        ).amount.toFixed(2),
      ).toBe('10.00');
      expect(await h.warnings()).toEqual([]);

      // 8. The finalized run, its claims, lines and time snapshots never changed.
      expect(await h.frozen(h.run1)).toEqual(run1Before);
    });
  });

  it('several finalized runs and reopenings are tracked and resolved independently', async () => {
    await scenario(async (w) => {
      const { tx } = w;
      const h = await paidHistory(w);
      const before = {
        run1: await h.frozen(h.run1),
        run2: await h.frozen(h.run2),
      };
      await h.reopenAndReapprove(h.sheet1, h.periods[0]!, 'Review 1');
      await h.reopenAndReapprove(h.sheet2, h.periods[1]!, 'Review 2');
      // A second reopen of each adds nothing: the paid versions are still both 1.
      await h.reopenAndReapprove(h.sheet1, h.periods[0]!, 'Review 1 again');
      await h.reopenAndReapprove(h.sheet2, h.periods[1]!, 'Review 2 again');
      expect(
        (
          await tx.payrollRetroRequirement.findMany({
            select: {
              payrollRunId: true,
              timesheetId: true,
              timesheetVersion: true,
            },
            where: { timesheetId: { in: [h.sheet1, h.sheet2] } },
          })
        ).sort((a, b) => a.timesheetId.localeCompare(b.timesheetId)),
      ).toEqual(
        [
          { payrollRunId: h.run1, timesheetId: h.sheet1, timesheetVersion: 1 },
          { payrollRunId: h.run2, timesheetId: h.sheet2, timesheetVersion: 1 },
        ].sort((a, b) => a.timesheetId.localeCompare(b.timesheetId)),
      );
      expect(await h.warnings()).toEqual(
        [h.run1, h.run2].sort((a, b) => a.localeCompare(b)),
      );
      // Resolving run 1 leaves run 2's warning alone.
      await h.retro(h.run1);
      expect(await h.warnings()).toEqual([h.run2]);
      await h.retro(h.run2);
      expect(await h.warnings()).toEqual([]);
      expect(await h.frozen(h.run1)).toEqual(before.run1);
      expect(await h.frozen(h.run2)).toEqual(before.run2);
    });
  });

  /**
   * A resolution answers only the exact sources and adjusted sum it recorded. Many sources change
   * without touching the timesheet (compensation, employment, leave, benefits, rules, time
   * policy, live entries), so a run a requirement names is re-evaluated from its current sources
   * on every calculation, however long ago it was resolved.
   */
  it('a backdated compensation correction after a resolution makes each finalized run actionable again, independently', async () => {
    await scenario(async (w) => {
      const { tx, fx, payGroupId } = w;
      const h = await paidHistory(w);
      const before = {
        run1: await h.frozen(h.run1),
        run2: await h.frozen(h.run2),
      };
      await h.reopenAndReapprove(h.sheet1, h.periods[0]!, 'Review 1');
      await h.reopenAndReapprove(h.sheet2, h.periods[1]!, 'Review 2');
      expect(await h.retro(h.run1)).toMatchObject({
        created: [],
        resolved: [fx.assignmentTeamA],
      });
      expect(await h.retro(h.run2)).toMatchObject({
        created: [],
        resolved: [fx.assignmentTeamA],
      });
      // Unchanged fingerprints with valid resolutions: no warning.
      expect(await h.warnings()).toEqual([]);
      const timesheetsBefore = await tx.timesheet.findMany({
        where: { id: { in: [h.sheet1, h.sheet2] } },
        select: { id: true, updatedAt: true, version: true },
        orderBy: { id: 'asc' },
      });

      // The hourly rate was mis-keyed from the start: a correction supersedes it ($24.50 → $26.00).
      const original = await tx.compensationRecord.findFirstOrThrow({
        where: {
          employmentAssignmentId: fx.assignmentTeamA,
          supersededAt: null,
        },
      });
      await tx.compensationRecord.update({
        where: { id: original.id },
        data: { supersededAt: new Date() },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'CORRECTION',
          payBasis: 'HOURLY',
          rateAmount: '26',
          currency: 'CAD',
          effectiveFrom: original.effectiveFrom,
          payGroupId,
          supersedesRecordId: original.id,
          reason: 'Mis-keyed rate',
        },
      });
      // The timesheets didn't change; the resolutions no longer match the sources.
      expect(
        await tx.timesheet.findMany({
          where: { id: { in: [h.sheet1, h.sheet2] } },
          select: { id: true, updatedAt: true, version: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(timesheetsBefore);
      expect(await h.warnings()).toEqual(
        [h.run1, h.run2].sort((a, b) => a.localeCompare(b)),
      );

      // Each run is answered on its own: paying run 1's difference leaves run 2's warning.
      const paid1 = await h.retro(h.run1);
      expect(paid1).toMatchObject({ resolved: [] });
      expect(paid1.created).toHaveLength(1);
      expect(
        (
          await tx.payrollAdjustment.findUniqueOrThrow({
            where: { id: paid1.created[0]! },
          })
        ).amount.greaterThan(0),
      ).toBe(true);
      expect(await h.warnings()).toEqual([h.run2]);
      expect((await h.retro(h.run2)).created).toHaveLength(1);
      expect(await h.warnings()).toEqual([]);

      // Finalized runs, their claims, lines and snapshots never changed.
      expect(await h.frozen(h.run1)).toEqual(before.run1);
      expect(await h.frozen(h.run2)).toEqual(before.run2);
    });
  });

  it('leave approved in a resolved period makes only that run actionable again', async () => {
    await scenario(async (w) => {
      const { tx, fx } = w;
      const h = await paidHistory(w);
      const before = {
        run1: await h.frozen(h.run1),
        run2: await h.frozen(h.run2),
      };
      await h.reopenAndReapprove(h.sheet1, h.periods[0]!, 'Fix a note');
      expect(await h.retro(h.run1)).toMatchObject({
        created: [],
        resolved: [fx.assignmentTeamA],
      });
      expect(await h.warnings()).toEqual([]);
      const sheet1Before = await tx.timesheet.findUniqueOrThrow({
        where: { id: h.sheet1 },
        select: { updatedAt: true, version: true },
      });

      // Paid vacation on Oct 7 (period 1, no time worked that day), approved after the resolution.
      const leave = leaveServices(rollbackClient(tx));
      const types = await seedLeaveConfig(tx, fx, leave);
      await grantMinutes(
        leave,
        fx,
        fx.assignmentTeamA,
        types.vacation.id,
        4800,
      );
      const vacation = await leave.requests.submitOwn(
        fx.selfUser1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          leaveTypeId: types.vacation.id,
          startDate: '2026-10-07',
          endDate: '2026-10-07',
        },
        ctx(fx.selfUser1),
      );
      await leave.requests.approve(
        fx.users.hr!,
        vacation.requestId,
        {},
        ctx(fx.users.hr!),
      );
      expect(
        await tx.timesheet.findUniqueOrThrow({
          where: { id: h.sheet1 },
          select: { updatedAt: true, version: true },
        }),
      ).toEqual(sheet1Before);
      // Run 1 is actionable again; run 2 (other dates) is not affected.
      expect(await h.warnings()).toEqual([h.run1]);
      expect((await h.retro(h.run1)).created).toHaveLength(1);
      expect(await h.warnings()).toEqual([]);

      expect(await h.frozen(h.run1)).toEqual(before.run1);
      expect(await h.frozen(h.run2)).toEqual(before.run2);
    });
  });

  it('never records a resolution for the actor’s own pay', async () => {
    await scenario(async (w) => {
      const { tx, fx } = w;
      const h = await paidHistory(w);
      await h.reopenAndReapprove(h.sheet1, h.periods[0]!, 'Fix a note');
      // Employee 1's own account becomes a payroll adjuster in the organization.
      const role = await tx.role.create({
        data: {
          organizationId: fx.orgA,
          code: `ADJ-${fx.suffix}`,
          name: 'Adjuster',
        },
      });
      for (const key of ['payroll.read', 'payroll.adjust']) {
        const permission = await tx.permission.findUniqueOrThrow({
          where: { key },
        });
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
      }
      await tx.roleAssignment.create({
        data: {
          userId: fx.selfUser1,
          roleId: role.id,
          roleOrganizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
        },
      });
      expect(
        await w.svc.adjustments.createRetroAdjustments(
          h.run1,
          'Mine',
          ctx(fx.selfUser1),
        ),
      ).toMatchObject({ resolved: [] });
      expect(
        await tx.payrollRetroResolution.count({
          where: { payrollRunId: h.run1 },
        }),
      ).toBe(0);
      expect(await h.warnings()).toEqual([h.run1]);
    });
  });
});
