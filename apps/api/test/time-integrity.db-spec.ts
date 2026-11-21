import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  afterPeriodEnd,
  FixedClock,
  LIVE_TIME_POLICY,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  /** Every time permission over Organization A. */
  managerA: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  /** Batch 5B: every time permission over Organization B only. */
  managerB: [{ permissions: TIME_PERMISSIONS, scope: 'orgB' as const }],
  /** Reviews timesheets and corrections, but cannot manage (reopen, lock) them. */
  reviewerA: [
    {
      permissions: ['time.view', 'time.approve', 'time.timesheet.approve'],
      scope: 'org' as const,
    },
  ],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
}

/** The body of a Nest HTTP exception (its code, message and extras). */
const body = (error: unknown) =>
  (error as { getResponse?: () => unknown }).getResponse?.() as Record<
    string,
    unknown
  >;
const statusOf = (error: unknown) =>
  (error as { getStatus?: () => number }).getStatus?.();

/**
 * Batch 4A — time integrity and payroll snapshots (database). The approved snapshot is what
 * payroll pays; locking keeps it exactly; time recorded after approval is flagged and reaches
 * payroll only through an explicit reopen; submission and approval follow the period lifecycle;
 * corrections refuse future and overlapping time; privileged actions never target one's own time.
 */
describe('Time integrity and payroll snapshots (Batch 4A, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: Harness) => Promise<void>,
    policy: Record<string, unknown> = LIVE_TIME_POLICY,
    extra?: (tx: Tx, fx: SchedulingFixtures) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(
            tx,
            USERS,
            TIME_PERMISSIONS,
          );
          await seedTimePolicy(tx, fx.orgA, policy);
          await extra?.(tx, fx);
          const clock = new FixedClock();
          const svc = timeServices(rollbackClient(tx), clock);
          await run({ tx, fx, clock, svc }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 90_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  async function work(
    h: Harness,
    assignmentId: string,
    from: string,
    to: string,
  ) {
    h.clock.value = toronto(from);
    await h.svc.time.clockIn(h.fx.selfUser1, assignmentId, ctx(h.fx.selfUser1));
    h.clock.value = toronto(to);
    await h.svc.time.clockOut(h.fx.selfUser1, ctx(h.fx.selfUser1));
  }

  /** Employee 1's timesheet for the week of Monday 2027-03-01 (ends Sunday 2027-03-07). */
  async function weeklySheet(h: Harness) {
    await h.svc.time.generateTimePeriods(
      h.fx.users.managerA!,
      { organizationId: h.fx.orgA, startDate: '2027-03-01', cadence: 'WEEKLY' },
      ctx(h.fx.users.managerA!),
    );
    const period = await h.tx.timePeriod.findFirstOrThrow({
      where: { organizationId: h.fx.orgA },
    });
    return (
      await h.svc.time.materializeTimesheetForEmployeePeriod(
        h.fx.employee1,
        period.id,
      )
    ).id;
  }

  const segmentsOf = (h: Harness, timesheetId: string) =>
    h.tx.timesheetSegment.findMany({
      where: { timesheetId },
      orderBy: { employmentAssignmentId: 'asc' },
    });

  async function submit(h: Harness, sheetId: string) {
    return h.svc.time.submitTimesheet(
      h.fx.selfUser1,
      sheetId,
      ctx(h.fx.selfUser1),
    );
  }

  async function approveAll(h: Harness, sheetId: string, actor: string) {
    for (const segment of await segmentsOf(h, sheetId)) {
      await h.svc.time.approveTimesheetSegment(
        actor,
        segment.id,
        undefined,
        ctx(actor),
      );
    }
  }

  /** Grants Employee 1's own account extra time permissions over Organization A. */
  async function grantSelf(tx: Tx, fx: SchedulingFixtures, keys: string[]) {
    const role = await tx.role.create({
      data: {
        organizationId: fx.orgA,
        code: `SELF-${fx.suffix}`,
        name: 'Self time manager',
      },
    });
    for (const key of keys) {
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
  }

  /** The System Owner role (the only role held at System scope), with the given permissions. */
  async function grantSystemOwner(tx: Tx, userId: string, keys: string[]) {
    const role =
      (await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
      (await tx.role.create({
        data: {
          organizationId: null,
          code: 'SYSTEM_OWNER',
          name: 'System Owner',
          isSystemOwner: true,
        },
      }));
    for (const key of keys) {
      const permission = await tx.permission.findUniqueOrThrow({
        where: { key },
      });
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        create: { roleId: role.id, permissionId: permission.id },
        update: {},
      });
    }
    await tx.roleAssignment.create({
      data: { userId, roleId: role.id, scopeType: 'SYSTEM' },
    });
  }

  // ─── 1. Approved snapshot and lock ─────────────────────────────────────────────────────

  it('locks exactly the approved payroll snapshot (two assignments, switched mid-day)', async () => {
    await scenario(
      async (h) => {
        const { fx, svc } = h;
        const manager = fx.users.managerA!;
        h.clock.value = toronto('2027-03-02T09:00');
        await svc.time.clockIn(
          fx.selfUser1,
          fx.assignmentTeamA,
          ctx(fx.selfUser1),
        );
        h.clock.value = toronto('2027-03-02T12:00');
        await svc.time.switchAssignment(
          fx.selfUser1,
          fx.assignmentDeptB,
          ctx(fx.selfUser1),
        );
        h.clock.value = toronto('2027-03-02T14:00');
        await svc.time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
        const sheetId = await weeklySheet(h);
        afterPeriodEnd(h.clock, '2027-03-07');
        await submit(h, sheetId);
        await approveAll(h, sheetId, manager);

        const approved = await svc.time.approvedPayrollTimeOutputs(sheetId);
        expect(approved.status).toBe('APPROVED');
        expect(
          approved.workDateOutputs
            .map((o) => [o.employmentAssignmentId, o.approvedWorkedMinutes])
            .sort((a, b) => String(a).localeCompare(String(b))),
        ).toEqual(
          [
            [fx.assignmentTeamA, 180],
            [fx.assignmentDeptB, 120],
          ].sort((a, b) => String(a).localeCompare(String(b))),
        );

        await svc.time.lockTimesheet(manager, sheetId, ctx(manager));
        const locked = await svc.time.approvedPayrollTimeOutputs(sheetId);
        expect(locked.status).toBe('LOCKED');
        // Exactly the approved rows; only their finalization status changes.
        expect(locked.workDateOutputs).toEqual(
          approved.workDateOutputs.map((output) => ({
            ...output,
            finalizationStatus: 'LOCKED',
          })),
        );
        expect(locked.segments).toEqual(approved.segments);
        expect(locked.version).toBe(approved.version);
        const { payrollWorkDates: lockedRows, ...lockedRest } =
          locked.totals as Record<string, unknown>;
        const { payrollWorkDates: approvedRows, ...approvedRest } =
          approved.totals as Record<string, unknown>;
        expect(lockedRest).toEqual(approvedRest);
        expect((lockedRows as unknown[]).length).toBe(
          (approvedRows as unknown[]).length,
        );
        // Locking twice changes nothing.
        await svc.time.lockTimesheet(manager, sheetId, ctx(manager));
        expect(await svc.time.approvedPayrollTimeOutputs(sheetId)).toEqual(
          locked,
        );
      },
      LIVE_TIME_POLICY,
      // Dept B's position has no work location: its timezone is the organization's.
      async (tx, fx) => {
        await tx.organization.update({
          where: { id: fx.orgA },
          data: { timezone: 'America/Toronto' },
        });
      },
    );
  });

  it('Batch 5B (D16): an ENDED assignment takes corrections for dates it covered, never past a lock, its end or another organization', async () => {
    await scenario(
      async (h) => {
        const { fx, svc, tx } = h;
        const manager = fx.users.managerA!;
        await work(
          h,
          fx.assignmentDeptB,
          '2027-03-02T09:00',
          '2027-03-02T12:00',
        );
        const sheetId = await weeklySheet(h);
        afterPeriodEnd(h.clock, '2027-03-07');
        await submit(h, sheetId);
        await approveAll(h, sheetId, manager);
        await svc.time.lockTimesheet(manager, sheetId, ctx(manager));
        // The assignment has since ended (its last day inside the locked week).
        await tx.employmentAssignment.update({
          where: { id: fx.assignmentDeptB },
          data: {
            status: 'ENDED',
            endDate: new Date('2027-03-05T00:00:00.000Z'),
          },
        });
        h.clock.value = toronto('2027-03-12T09:00');
        const entry = (date: string) => ({
          employmentAssignmentId: fx.assignmentDeptB,
          startAt: `${date}T09:00`,
          endAt: `${date}T10:00`,
          reason: 'Missed punch',
        });
        // Inside its dates, before the locked week: accepted (D16).
        const added = await svc.time.addEntry(
          manager,
          fx.employee1,
          entry('2027-02-24'),
          ctx(manager),
        );
        expect(added.timeEntryId).toBeTruthy();
        // Inside its dates but inside the locked week: still refused (locks are not loosened).
        const locked = await rejection(
          svc.time.addEntry(
            manager,
            fx.employee1,
            entry('2027-03-03'),
            ctx(manager),
          ),
        );
        expect(statusOf(locked)).toBe(409);
        // After its end date: refused.
        const after = await rejection(
          svc.time.addEntry(
            manager,
            fx.employee1,
            entry('2027-03-09'),
            ctx(manager),
          ),
        );
        expect(statusOf(after)).toBe(400);
        // Another organization's time manager cannot see it at all.
        const foreign = await rejection(
          svc.time.addEntry(
            fx.users.managerB!,
            fx.employee1,
            entry('2027-02-25'),
            ctx(fx.users.managerB!),
          ),
        );
        expect(statusOf(foreign)).toBe(404);
        expect(
          await tx.timeEntry.count({
            where: { employmentAssignmentId: fx.assignmentDeptB },
          }),
        ).toBe(2);
        // The locked snapshot is unchanged.
        expect(
          (await svc.time.approvedPayrollTimeOutputs(sheetId)).status,
        ).toBe('LOCKED');
      },
      LIVE_TIME_POLICY,
      async (tx, fx) => {
        await tx.organization.update({
          where: { id: fx.orgA },
          data: { timezone: 'America/Toronto' },
        });
      },
    );
  });

  it('[4A, was a pinned defect] time recorded after approval is flagged and kept out of the snapshot until a reopen', async () => {
    await scenario(
      async (h) => {
        const { fx, svc, tx } = h;
        const manager = fx.users.managerA!;
        await work(
          h,
          fx.assignmentTeamA,
          '2027-03-02T09:00',
          '2027-03-02T12:00',
        );
        const sheetId = await weeklySheet(h);
        // Early submission is allowed by this policy, so approval happens mid-period.
        h.clock.value = toronto('2027-03-03T08:00');
        await submit(h, sheetId);
        await approveAll(h, sheetId, manager);
        const approved = await svc.time.approvedPayrollTimeOutputs(sheetId);

        // Live clocking into the approved period is still accepted...
        await work(
          h,
          fx.assignmentTeamA,
          '2027-03-04T09:00',
          '2027-03-04T11:00',
        );
        const late = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1, workDate: new Date('2027-03-04') },
        });
        expect(late.status).toBe('CLOSED');
        // ...flagged for review and audited...
        const flag = await tx.attendanceException.findFirstOrThrow({
          where: { timeEntryId: late.id, type: 'RECORDED_AFTER_APPROVAL' },
        });
        expect(flag).toMatchObject({
          status: 'OPEN',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
        });
        expect(
          await tx.auditLog.count({
            where: {
              entityId: flag.id,
              action: 'TIME_RECORDED_AFTER_APPROVAL',
            },
          }),
        ).toBe(1);
        // ...and never enters the approved snapshot, not even when it is locked.
        expect(await svc.time.approvedPayrollTimeOutputs(sheetId)).toEqual(
          approved,
        );
        await svc.time.lockTimesheet(manager, sheetId, ctx(manager));
        const locked = await svc.time.approvedPayrollTimeOutputs(sheetId);
        expect(locked.workDateOutputs.map((o) => o.workDate)).toEqual([
          '2027-03-02',
        ]);
        expect(
          locked.workDateOutputs.reduce(
            (sum, o) => sum + o.approvedWorkedMinutes,
            0,
          ),
        ).toBe(180);

        // Only an explicit reopen brings it under review; re-approval includes it.
        const reopened = await svc.time.reopenTimesheet(
          manager,
          sheetId,
          'Late hours on the 4th',
          ctx(manager),
        );
        expect(reopened).toMatchObject({
          status: 'OPEN',
          version: 2,
          retroAdjustment: { required: false, finalizedPayrollRunIds: [] },
        });
        expect(
          (
            await tx.attendanceException.findUniqueOrThrow({
              where: { id: flag.id },
            })
          ).status,
        ).toBe('RESOLVED');
        await submit(h, sheetId);
        await approveAll(h, sheetId, manager);
        const reapproved = await svc.time.approvedPayrollTimeOutputs(sheetId);
        expect(reapproved.version).toBe(2);
        expect(
          reapproved.workDateOutputs.map((o) => o.workDate).sort(),
        ).toEqual(['2027-03-02', '2027-03-04']);
      },
      {
        ...LIVE_TIME_POLICY,
        timesheet: { allowEarlySubmission: true },
      },
    );
  });

  it('refuses to lock a timesheet that is not approved, or from a stale version', async () => {
    await scenario(async (h) => {
      const { fx, svc } = h;
      const manager = fx.users.managerA!;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      const sheetId = await weeklySheet(h);
      const open = await rejection(
        svc.time.lockTimesheet(manager, sheetId, ctx(manager)),
      );
      expect(body(open)).toMatchObject({ code: 'TIMESHEET_NOT_APPROVED' });
      afterPeriodEnd(h.clock, '2027-03-07');
      await submit(h, sheetId);
      await approveAll(h, sheetId, manager);
      expect(
        body(
          await rejection(
            svc.time.lockTimesheet(manager, sheetId, ctx(manager), {
              expectedVersion: 2,
            }),
          ),
        ),
      ).toMatchObject({ code: 'TIMESHEET_VERSION_CONFLICT', version: 1 });
      await svc.time.lockTimesheet(manager, sheetId, ctx(manager), {
        expectedVersion: 1,
      });
    });
  });

  // ─── 2. Submission and approval ─────────────────────────────────────────────────────────

  it('[4A, was a pinned defect] submission and approval wait for the period to end; unsubmitted time is never approved', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      const manager = fx.users.managerA!;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      const sheetId = await weeklySheet(h);
      const [segment] = await segmentsOf(h, sheetId);

      // Never submitted: not approvable, even after the period.
      afterPeriodEnd(h.clock, '2027-03-07');
      const unsubmitted = await rejection(
        svc.time.approveTimesheetSegment(
          manager,
          segment!.id,
          undefined,
          ctx(manager),
        ),
      );
      expect(statusOf(unsubmitted)).toBe(409);
      expect(body(unsubmitted)).toMatchObject({
        code: 'TIMESHEET_NOT_SUBMITTED',
        status: 'OPEN',
      });
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
          .status,
      ).toBe('OPEN');

      // The period ends on Sunday 2027-03-07 in the organization's timezone.
      for (const local of ['2027-03-03T08:00', '2027-03-07T23:59']) {
        h.clock.value = toronto(local);
        expect(body(await rejection(submit(h, sheetId)))).toMatchObject({
          code: 'TIMESHEET_PERIOD_NOT_ENDED',
          periodEndDate: '2027-03-07',
        });
      }
      h.clock.value = toronto('2027-03-08T00:01');
      expect(await submit(h, sheetId)).toMatchObject({ status: 'SUBMITTED' });
      await approveAll(h, sheetId, manager);
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
          .status,
      ).toBe('APPROVED');
    });
  });

  it('approval re-checks the submission rules and refuses a stale review', async () => {
    await scenario(async (h) => {
      const { fx, svc } = h;
      const manager = fx.users.managerA!;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      const sheetId = await weeklySheet(h);
      afterPeriodEnd(h.clock, '2027-03-07');
      await submit(h, sheetId);
      const [segment] = await segmentsOf(h, sheetId);
      expect(segment!.netWorkedMinutes).toBe(180);

      // Time added after submission: the reviewer who saw 180 minutes is refused.
      await svc.time.addEntry(
        manager,
        fx.employee1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          startAt: '2027-03-04T09:00',
          endAt: '2027-03-04T10:00',
          reason: 'Paper timesheet',
        },
        ctx(manager),
      );
      expect(
        body(
          await rejection(
            svc.time.approveTimesheetSegment(
              manager,
              segment!.id,
              undefined,
              ctx(manager),
              {
                expectedNetWorkedMinutes: 180,
              },
            ),
          ),
        ),
      ).toMatchObject({
        code: 'TIMESHEET_SEGMENT_CHANGED',
        netWorkedMinutes: 240,
      });

      // A pending correction in the period blocks approval as it blocks submission.
      const entry = (
        await h.tx.timeEntry.findMany({
          where: { employeeId: fx.employee1 },
          orderBy: { clockInAt: 'asc' },
        })
      )[0]!;
      await svc.time.requestCorrection(
        fx.selfUser1,
        {
          type: 'CHANGE_CLOCK_OUT',
          timeEntryId: entry.id,
          clockOutAt: '2027-03-02T12:30',
          reason: 'Left later',
        },
        ctx(fx.selfUser1),
      );
      expect(
        body(
          await rejection(
            svc.time.approveTimesheetSegment(
              manager,
              segment!.id,
              undefined,
              ctx(manager),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIMESHEET_PENDING_CORRECTIONS' });
    });
  });

  it('submits on behalf only with the manage permission and a reason, audited, never for oneself', async () => {
    await scenario(
      async (h) => {
        const { fx, svc, tx } = h;
        await work(
          h,
          fx.assignmentTeamA,
          '2027-03-02T09:00',
          '2027-03-02T12:00',
        );
        const sheetId = await weeklySheet(h);
        afterPeriodEnd(h.clock, '2027-03-07');
        const reviewer = fx.users.reviewerA!;
        const manager = fx.users.managerA!;
        expect(
          statusOf(
            await rejection(
              svc.time.submitTimesheetOnBehalf(
                reviewer,
                sheetId,
                'On leave',
                ctx(reviewer),
              ),
            ),
          ),
        ).toBe(403);
        expect(
          body(
            await rejection(
              svc.time.submitTimesheetOnBehalf(
                manager,
                sheetId,
                '  ',
                ctx(manager),
              ),
            ),
          ),
        ).toMatchObject({ code: 'TIMESHEET_REASON_REQUIRED' });
        // Employee 1's own account holds the manage permission too, but not for itself.
        expect(
          body(
            await rejection(
              svc.time.submitTimesheetOnBehalf(
                fx.selfUser1,
                sheetId,
                'Myself',
                ctx(fx.selfUser1),
              ),
            ),
          ),
        ).toMatchObject({ code: 'TIME_SELF_TARGET_FORBIDDEN' });

        await svc.time.submitTimesheetOnBehalf(
          manager,
          sheetId,
          'Employee on medical leave',
          ctx(manager),
        );
        const sheet = await tx.timesheet.findUniqueOrThrow({
          where: { id: sheetId },
          include: { events: true },
        });
        expect(sheet).toMatchObject({
          status: 'SUBMITTED',
          submittedByUserId: manager,
        });
        expect(sheet.events).toEqual([
          expect.objectContaining({
            type: 'SUBMITTED',
            note: 'Employee on medical leave',
            metadata: { onBehalf: true },
          }),
        ]);
        expect(
          await tx.auditLog.findFirstOrThrow({
            where: {
              entityId: sheetId,
              action: 'TIMESHEET_SUBMITTED_ON_BEHALF',
            },
          }),
        ).toMatchObject({
          actorUserId: manager,
          metadata: expect.objectContaining({
            reason: 'Employee on medical leave',
          }),
        });
      },
      LIVE_TIME_POLICY,
      (tx, fx) => grantSelf(tx, fx, ['time.timesheet.manage']),
    );
  });

  // ─── 7. Request changes and reopen ──────────────────────────────────────────────────────

  it('resubmission returns only the returned segment to PENDING, keeps the approved one and the history (Batch 4F)', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      const reviewer = fx.users.reviewerA!;
      // Department B's position has no work location: its time zone is the organization's.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      await work(h, fx.assignmentDeptB, '2027-03-03T09:00', '2027-03-03T11:00');
      const sheetId = await weeklySheet(h);
      afterPeriodEnd(h.clock, '2027-03-07');
      await submit(h, sheetId);
      const segments = await segmentsOf(h, sheetId);
      const teamA = segments.find(
        (segment) => segment.employmentAssignmentId === fx.assignmentTeamA,
      )!;
      const deptB = segments.find(
        (segment) => segment.employmentAssignmentId === fx.assignmentDeptB,
      )!;
      // Team A is approved; Department B is returned with a note.
      await svc.time.approveTimesheetSegment(
        reviewer,
        teamA.id,
        undefined,
        ctx(reviewer),
      );
      await svc.time.requestTimesheetChanges(
        reviewer,
        deptB.id,
        'Add the delivery break',
        ctx(reviewer),
      );
      const approvedBefore = await tx.timesheetSegment.findUniqueOrThrow({
        where: { id: teamA.id },
      });
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
          .status,
      ).toBe('CHANGES_REQUESTED');

      await submit(h, sheetId);

      // The approved segment is untouched (status, snapshot minutes, reviewer).
      expect(
        await tx.timesheetSegment.findUniqueOrThrow({
          where: { id: teamA.id },
        }),
      ).toMatchObject({
        status: 'APPROVED',
        approvedWorkedMinutes: approvedBefore.approvedWorkedMinutes,
        reviewedByUserId: reviewer,
      });
      // Only the returned one waits again.
      expect(
        (
          await tx.timesheetSegment.findUniqueOrThrow({
            where: { id: deptB.id },
          })
        ).status,
      ).toBe('PENDING');
      // Back in the approval queue (submitted, a pending segment), showing that segment.
      const queue = await svc.time.managementTimesheets(reviewer, {
        status: 'SUBMITTED',
        segmentStatus: 'PENDING',
      });
      const queued = queue.items.find((item) => item.id === sheetId);
      expect(queued?.segments.map((segment) => segment.id)).toEqual([deptB.id]);
      // The history keeps the approval, the request with its note and both submissions.
      const events = await tx.timesheetEvent.findMany({
        where: { timesheetId: sheetId },
        orderBy: { occurredAt: 'asc' },
        select: { type: true, segmentId: true, note: true },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'SEGMENT_APPROVED',
            segmentId: teamA.id,
          }),
          expect.objectContaining({
            type: 'CHANGES_REQUESTED',
            segmentId: deptB.id,
            note: 'Add the delivery break',
          }),
        ]),
      );
      expect(events.filter((event) => event.type === 'SUBMITTED')).toHaveLength(
        2,
      );
      // Approving the resubmitted segment completes the timesheet.
      await svc.time.approveTimesheetSegment(
        reviewer,
        deptB.id,
        undefined,
        ctx(reviewer),
      );
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
          .status,
      ).toBe('APPROVED');
    });
  });

  it('request-changes: the approve permission on submitted time, manage and a reason on approved time', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      const reviewer = fx.users.reviewerA!;
      const manager = fx.users.managerA!;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      const sheetId = await weeklySheet(h);
      afterPeriodEnd(h.clock, '2027-03-07');
      await submit(h, sheetId);
      const [segment] = await segmentsOf(h, sheetId);

      // Submitted: an ordinary reviewer sends it back.
      await svc.time.requestTimesheetChanges(
        reviewer,
        segment!.id,
        'Add the lunch break',
        ctx(reviewer),
      );
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
          .status,
      ).toBe('CHANGES_REQUESTED');
      await submit(h, sheetId);
      // Batch 4F: resubmitting answers the request: the segment waits for a decision again, so
      // the approval queue (submitted timesheets with pending segments) lists it.
      expect(
        (
          await tx.timesheetSegment.findUniqueOrThrow({
            where: { id: segment!.id },
          })
        ).status,
      ).toBe('PENDING');
      expect(
        (
          await svc.time.managementTimesheets(reviewer, {
            status: 'SUBMITTED',
            segmentStatus: 'PENDING',
          })
        ).items.map((item) => item.id),
      ).toContain(sheetId);
      await svc.time.approveTimesheetSegment(
        reviewer,
        segment!.id,
        undefined,
        ctx(reviewer),
      );
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
          .status,
      ).toBe('APPROVED');

      // Approved: the reviewer can no longer undo the approval...
      expect(
        statusOf(
          await rejection(
            svc.time.requestTimesheetChanges(
              reviewer,
              segment!.id,
              'Second look',
              ctx(reviewer),
            ),
          ),
        ),
      ).toBe(403);
      // ...a manager can, with a reason, as a reopen.
      expect(
        body(
          await rejection(
            svc.time.requestTimesheetChanges(
              manager,
              segment!.id,
              undefined,
              ctx(manager),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIMESHEET_REASON_REQUIRED' });
      await svc.time.requestTimesheetChanges(
        manager,
        segment!.id,
        'Wrong project',
        ctx(manager),
      );
      const sheet = await tx.timesheet.findUniqueOrThrow({
        where: { id: sheetId },
        include: { events: { orderBy: { occurredAt: 'asc' } }, segments: true },
      });
      expect(sheet).toMatchObject({
        status: 'CHANGES_REQUESTED',
        version: 2,
        approvedAt: null,
      });
      expect(sheet.segments[0]).toMatchObject({
        status: 'CHANGES_REQUESTED',
        approvedWorkedMinutes: 0,
      });
      expect(sheet.events.map((e) => e.type).slice(-2)).toEqual([
        'REOPENED',
        'CHANGES_REQUESTED',
      ]);
      expect(
        await tx.auditLog.findFirstOrThrow({
          where: { entityId: sheetId, action: 'TIMESHEET_REOPENED' },
        }),
      ).toMatchObject({
        metadata: expect.objectContaining({
          reason: 'Wrong project',
          fromStatus: 'APPROVED',
          version: 2,
        }),
      });
    });
  });

  it('reopen needs the manage permission, a reason and an up-to-date view', async () => {
    await scenario(async (h) => {
      const { fx, svc } = h;
      const manager = fx.users.managerA!;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      const sheetId = await weeklySheet(h);
      afterPeriodEnd(h.clock, '2027-03-07');
      await submit(h, sheetId);
      await approveAll(h, sheetId, manager);
      expect(
        statusOf(
          await rejection(
            svc.time.reopenTimesheet(
              fx.users.reviewerA!,
              sheetId,
              'x',
              ctx(fx.users.reviewerA!),
            ),
          ),
        ),
      ).toBe(403);
      expect(
        body(
          await rejection(
            svc.time.reopenTimesheet(manager, sheetId, '', ctx(manager)),
          ),
        ),
      ).toMatchObject({ code: 'TIMESHEET_REASON_REQUIRED' });
      expect(
        body(
          await rejection(
            svc.time.reopenTimesheet(manager, sheetId, 'Fix', ctx(manager), {
              expectedVersion: 3,
            }),
          ),
        ),
      ).toMatchObject({ code: 'TIMESHEET_VERSION_CONFLICT' });
      expect(
        await svc.time.reopenTimesheet(manager, sheetId, 'Fix', ctx(manager), {
          expectedVersion: 1,
        }),
      ).toMatchObject({ status: 'OPEN', version: 2 });
    });
  });

  // ─── 4. Missed punches and manual entries ───────────────────────────────────────────────

  it('[4A, was a pinned defect] a missed clock-out: never in the future, never too long, never before recorded activity', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      h.clock.value = toronto('2027-03-02T09:00');
      await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        ctx(fx.selfUser1),
      );
      h.clock.value = toronto('2027-03-02T13:00');
      await svc.time.startBreak(fx.selfUser1, ctx(fx.selfUser1));
      // Past the policy's 600-minute missed-punch threshold.
      h.clock.value = toronto('2027-03-02T20:00');
      await svc.time.scanOpenTimeEntriesForExceptions({ userAgent: 'vitest' });
      const exception = await tx.attendanceException.findFirstOrThrow({
        where: { employeeId: fx.employee1, type: 'MISSING_CLOCK_OUT' },
      });
      const resolve = (local: string) =>
        rejection(
          svc.time.resolveMissedClockOut(
            fx.selfUser1,
            exception.id,
            local,
            ctx(fx.selfUser1),
          ),
        );
      expect(body(await resolve('2027-03-05T17:00'))).toMatchObject({
        code: 'TIME_IN_FUTURE',
        field: 'clockOutAt',
      });
      expect(body(await resolve('2027-03-02T19:30'))).toMatchObject({
        code: 'TIME_ENTRY_TOO_LONG',
        maxMinutes: 600,
      });
      expect(body(await resolve('2027-03-02T12:30'))).toMatchObject({
        code: 'TIME_BEFORE_RECORDED_ACTIVITY',
      });
      await svc.time.resolveMissedClockOut(
        fx.selfUser1,
        exception.id,
        '2027-03-02T17:00',
        ctx(fx.selfUser1),
      );
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
        include: { breaks: true },
      });
      expect(entry).toMatchObject({
        status: 'CLOSED',
        clockOutAt: toronto('2027-03-02T17:00'),
      });
      expect(entry.breaks[0]!.endAt).toEqual(toronto('2027-03-02T17:00'));
    });
  });

  it('[4A, was a pinned defect] manual entries: no future time, no overlap with the open entry; overnight and DST entries still work', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      const manager = fx.users.managerA!;
      const add = (startAt: string, endAt: string, reason = 'Paper record') =>
        svc.time.addEntry(
          manager,
          fx.employee1,
          {
            employmentAssignmentId: fx.assignmentTeamA,
            startAt,
            endAt,
            reason,
          },
          ctx(manager),
        );
      h.clock.value = toronto('2027-03-16T09:00');
      await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        ctx(fx.selfUser1),
      );
      h.clock.value = toronto('2027-03-16T11:00');

      const overlap = await rejection(
        add('2027-03-16T09:00', '2027-03-16T11:00'),
      );
      expect(statusOf(overlap)).toBe(409);
      expect(body(overlap)).toMatchObject({ code: 'TIME_ENTRY_OVERLAP' });
      expect(
        body(await rejection(add('2027-03-23T09:00', '2027-03-23T17:00'))),
      ).toMatchObject({
        code: 'TIME_IN_FUTURE',
      });
      // Ending exactly when the open entry started is not an overlap. (toronto() is a fixed
      // -05:00, so the clock-in above is 10:00 local daylight time.)
      await add('2027-03-16T08:00', '2027-03-16T10:00');
      // Longer than the policy's 600-minute limit.
      expect(
        body(await rejection(add('2027-03-10T06:00', '2027-03-10T17:00'))),
      ).toMatchObject({
        code: 'TIME_ENTRY_TOO_LONG',
      });
      // Overnight work keeps its start date.
      await add('2027-03-11T22:00', '2027-03-12T06:00', 'Night shift');
      // Across the spring-forward night (2027-03-14 02:00 → 03:00): eight wall-clock hours,
      // seven elapsed.
      await add('2027-03-13T22:00', '2027-03-14T06:00', 'Night shift (DST)');
      const entries = await tx.timeEntry.findMany({
        where: { employeeId: fx.employee1, source: 'MANUAL' },
        orderBy: { clockInAt: 'asc' },
      });
      expect(
        entries.map((entry) => [
          entry.workDate.toISOString().slice(0, 10),
          (entry.clockOutAt!.getTime() - entry.clockInAt.getTime()) / 60_000,
        ]),
      ).toEqual([
        ['2027-03-11', 480],
        ['2027-03-13', 420],
        ['2027-03-16', 120],
      ]);
      expect(
        await tx.timeEntry.count({
          where: { employeeId: fx.employee1, status: 'OPEN' },
        }),
      ).toBe(1);
    });
  });

  // ─── 5. Self-target ─────────────────────────────────────────────────────────────────────

  it('[4A, was a pinned defect] a manager never acts on their own time; a System-scope override is audited; approvals never', async () => {
    await scenario(
      async (h) => {
        const { fx, svc, tx } = h;
        const self = fx.selfUser1;
        const manager = fx.users.managerA!;
        await work(
          h,
          fx.assignmentTeamA,
          '2027-03-02T09:00',
          '2027-03-02T12:00',
        );
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        h.clock.value = toronto('2027-03-03T09:00');
        const forbidden = async (promise: Promise<unknown>) => {
          const error = await rejection(promise);
          expect(statusOf(error)).toBe(403);
          expect(body(error)).toMatchObject({
            code: 'TIME_SELF_TARGET_FORBIDDEN',
          });
        };
        const correction = {
          type: 'CHANGE_CLOCK_OUT' as const,
          clockOutAt: '2027-03-02T18:00',
          reason: 'Self',
        };
        const manual = {
          employmentAssignmentId: fx.assignmentTeamA,
          startAt: '2027-03-01T09:00',
          endAt: '2027-03-01T17:00',
          reason: 'Self',
        };
        await forbidden(
          svc.time.correctEntry(self, entry.id, correction, ctx(self)),
        );
        // R4-A.4: a coverage correction is a correction like any other.
        const coverage = {
          type: 'CHANGE_COVERAGE' as const,
          additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
          reason: 'Self',
        };
        await forbidden(
          svc.time.correctEntry(self, entry.id, coverage, ctx(self)),
        );
        // ... and another organization's manager cannot see the entry at all.
        expect([403, 404]).toContain(
          statusOf(
            await rejection(
              svc.time.correctEntry(
                fx.users.managerB!,
                entry.id,
                coverage,
                ctx(fx.users.managerB!),
              ),
            ),
          ),
        );
        await forbidden(
          svc.time.addEntry(self, fx.employee1, manual, ctx(self)),
        );
        await forbidden(
          svc.time.linkScheduledShift(
            self,
            entry.id,
            { scheduledShiftId: null, reason: 'Self' },
            ctx(self),
          ),
        );
        // Another manager may.
        await svc.time.correctEntry(
          manager,
          entry.id,
          correction,
          ctx(manager),
        );

        const sheetId = await weeklySheet(h);
        afterPeriodEnd(h.clock, '2027-03-07');
        await submit(h, sheetId);
        const [segment] = await segmentsOf(h, sheetId);
        await forbidden(
          svc.time.approveTimesheetSegment(
            self,
            segment!.id,
            undefined,
            ctx(self),
          ),
        );
        await forbidden(
          svc.time.requestTimesheetChanges(
            self,
            segment!.id,
            'Self',
            ctx(self),
          ),
        );
        await approveAll(h, sheetId, manager);
        await forbidden(svc.time.lockTimesheet(self, sheetId, ctx(self)));
        await forbidden(
          svc.time.reopenTimesheet(self, sheetId, 'Self', ctx(self)),
        );
        expect(
          await tx.timeAdjustment.count({ where: { actorUserId: self } }),
        ).toBe(0);

        // At System scope the maintenance actions are allowed, and each override is audited.
        await grantSystemOwner(tx, self, [
          'time.correct',
          'time.timesheet.manage',
          'time.timesheet.approve',
        ]);
        await svc.time.lockTimesheet(self, sheetId, ctx(self));
        await svc.time.reopenTimesheet(
          self,
          sheetId,
          'Owner correction',
          ctx(self),
        );
        await svc.time.correctEntry(
          self,
          entry.id,
          { ...correction, clockOutAt: '2027-03-02T13:00' },
          ctx(self),
        );
        expect(
          (
            await tx.auditLog.findMany({
              where: { action: 'TIME_SELF_TARGET_OVERRIDE', actorUserId: self },
              orderBy: { occurredAt: 'asc' },
            })
          ).map((row) => (row.metadata as { action: string }).action),
        ).toEqual([
          'TIMESHEET_LOCK',
          'TIMESHEET_REOPEN',
          'TIME_DIRECT_CORRECTION',
        ]);
        // Approvals never: the System Owner still can't approve their own time.
        await submit(h, sheetId);
        await forbidden(
          svc.time.approveTimesheetSegment(
            self,
            segment!.id,
            undefined,
            ctx(self),
          ),
        );
      },
      LIVE_TIME_POLICY,
      (tx, fx) =>
        grantSelf(tx, fx, [
          'time.correct',
          'time.approve',
          'time.timesheet.approve',
          'time.timesheet.manage',
        ]),
    );
  });

  // ─── Unchanged protections ──────────────────────────────────────────────────────────────

  it('keeps punches immutable and refuses a second CLOCK_OUT punch for an entry', async () => {
    await scenario(async (h) => {
      const { fx, tx } = h;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      const punch = await tx.timePunch.findFirstOrThrow({
        where: { timeEntryId: entry.id, type: 'CLOCK_OUT' },
      });
      expect(
        String(
          await violation(tx, () =>
            tx.timePunch.update({
              where: { id: punch.id },
              data: { occurredAt: toronto('2027-03-02T13:00') },
            }),
          ),
        ),
      ).toContain('immutable');
      // The trigger raises unique_violation (P2002), as a unique index would.
      expect(
        (
          (await violation(tx, () =>
            tx.timePunch.create({
              data: {
                employeeId: fx.employee1,
                employmentAssignmentId: fx.assignmentTeamA,
                timeEntryId: entry.id,
                type: 'CLOCK_OUT',
                occurredAt: toronto('2027-03-02T13:00'),
                timezone: 'America/Toronto',
              },
            }),
          )) as { code?: string }
        ).code,
      ).toBe('P2002');
    });
  });

  it('still refuses self-service clocking under kiosk-only capture', async () => {
    await scenario(
      async (h) => {
        const { fx, svc, tx } = h;
        h.clock.value = toronto('2027-03-02T09:00');
        const error = await rejection(
          svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1)),
        );
        expect(statusOf(error)).toBe(403);
        expect(
          await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(0);
      },
      {
        clock: { mode: 'LIVE_CLOCK' },
        attendance: { captureMode: 'KIOSK_ONLY' },
      },
    );
  });
});
