import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
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
  rejection,
  rollbackClient,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const statusOf = (error: unknown) => (error as HttpException).getStatus?.();
const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
/** America/Toronto is EDT (-04:00) in October 2026. */
const edt = (local: string) => new Date(`${local}:00-04:00`);

/**
 * Batch 5E (R3, option A) — an employee still clocked in when their termination takes effect.
 * The termination semantics of Batch 5A are unchanged: the termination applies, the open entry is
 * left exactly as it was (no invented clock-out, no awarded hours), the employee can no longer
 * close it, and payroll refuses to approve the period while the time is open. A manager closes it
 * with an audited direct correction (the clock-out may fall on the next local day; the work date
 * stays the last day of employment); the timesheet is then submitted on the employee's behalf and
 * approved, and payroll pays it. Once that payroll is finalized it never changes: a later
 * correction needs an audited reopen, which records a retroactive requirement against the run.
 */
describe('Batch 5E: overnight time when a termination takes effect (database)', () => {
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

  function lifecycleService(client: PrismaService) {
    const authorization = new AuthorizationService(client);
    const audit = new AuditService(client);
    const access = new EmployeeAccessService(
      client,
      authorization,
      new PositionAuthorizationTargetResolver(client),
      audit,
    );
    return new EmployeeLifecycleService(
      client,
      new EmployeeDomainService(client, audit),
      access,
      authorization,
      audit,
    );
  }

  it('leaves the open entry untouched, blocks payroll until a manager closes it, and never changes the finalized run afterwards', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin, periodId } = w;
      await seedTimePolicy(tx, fx.orgA);
      const clock = new FixedClock();
      const client = rollbackClient(tx);
      const time = timeServices(client, clock).time;
      const lifecycle = lifecycleService(client);
      const hr = fx.users.hr!;
      const period = await tx.payrollPeriod.findUniqueOrThrow({
        where: { id: periodId },
      });
      expect(period.periodStart.toISOString().slice(0, 10)).toBe('2026-10-04');

      // Employee 1 (hourly) works a normal day, then the last day is scheduled: Thursday Oct 8.
      clock.value = edt('2026-10-06T09:00');
      await time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
      clock.value = edt('2026-10-06T17:00');
      await time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
      const scheduled = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-10-08' },
        ctx(hr),
        edt('2026-10-07T12:00'),
      );
      expect(scheduled.termination.status).toBe('SCHEDULED');

      // The last shift starts at 22:00 on the last day and is never clocked out.
      clock.value = edt('2026-10-08T22:00');
      await time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
      const open = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1, status: 'OPEN' },
        include: { punches: true },
      });
      expect(open.workDate.toISOString().slice(0, 10)).toBe('2026-10-08');

      // The termination applies once Oct 8 has passed in Toronto, with the entry still open.
      const applied = await lifecycle.applyTermination(
        fx.employee1,
        scheduled.termination.id,
        ctx(hr),
        edt('2026-10-09T06:00'),
      );
      expect(applied.termination.status).toBe('APPLIED');
      const afterApply = await tx.timeEntry.findUniqueOrThrow({
        where: { id: open.id },
        include: { punches: true },
      });
      // Nothing invented: still open, no clock-out, no new punch, no hours.
      expect(afterApply.status).toBe('OPEN');
      expect(afterApply.clockOutAt).toBeNull();
      expect(afterApply.punches).toHaveLength(open.punches.length);
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: fx.assignmentTeamA },
          })
        ).status,
      ).toBe('ENDED');

      // Sessions ended with the employment. (Whether the employee can still close the entry
      // depends on their login: see the next test.) Here nobody closes it until the manager.
      expect(
        await tx.authSession.count({
          where: { userId: fx.selfUser1, revokedAt: null },
        }),
      ).toBe(0);

      // Payroll: the period's timesheet exists, but the open time blocks approval of the run.
      clock.value = new Date('2026-10-19T16:00:00.000Z');
      await svc.timeOrchestration.materialize(periodId, admin);
      const sheet = await tx.timesheet.findFirstOrThrow({
        where: {
          employeeId: fx.employee1,
          timePeriodId: period.timePeriodId,
        },
      });
      const submitWhileOpen = await rejection(
        time.submitTimesheetOnBehalf(
          hr,
          sheet.id,
          'Employee terminated; closing the period',
          ctx(hr),
        ),
      );
      expect(codeOf(submitWhileOpen)).toBe('TIMESHEET_OPEN_ENTRY');
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      expect(await issueCodes(tx, run.id, fx.employee1)).toContain(
        'ERROR:TIMESHEET_NOT_FINAL',
      );
      await expect(
        svc.lifecycle.approve(run.id, ctx(fx.users.approver!)),
      ).rejects.toBeDefined();

      // A correction cannot move work past the last day of employment.
      const pastEnd = await rejection(
        time.addEntry(
          hr,
          fx.employee1,
          {
            employmentAssignmentId: fx.assignmentTeamA,
            startAt: '2026-10-09T09:00',
            endAt: '2026-10-09T10:00',
            reason: 'Not employed that day',
          },
          ctx(hr),
        ),
      );
      expect(statusOf(pastEnd)).toBe(400);

      // The manager closes the entry with an audited correction; the clock-out is the next day.
      const closed = await time.correctEntry(
        hr,
        open.id,
        {
          type: 'ADD_MISSING_CLOCK_OUT',
          reason: 'Last shift ended at 02:00; employee terminated',
          clockOutAt: '2026-10-09T02:00',
        },
        ctx(hr),
      );
      expect(closed).toBeTruthy();
      const corrected = await tx.timeEntry.findUniqueOrThrow({
        where: { id: open.id },
      });
      expect(corrected.status).not.toBe('OPEN');
      expect(corrected.clockOutAt?.toISOString()).toBe(
        edt('2026-10-09T02:00').toISOString(),
      );
      expect(corrected.workDate.toISOString().slice(0, 10)).toBe('2026-10-08');
      expect(
        await tx.auditLog.count({
          where: {
            action: 'TIME_DIRECT_CORRECTION_APPLIED',
            actorUserId: hr,
          },
        }),
      ).toBe(1);

      // Submitted on the terminated employee's behalf (reason required), approved, then paid.
      await time.submitTimesheetOnBehalf(
        hr,
        sheet.id,
        'Employee terminated; closing the period',
        ctx(hr),
      );
      for (const segment of await tx.timesheetSegment.findMany({
        where: { timesheetId: sheet.id },
      })) {
        await time.approveTimesheetSegment(hr, segment.id, undefined, ctx(hr));
      }
      const outputs = await time.approvedPayrollTimeOutputs(sheet.id);
      expect(
        outputs.workDateOutputs
          .filter((o) => o.employmentAssignmentId === fx.assignmentTeamA)
          .map((o) => [o.workDate, o.approvedWorkedMinutes])
          .sort((a, b) => String(a).localeCompare(String(b))),
      ).toEqual([
        ['2026-10-06', 480],
        ['2026-10-08', 240],
      ]);
      await svc.runs.calculate(run.id, admin);
      expect(await issueCodes(tx, run.id, fx.employee1)).not.toContain(
        'ERROR:TIMESHEET_NOT_FINAL',
      );
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      await svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!));
      const snapshot = async () => ({
        run: await tx.payrollRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { status: true, grossAmount: true, sourceFingerprint: true },
        }),
        claims: await tx.payrollSourceClaim.findMany({
          where: { payrollRunId: run.id },
          select: { kind: true, workDate: true, employmentAssignmentId: true },
          orderBy: [{ workDate: 'asc' }, { kind: 'asc' }],
        }),
      });
      const paid = await snapshot();
      expect(paid.run.status).toBe('FINALIZED');
      expect(
        paid.claims.some(
          (claim) =>
            claim.kind === 'WORKED_TIME' &&
            claim.workDate.toISOString().startsWith('2026-10-08'),
        ),
      ).toBe(true);

      // Finalized payroll is never rewritten: a further correction is refused until the
      // timesheet is reopened (audited, reason), which records a retroactive requirement.
      const afterFinal = await rejection(
        time.correctEntry(
          hr,
          open.id,
          {
            type: 'CHANGE_CLOCK_OUT',
            reason: 'Ended at 01:30',
            clockOutAt: '2026-10-09T01:30',
          },
          ctx(hr),
        ),
      );
      expect(statusOf(afterFinal)).toBe(409);
      const reopened = await time.reopenTimesheet(
        hr,
        sheet.id,
        'Last shift ended at 01:30',
        ctx(hr),
      );
      expect(reopened).toMatchObject({
        retroAdjustment: { required: true, finalizedPayrollRunIds: [run.id] },
      });
      expect(
        await tx.payrollRetroRequirement.count({
          where: { timesheetId: sheet.id, payrollRunId: run.id },
        }),
      ).toBe(1);
      expect(await snapshot()).toEqual(paid);
    });
  });

  it('judges a correction by the work date stored with the entry, even after the assignment’s time zone changed', async () => {
    await scenario(async (w) => {
      const { tx, fx } = w;
      await seedTimePolicy(tx, fx.orgA);
      const clock = new FixedClock();
      const client = rollbackClient(tx);
      const time = timeServices(client, clock).time;
      const lifecycle = lifecycleService(client);
      const hr = fx.users.hr!;
      const scheduled = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-10-08' },
        ctx(hr),
        edt('2026-10-07T12:00'),
      );
      // 22:00 on the last day in Toronto (02:00 UTC on Oct 9), recorded in Toronto time.
      clock.value = edt('2026-10-08T22:00');
      await time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
      const open = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1, status: 'OPEN' },
      });
      expect(open.timezone).toBe('America/Toronto');
      await lifecycle.applyTermination(
        fx.employee1,
        scheduled.termination.id,
        ctx(hr),
        edt('2026-10-09T06:00'),
      );
      // Afterwards the assignment's work location moves to Asia/Kolkata, where the clock-in
      // instant is already Oct 9 (07:30) — after the last day.
      await tx.workLocation.update({
        where: { id: fx.workLocationToronto },
        data: { timezone: 'Asia/Kolkata' },
      });
      clock.value = new Date('2026-10-19T16:00:00.000Z');

      // The entry-duration limit still applies (policy: 600 minutes).
      const tooLong = await rejection(
        time.correctEntry(
          hr,
          open.id,
          {
            type: 'ADD_MISSING_CLOCK_OUT',
            reason: 'Too long',
            clockOutAt: '2026-10-09T09:00',
          },
          ctx(hr),
        ),
      );
      expect(codeOf(tooLong)).toBe('TIME_ENTRY_TOO_LONG');

      // Judged on the stored work date (Oct 8, in the entry's own time zone): accepted.
      await time.correctEntry(
        hr,
        open.id,
        {
          type: 'ADD_MISSING_CLOCK_OUT',
          reason: 'Last shift ended at 02:00; employee terminated',
          clockOutAt: '2026-10-09T02:00',
        },
        ctx(hr),
      );
      const closed = await tx.timeEntry.findUniqueOrThrow({
        where: { id: open.id },
      });
      expect(closed.status).not.toBe('OPEN');
      expect(closed.timezone).toBe('America/Toronto');
      expect(closed.workDate.toISOString().slice(0, 10)).toBe('2026-10-08');
      expect(closed.clockOutAt?.toISOString()).toBe(
        edt('2026-10-09T02:00').toISOString(),
      );
      expect(
        await tx.auditLog.count({
          where: { action: 'TIME_DIRECT_CORRECTION_APPLIED', actorUserId: hr },
        }),
      ).toBe(1);
    });
  });

  it('M3: once the termination applies the self-service grant is revoked and the login disabled; the open entry is left for a manager, and no new time is recorded', async () => {
    await scenario(async (w) => {
      const { tx, fx } = w;
      await seedTimePolicy(tx, fx.orgA);
      const clock = new FixedClock();
      const client = rollbackClient(tx);
      const time = timeServices(client, clock).time;
      const lifecycle = lifecycleService(client);
      const hr = fx.users.hr!;
      const scheduled = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-10-08' },
        ctx(hr),
        edt('2026-10-07T12:00'),
      );
      clock.value = edt('2026-10-08T22:00');
      await time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
      await lifecycle.applyTermination(
        fx.employee1,
        scheduled.termination.id,
        ctx(hr),
        edt('2026-10-09T06:00'),
      );
      // Security remediation M3 (was R2 / F-1: the login stayed while grants remained, and the
      // employee could close their own entry): the grant is revoked and the login disabled.
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser1 } }))
          .status,
      ).toBe('DISABLED');
      expect(
        await tx.roleAssignment.count({
          where: { userId: fx.selfUser1, revokedAt: null },
        }),
      ).toBe(0);
      // The disabled login cannot sign in and its sessions are revoked, so the employee can no
      // longer reach their open entry; it stays exactly as it was (no clock-out invented, no
      // hours awarded) for a manager's audited correction.
      expect(
        await tx.authSession.count({
          where: { userId: fx.selfUser1, revokedAt: null },
        }),
      ).toBe(0);
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1, workDate: new Date('2026-10-08') },
      });
      expect(entry.status).toBe('OPEN');
      expect(entry.clockOutAt).toBeNull();
      // No new time after the employment (a repeated clock-in only returns the open entry).
      clock.value = edt('2026-10-09T07:00');
      await time
        .clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1))
        .catch(() => undefined);
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(1);
    });
  });
});
