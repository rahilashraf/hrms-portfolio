import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../src/database/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { SchedulingDomainService } from '../src/scheduling/scheduling-domain.service.js';
import { SchedulingService } from '../src/scheduling/scheduling.service.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type Tx = Prisma.TransactionClient;

interface ConflictBody {
  code: string;
  conflicts?: Array<{ key: string; type: string; severity: string }>;
  shifts?: Array<{
    shiftId: string;
    conflicts: Array<{ key: string; type: string; severity: string }>;
  }>;
  invalidShifts?: Array<{ shiftId: string; message: string }>;
}

/**
 * One Employee with two concurrent assignments in different branches (Team A under Dept A,
 * and Dept B), plus a second Employee on Team A.
 */
interface Fixtures {
  orgA: string;
  orgB: string;
  deptA: string;
  deptB: string;
  employee: string;
  assignmentTeamA: string;
  assignmentDeptB: string;
  otherEmployeeTeamA: string;
  workLocationToronto: string;
  users: {
    publisher: string;
    managerNoPublish: string;
    publishNoManage: string;
    publisherNoOverride: string;
    deptBPublisher: string;
    deptAReader: string;
    orgBPublisher: string;
  };
}

const CORRELATION = 'scheduling-publication-db-spec';
const ctx = (actorUserId: string) => ({
  actorUserId,
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
  correlationId: CORRELATION,
});
const WEEK = { periodStart: '2026-10-05', periodEnd: '2026-10-11' };
const PERMISSIONS = [
  'schedule.read',
  'schedule.manage',
  'schedule.override_conflict',
  'schedule.publish',
] as const;
/** The expected-work fields a revision snapshot must reproduce exactly. */
const SNAPSHOT_FIELDS = [
  'employmentAssignmentId',
  'workLocationId',
  'workDate',
  'startsAt',
  'endsAt',
  'timezone',
  'status',
  'sourceType',
] as const;

/** Toronto is on EDT (-04:00) throughout the fixture week. */
function shift(
  assignmentId: string,
  workDate: string,
  start: string,
  end: string,
) {
  return {
    employmentAssignmentId: assignmentId,
    timezone: 'America/Toronto',
    workDate,
    startsAt: `${workDate}T${start}:00-04:00`,
    endsAt: `${workDate}T${end}:00-04:00`,
  };
}

function snapshot(row: Record<string, unknown>) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((key) => [key, row[key]]));
}

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('Expected the operation to be rejected.');
    },
    (error: unknown) => error,
  );
}

async function conflictBody(promise: Promise<unknown>) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as ConflictBody;
}

describe('Schedule publication and shift revision history (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required.');
    prisma = new PrismaService(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  interface Harness {
    tx: Tx;
    fx: Fixtures;
    service: SchedulingService;
    /** Creates a DRAFT Dept-level Schedule for the fixture week. */
    schedule: (departmentId: string, name?: string) => Promise<string>;
  }

  /** Runs a scenario against real services inside one transaction that is always rolled back. */
  async function scenario(run: (harness: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createFixtures(tx);
          const service = schedulingService(rollbackClient(tx));
          await run({
            tx,
            fx,
            service,
            schedule: (departmentId, name = 'Week 41') =>
              createSchedule(service, fx, departmentId, name),
          });
          throw new RollbackFixtures();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  // ─── Publication ────────────────────────────────────────────────────────────

  describe('publication', () => {
    it('publishes a DRAFT schedule with an exact baseline revision for every shift', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = [
          await service.createShift(
            scheduleId,
            shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
            publisher,
          ),
          await service.createShift(
            scheduleId,
            {
              ...shift(fx.otherEmployeeTeamA, '2026-10-07', '07:00', '15:00'),
              workLocationId: fx.workLocationToronto,
            },
            publisher,
          ),
        ];

        const result = await service.publishSchedule(scheduleId, publisher);
        expect(result).toMatchObject({
          id: scheduleId,
          status: 'PUBLISHED',
          publishedByUserId: fx.users.publisher,
          publishedAt: expect.any(String),
        });
        const stored = await tx.schedule.findUniqueOrThrow({
          where: { id: scheduleId },
        });
        expect(stored.status).toBe('PUBLISHED');
        expect(stored.publishedByUserId).toBe(fx.users.publisher);

        for (const row of created) {
          const { items } = await service.listShiftRevisions(
            fx.users.publisher,
            scheduleId,
            row.id,
          );
          expect(items).toHaveLength(1);
          expect(items[0]).toMatchObject({
            scheduledShiftId: row.id,
            revisionNumber: 1,
            revisionType: 'PUBLISHED_BASELINE',
            reason: null,
            changedByUserId: fx.users.publisher,
            changedAt: stored.publishedAt!.toISOString(),
          });
          // Publication does not change the shifts themselves.
          const current = await service.getShift(
            fx.users.publisher,
            scheduleId,
            row.id,
          );
          expect(current).toEqual(row);
          expect(snapshot(items[0]!)).toEqual(snapshot(current));
        }

        const audit = await tx.auditLog.findMany({
          where: { action: 'SCHEDULE_PUBLISHED', entityId: scheduleId },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorUserId: fx.users.publisher,
          entityType: 'Schedule',
          correlationId: CORRELATION,
          metadata: expect.objectContaining({
            shiftCount: 2,
            baselineRevisionCount: 2,
            schedule: expect.objectContaining({ status: 'PUBLISHED' }),
          }),
        });
      });
    });

    it('requires schedule.manage and schedule.publish within the Schedule scope', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const scheduleId = await schedule(fx.deptA);
        await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          ctx(fx.users.publisher),
        );
        for (const [user, type] of [
          [fx.users.managerNoPublish, ForbiddenException],
          [fx.users.publishNoManage, ForbiddenException],
          [fx.users.deptAReader, ForbiddenException],
          [fx.users.deptBPublisher, NotFoundException],
          [fx.users.orgBPublisher, NotFoundException],
        ] as const) {
          await expect(
            service.publishSchedule(scheduleId, ctx(user)),
          ).rejects.toBeInstanceOf(type);
        }
        await expectStillDraft(tx, scheduleId);
      });
    });

    it('cannot publish twice or create duplicate baselines', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.publishSchedule(scheduleId, publisher);
        await expect(
          service.publishSchedule(scheduleId, publisher),
        ).rejects.toThrow('Only DRAFT schedules can be published.');
        expect(
          await tx.scheduledShiftRevision.count({
            where: { scheduledShiftId: created.id },
          }),
        ).toBe(1);
        expect(
          await tx.auditLog.count({
            where: { action: 'SCHEDULE_PUBLISHED', entityId: scheduleId },
          }),
        ).toBe(1);
      });
    });

    it('rejects publishing an empty schedule', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const scheduleId = await schedule(fx.deptA);
        const body = await conflictBody(
          service.publishSchedule(scheduleId, ctx(fx.users.publisher)),
        );
        expect(body.code).toBe('SCHEDULE_PUBLICATION_EMPTY');
        await expectStillDraft(tx, scheduleId);
      });
    });

    it('re-validates every shift against current data and never fixes it silently', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const ended = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-09', '09:00', '17:00'),
          publisher,
        );
        const moved = await service.createShift(
          scheduleId,
          {
            ...shift(fx.otherEmployeeTeamA, '2026-10-06', '09:00', '17:00'),
            workLocationId: fx.workLocationToronto,
          },
          publisher,
        );
        const fine = await service.createShift(
          scheduleId,
          shift(fx.otherEmployeeTeamA, '2026-10-07', '09:00', '17:00'),
          publisher,
        );
        // Employment and organizational data changed after the shifts were drafted.
        await tx.employmentAssignment.update({
          where: { id: fx.assignmentTeamA },
          data: { endDate: new Date('2026-10-08T00:00:00.000Z') },
        });
        await tx.workLocation.update({
          where: { id: fx.workLocationToronto },
          data: { timezone: 'America/Vancouver' },
        });

        const body = await conflictBody(
          service.publishSchedule(scheduleId, publisher),
        );
        expect(body.code).toBe('SCHEDULE_PUBLICATION_INVALID');
        expect(body.invalidShifts!.map((row) => row.shiftId).sort()).toEqual(
          [ended.id, moved.id].sort(),
        );
        expect(body.invalidShifts!.map((row) => row.shiftId)).not.toContain(
          fine.id,
        );
        await expectStillDraft(tx, scheduleId);
        // The stored shifts were left exactly as they were.
        expect(
          await service.getShift(fx.users.publisher, scheduleId, moved.id),
        ).toEqual(moved);

        await tx.workLocation.update({
          where: { id: fx.workLocationToronto },
          data: { timezone: 'America/Toronto', archivedAt: new Date() },
        });
        const archived = await conflictBody(
          service.publishSchedule(scheduleId, publisher),
        );
        expect(archived.invalidShifts!.map((row) => row.message)).toContain(
          'Shifts cannot be scheduled at an archived WorkLocation.',
        );
        await expectStillDraft(tx, scheduleId);
      });
    });

    it('rejects publication when the scope target was archived', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await tx.department.update({
          where: { id: fx.deptA },
          data: { archivedAt: new Date() },
        });
        await expect(
          service.publishSchedule(scheduleId, publisher),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expectStillDraft(tx, scheduleId);
      });
    });

    it('blocks publication on a same-assignment overlap ERROR', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        // Bypasses the API, which would refuse it, to model state that must never publish.
        const other = await schedule(fx.deptA, 'Other draft');
        await tx.scheduledShift.create({
          data: {
            scheduleId: other,
            employmentAssignmentId: fx.assignmentTeamA,
            workDate: new Date('2026-10-06T00:00:00.000Z'),
            startsAt: new Date('2026-10-06T15:00:00.000Z'),
            endsAt: new Date('2026-10-06T23:00:00.000Z'),
            timezone: 'America/Toronto',
          },
        });
        const body = await conflictBody(
          service.publishSchedule(scheduleId, publisher),
        );
        expect(body.code).toBe('SCHEDULE_CONFLICT_ERROR');
        expect(body.shifts).toEqual([
          {
            shiftId: created.id,
            conflicts: [
              expect.objectContaining({
                type: 'SAME_ASSIGNMENT_OVERLAP',
                severity: 'ERROR',
              }),
            ],
          },
        ]);
        await expectStillDraft(tx, scheduleId);
      });
    });

    it('blocks an unresolved or stale employee-wide WARNING and honors a valid persisted override', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const deptA = await schedule(fx.deptA);
        const deptB = await schedule(fx.deptB, 'Dept B week 41');
        const teamShift = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          publisher,
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const [conflict] = (
          await service.previewShiftConflicts(
            fx.users.publisher,
            deptB,
            null,
            candidate,
          )
        ).conflicts;
        const deptBShift = await service.createShift(
          deptB,
          {
            ...candidate,
            conflictOverrides: [
              {
                conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
                conflictKey: conflict!.key,
                reason: 'Approved double coverage',
              },
            ],
          },
          publisher,
        );

        // A persisted override matching the exact current state permits publication, from
        // either side of the pair.
        await service.publishSchedule(deptA, publisher);

        // Make the approval stale: the other side changes outside the approved state.
        await tx.scheduledShift.update({
          where: { id: teamShift.id },
          data: { endsAt: new Date('2026-10-06T17:30:00.000Z') },
        });
        const stale = await conflictBody(
          service.publishSchedule(deptB, publisher),
        );
        expect(stale.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_REQUIRED');
        expect(stale.shifts).toEqual([
          {
            shiftId: deptBShift.id,
            conflicts: [
              expect.objectContaining({
                type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
                severity: 'WARNING',
                overridden: false,
              }),
            ],
          },
        ]);
        await expectStillDraft(tx, deptB);
      });
    });
  });

  // ─── Published mutation boundary ────────────────────────────────────────────

  describe('published mutation boundary', () => {
    it('keeps rejecting Batch 2 draft mutations and hard deletes after publication', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.publishSchedule(scheduleId, publisher);

        for (const attempt of [
          () =>
            service.updateShift(
              scheduleId,
              created.id,
              { endsAt: '2026-10-06T18:00:00-04:00' },
              publisher,
            ),
          () => service.deleteShift(scheduleId, created.id, publisher),
          () =>
            service.createShift(
              scheduleId,
              shift(fx.otherEmployeeTeamA, '2026-10-06', '09:00', '17:00'),
              publisher,
            ),
          () =>
            service.updateSchedule(scheduleId, { name: 'Renamed' }, publisher),
          () =>
            service.updateSchedule(
              scheduleId,
              { periodEnd: '2026-10-12' },
              publisher,
            ),
          () =>
            service.updateSchedule(scheduleId, { type: 'AD_HOC' }, publisher),
          () => service.deleteSchedule(scheduleId, publisher),
          () =>
            service.previewShiftConflicts(
              fx.users.publisher,
              scheduleId,
              created.id,
              { endsAt: '2026-10-06T18:00:00-04:00' },
            ),
        ]) {
          await expect(attempt()).rejects.toBeInstanceOf(ConflictException);
        }
        expect(
          await service.getShift(fx.users.publisher, scheduleId, created.id),
        ).toEqual(created);
        expect(
          await tx.schedule.findUniqueOrThrow({ where: { id: scheduleId } }),
        ).toMatchObject({ name: 'Week 41', type: 'STANDARD' });

        // The revision history makes a hard delete impossible at the database level too.
        expect(
          await violation(tx, () =>
            tx.scheduledShift.delete({ where: { id: created.id } }),
          ),
        ).toMatchObject(FK_VIOLATION);
      });
    });

    it('accepts published workflows only on PUBLISHED schedules', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        for (const attempt of [
          () =>
            service.correctShift(
              scheduleId,
              created.id,
              { reason: 'Fix', endsAt: '2026-10-06T18:00:00-04:00' },
              publisher,
            ),
          () =>
            service.cancelShift(
              scheduleId,
              created.id,
              { reason: 'Closed' },
              publisher,
            ),
          () =>
            service.addPublishedShift(
              scheduleId,
              {
                ...shift(fx.otherEmployeeTeamA, '2026-10-06', '09:00', '17:00'),
                reason: 'Cover',
              },
              publisher,
            ),
        ]) {
          await expect(attempt()).rejects.toBeInstanceOf(ConflictException);
        }
        expect(
          await tx.scheduledShiftRevision.count({
            where: { scheduledShiftId: created.id },
          }),
        ).toBe(0);
      });
    });
  });

  // ─── Correction ─────────────────────────────────────────────────────────────

  describe('correction', () => {
    async function publishedShift(
      { fx, service, schedule }: Harness,
      input = shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
    ) {
      const publisher = ctx(fx.users.publisher);
      const scheduleId = await schedule(fx.deptA);
      const created = await service.createShift(scheduleId, input, publisher);
      await service.publishSchedule(scheduleId, publisher);
      return { scheduleId, created, publisher };
    }

    it('updates the current shift and appends a CORRECTED full-snapshot revision', async () => {
      await scenario(async (harness) => {
        const { tx, fx, service } = harness;
        const { scheduleId, created, publisher } =
          await publishedShift(harness);
        const [baseline] = await tx.scheduledShiftRevision.findMany({
          where: { scheduledShiftId: created.id },
        });

        const result = await service.correctShift(
          scheduleId,
          created.id,
          {
            reason: ' Store opens later ',
            startsAt: '2026-10-06T10:00:00-04:00',
            workLocationId: fx.workLocationToronto,
          },
          publisher,
        );
        const current = await service.getShift(
          fx.users.publisher,
          scheduleId,
          created.id,
        );
        expect(current).toMatchObject({
          startsAt: '2026-10-06T14:00:00.000Z',
          endsAt: created.endsAt,
          workLocationId: fx.workLocationToronto,
          status: 'ACTIVE',
        });
        expect(result.shift).toEqual(current);
        expect(result.revision).toMatchObject({
          revisionNumber: 2,
          revisionType: 'CORRECTED',
          reason: 'Store opens later',
          changedByUserId: fx.users.publisher,
        });
        expect(snapshot(result.revision)).toEqual(snapshot(current));

        // The baseline is immutable history and still describes the published state.
        const [baselineAfter] = await tx.scheduledShiftRevision.findMany({
          where: { scheduledShiftId: created.id, revisionNumber: 1 },
        });
        expect(baselineAfter).toEqual(baseline);
        expect(baselineAfter!.startsAt.toISOString()).toBe(created.startsAt);

        const second = await service.correctShift(
          scheduleId,
          created.id,
          { reason: 'Stay late', endsAt: '2026-10-06T18:00:00-04:00' },
          publisher,
        );
        expect(second.revision.revisionNumber).toBe(3);

        const audit = await tx.auditLog.findMany({
          where: { action: 'SCHEDULED_SHIFT_CORRECTED', entityId: created.id },
          orderBy: { occurredAt: 'asc' },
        });
        expect(audit).toHaveLength(2);
        expect(audit[0]!.metadata).toMatchObject({
          scheduleId,
          reason: 'Store opens later',
          revisionId: result.revision.id,
          revisionNumber: 2,
          changes: {
            startsAt: {
              from: created.startsAt,
              to: '2026-10-06T14:00:00.000Z',
            },
            workLocationId: { from: null, to: fx.workLocationToronto },
          },
          before: expect.objectContaining({ startsAt: created.startsAt }),
          after: expect.objectContaining({
            startsAt: '2026-10-06T14:00:00.000Z',
          }),
        });
      });
    });

    it('requires a reason, a real change, and publish authority', async () => {
      await scenario(async (harness) => {
        const { tx, fx, service } = harness;
        const { scheduleId, created, publisher } =
          await publishedShift(harness);
        await expect(
          service.correctShift(
            scheduleId,
            created.id,
            { reason: '  ', endsAt: '2026-10-06T18:00:00-04:00' },
            publisher,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.correctShift(
            scheduleId,
            created.id,
            { reason: 'Same', endsAt: created.endsAt },
            publisher,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        for (const [user, type] of [
          [fx.users.managerNoPublish, ForbiddenException],
          [fx.users.publishNoManage, ForbiddenException],
          [fx.users.deptAReader, ForbiddenException],
          [fx.users.deptBPublisher, NotFoundException],
        ] as const) {
          await expect(
            service.correctShift(
              scheduleId,
              created.id,
              { reason: 'Fix', endsAt: '2026-10-06T18:00:00-04:00' },
              ctx(user),
            ),
          ).rejects.toBeInstanceOf(type);
        }
        expect(
          await tx.scheduledShiftRevision.count({
            where: { scheduledShiftId: created.id },
          }),
        ).toBe(1);
      });
    });

    it('re-runs period, interval, assignment, WorkLocation, and timezone validation', async () => {
      await scenario(async (harness) => {
        const { tx, fx, service } = harness;
        const { scheduleId, created, publisher } =
          await publishedShift(harness);
        const otherOrgAssignment = await assignmentInOrgB(tx, fx);
        for (const input of [
          {
            workDate: '2026-10-12',
            startsAt: '2026-10-12T09:00:00-04:00',
            endsAt: '2026-10-12T17:00:00-04:00',
          },
          { endsAt: '2026-10-06T08:00:00-04:00' },
          { timezone: 'Mars/Olympus_Mons' },
          { workDate: '2026-10-07' },
        ]) {
          await expect(
            service.correctShift(
              scheduleId,
              created.id,
              { reason: 'Fix', ...input },
              publisher,
            ),
          ).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(
          service.correctShift(
            scheduleId,
            created.id,
            { reason: 'Fix', employmentAssignmentId: otherOrgAssignment },
            publisher,
          ),
        ).rejects.toThrow();

        await tx.workLocation.update({
          where: { id: fx.workLocationToronto },
          data: { archivedAt: new Date() },
        });
        await expect(
          service.correctShift(
            scheduleId,
            created.id,
            { reason: 'Fix', workLocationId: fx.workLocationToronto },
            publisher,
          ),
        ).rejects.toThrow('archived WorkLocation');

        // The assignment ended after publication: any correction is re-validated against it.
        await tx.employmentAssignment.update({
          where: { id: fx.assignmentTeamA },
          data: { endDate: new Date('2026-10-05T00:00:00.000Z') },
        });
        await expect(
          service.correctShift(
            scheduleId,
            created.id,
            { reason: 'Fix', endsAt: '2026-10-06T18:00:00-04:00' },
            publisher,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(
          await service.getShift(fx.users.publisher, scheduleId, created.id),
        ).toEqual(created);
        expect(
          await tx.scheduledShiftRevision.count({
            where: { scheduledShiftId: created.id },
          }),
        ).toBe(1);
      });
    });

    it('applies conflict rules: ERROR blocks, WARNING needs a current, authorized override', async () => {
      await scenario(async (harness) => {
        const { tx, fx, service, schedule } = harness;
        const { scheduleId, created, publisher } =
          await publishedShift(harness);
        const second = await service.addPublishedShift(
          scheduleId,
          {
            ...shift(fx.assignmentTeamA, '2026-10-06', '18:00', '22:00'),
            reason: 'Evening cover',
          },
          publisher,
        );
        const sameAssignment = await conflictBody(
          service.correctShift(
            scheduleId,
            second.shift.id,
            { reason: 'Earlier', startsAt: '2026-10-06T16:00:00-04:00' },
            publisher,
          ),
        );
        expect(sameAssignment.code).toBe('SCHEDULE_CONFLICT_ERROR');

        const deptB = await schedule(fx.deptB, 'Dept B');
        await service.createShift(
          deptB,
          shift(fx.assignmentDeptB, '2026-10-06', '05:00', '08:00'),
          publisher,
        );
        const correction = {
          reason: 'Start early',
          startsAt: '2026-10-06T07:00:00-04:00',
        };
        const required = await conflictBody(
          service.correctShift(scheduleId, created.id, correction, publisher),
        );
        expect(required.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_REQUIRED');
        const approval = {
          conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP' as const,
          conflictKey: required.conflicts![0]!.key,
          reason: 'Approved early overlap',
        };

        const stale = await conflictBody(
          service.correctShift(
            scheduleId,
            created.id,
            {
              ...correction,
              startsAt: '2026-10-06T06:30:00-04:00',
              conflictOverrides: [approval],
            },
            publisher,
          ),
        );
        expect(stale.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_STALE');
        await expect(
          service.correctShift(
            scheduleId,
            created.id,
            { ...correction, conflictOverrides: [approval] },
            ctx(fx.users.publisherNoOverride),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        const result = await service.correctShift(
          scheduleId,
          created.id,
          { ...correction, conflictOverrides: [approval] },
          publisher,
        );
        expect(result.revision).toMatchObject({
          revisionNumber: 2,
          revisionType: 'CORRECTED',
        });
        const overrides = await tx.scheduleConflictOverride.findMany({
          where: { scheduledShiftId: created.id },
        });
        expect(overrides).toEqual([
          expect.objectContaining({
            conflictKey: approval.conflictKey,
            reason: 'Approved early overlap',
            overriddenByUserId: fx.users.publisher,
          }),
        ]);
        expect(
          await tx.auditLog.count({
            where: {
              action: 'SCHEDULE_CONFLICT_OVERRIDDEN',
              entityId: created.id,
            },
          }),
        ).toBe(1);

        // A later correction makes that approval stale, but keeps it as history.
        const moved = await conflictBody(
          service.correctShift(
            scheduleId,
            created.id,
            { reason: 'Earlier still', startsAt: '2026-10-06T06:45:00-04:00' },
            publisher,
          ),
        );
        expect(moved.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_REQUIRED');
        await service.correctShift(
          scheduleId,
          created.id,
          { reason: 'No overlap', startsAt: '2026-10-06T09:00:00-04:00' },
          publisher,
        );
        expect(
          await tx.scheduleConflictOverride.count({
            where: { scheduledShiftId: created.id },
          }),
        ).toBe(1);
      });
    });

    it('does not correct a CANCELLED shift', async () => {
      await scenario(async (harness) => {
        const { tx, service } = harness;
        const { scheduleId, created, publisher } =
          await publishedShift(harness);
        await service.cancelShift(
          scheduleId,
          created.id,
          { reason: 'Closed' },
          publisher,
        );
        await expect(
          service.correctShift(
            scheduleId,
            created.id,
            { reason: 'Reopen', endsAt: '2026-10-06T18:00:00-04:00' },
            publisher,
          ),
        ).rejects.toThrow('CANCELLED shift is final');
        expect(
          await tx.scheduledShiftRevision.count({
            where: { scheduledShiftId: created.id },
          }),
        ).toBe(2);
      });
    });
  });

  // ─── Cancellation ───────────────────────────────────────────────────────────

  describe('cancellation', () => {
    it('cancels once with a CANCELLED revision and is idempotent afterwards', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.publishSchedule(scheduleId, publisher);

        await expect(
          service.cancelShift(
            scheduleId,
            created.id,
            { reason: ' ' },
            publisher,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.cancelShift(
            scheduleId,
            created.id,
            { reason: 'Closed' },
            ctx(fx.users.managerNoPublish),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        const first = await service.cancelShift(
          scheduleId,
          created.id,
          { reason: 'Store closed' },
          publisher,
        );
        expect(first.shift.status).toBe('CANCELLED');
        expect(first.revision).toMatchObject({
          revisionNumber: 2,
          revisionType: 'CANCELLED',
          status: 'CANCELLED',
          reason: 'Store closed',
        });
        expect(snapshot(first.revision!)).toEqual(snapshot(first.shift));

        const again = await service.cancelShift(
          scheduleId,
          created.id,
          { reason: 'Store closed again' },
          publisher,
        );
        expect(again).toEqual(first);
        expect(
          await tx.scheduledShiftRevision.count({
            where: { scheduledShiftId: created.id },
          }),
        ).toBe(2);
        const audit = await tx.auditLog.findMany({
          where: { action: 'SCHEDULED_SHIFT_CANCELLED', entityId: created.id },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]!.metadata).toMatchObject({
          reason: 'Store closed',
          revisionId: first.revision!.id,
          revisionNumber: 2,
        });

        // The row still exists: cancellation is never a hard delete.
        await expect(
          service.deleteShift(scheduleId, created.id, publisher),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          tx.scheduledShift.findUnique({ where: { id: created.id } }),
        ).resolves.toMatchObject({ status: 'CANCELLED' });
      });
    });

    it('removes a cancelled shift from later conflict evaluation', async () => {
      await scenario(async ({ fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.publishSchedule(scheduleId, publisher);
        const replacement = shift(
          fx.assignmentTeamA,
          '2026-10-06',
          '10:00',
          '18:00',
        );
        const before = await conflictBody(
          service.addPublishedShift(
            scheduleId,
            { ...replacement, reason: 'Replacement' },
            publisher,
          ),
        );
        expect(before.code).toBe('SCHEDULE_CONFLICT_ERROR');

        await service.cancelShift(
          scheduleId,
          created.id,
          { reason: 'Replaced' },
          publisher,
        );
        await expect(
          service.addPublishedShift(
            scheduleId,
            { ...replacement, reason: 'Replacement' },
            publisher,
          ),
        ).resolves.toMatchObject({
          revision: { revisionNumber: 1, revisionType: 'PUBLISHED_BASELINE' },
        });
      });
    });
  });

  // ─── Post-publication addition ──────────────────────────────────────────────

  describe('post-publication addition', () => {
    it('adds an operational shift with a reasoned baseline and full validation', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.publishSchedule(scheduleId, publisher);

        await expect(
          service.addPublishedShift(
            scheduleId,
            {
              ...shift(fx.otherEmployeeTeamA, '2026-10-12', '09:00', '17:00'),
              reason: 'Outside period',
            },
            publisher,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.addPublishedShift(
            scheduleId,
            {
              ...shift(fx.otherEmployeeTeamA, '2026-10-07', '09:00', '17:00'),
              reason: 'Cover',
            },
            ctx(fx.users.managerNoPublish),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        const added = await service.addPublishedShift(
          scheduleId,
          {
            ...shift(fx.otherEmployeeTeamA, '2026-10-07', '09:00', '17:00'),
            reason: 'Extra coverage',
          },
          publisher,
        );
        expect(added.shift).toMatchObject({
          scheduleId,
          status: 'ACTIVE',
          sourceType: 'MANUAL',
        });
        expect(added.revision).toMatchObject({
          revisionNumber: 1,
          revisionType: 'PUBLISHED_BASELINE',
          reason: 'Extra coverage',
        });
        expect(snapshot(added.revision)).toEqual(snapshot(added.shift));
        await expect(
          tx.auditLog.findFirst({
            where: {
              action: 'SCHEDULED_SHIFT_ADDED',
              entityId: added.shift.id,
            },
          }),
        ).resolves.toMatchObject({
          metadata: expect.objectContaining({
            reason: 'Extra coverage',
            revisionNumber: 1,
          }),
        });
        const correction = await service.correctShift(
          scheduleId,
          added.shift.id,
          { reason: 'Later', endsAt: '2026-10-07T18:00:00-04:00' },
          publisher,
        );
        expect(correction.revision.revisionNumber).toBe(2);
      });
    });
  });

  // ─── Revision history read ──────────────────────────────────────────────────

  describe('revision history', () => {
    it('reconstructs the exact expected work after every revision', async () => {
      await scenario(async ({ fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.publishSchedule(scheduleId, publisher);
        const states = [
          await service.getShift(fx.users.publisher, scheduleId, created.id),
        ];
        for (const correction of [
          { reason: 'Later start', startsAt: '2026-10-06T10:00:00-04:00' },
          {
            reason: 'Moved day',
            workDate: '2026-10-08',
            startsAt: '2026-10-08T08:00:00-04:00',
            endsAt: '2026-10-08T12:00:00-04:00',
            workLocationId: fx.workLocationToronto,
          },
          {
            reason: 'Reassigned',
            employmentAssignmentId: fx.assignmentDeptB,
            workLocationId: null,
          },
        ]) {
          await service.correctShift(
            scheduleId,
            created.id,
            correction,
            publisher,
          );
          states.push(
            await service.getShift(fx.users.publisher, scheduleId, created.id),
          );
        }
        await service.cancelShift(
          scheduleId,
          created.id,
          { reason: 'Not needed' },
          publisher,
        );
        states.push(
          await service.getShift(fx.users.publisher, scheduleId, created.id),
        );

        const { items } = await service.listShiftRevisions(
          fx.users.deptAReader,
          scheduleId,
          created.id,
        );
        expect(items.map((row) => row.revisionNumber)).toEqual([1, 2, 3, 4, 5]);
        expect(items.map((row) => row.revisionType)).toEqual([
          'PUBLISHED_BASELINE',
          'CORRECTED',
          'CORRECTED',
          'CORRECTED',
          'CANCELLED',
        ]);
        // "What was the expected shift after revision N?" is the revision itself.
        items.forEach((revision, index) => {
          expect(snapshot(revision)).toEqual(snapshot(states[index]!));
        });
        expect(items[3]).toMatchObject({
          employmentAssignmentId: fx.assignmentDeptB,
          workLocationId: null,
          workDate: '2026-10-08',
          startsAt: '2026-10-08T12:00:00.000Z',
        });
      });
    });

    it('requires schedule.read in the Schedule scope', async () => {
      await scenario(async ({ fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        // Draft shifts have no published history yet.
        await expect(
          service.listShiftRevisions(
            fx.users.publisher,
            scheduleId,
            created.id,
          ),
        ).resolves.toEqual({ items: [] });
        await service.publishSchedule(scheduleId, publisher);
        for (const user of [fx.users.deptBPublisher, fx.users.orgBPublisher]) {
          await expect(
            service.listShiftRevisions(user, scheduleId, created.id),
          ).rejects.toBeInstanceOf(NotFoundException);
        }
        await expect(
          service.listShiftRevisions(
            fx.users.deptAReader,
            scheduleId,
            randomUUID(),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  // ─── Database integrity ─────────────────────────────────────────────────────

  describe('ScheduledShiftRevision constraints', () => {
    it('enforces numbering, reasons, status shape, interval, and references', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.publishSchedule(scheduleId, publisher);
        const base = {
          scheduledShiftId: created.id,
          employmentAssignmentId: fx.assignmentTeamA,
          workDate: new Date('2026-10-06T00:00:00.000Z'),
          startsAt: new Date('2026-10-06T13:00:00.000Z'),
          endsAt: new Date('2026-10-06T21:00:00.000Z'),
          timezone: 'America/Toronto',
          status: 'ACTIVE' as const,
          sourceType: 'MANUAL' as const,
          changedByUserId: fx.users.publisher,
        };
        const corrected = {
          ...base,
          revisionNumber: 2,
          revisionType: 'CORRECTED' as const,
          reason: 'Fix',
        };

        // A duplicate baseline or revision number is impossible.
        expect(
          await violation(tx, () =>
            tx.scheduledShiftRevision.create({
              data: {
                ...base,
                revisionNumber: 1,
                revisionType: 'PUBLISHED_BASELINE',
              },
            }),
          ),
        ).toMatchObject({ code: 'P2002' });
        for (const bad of [
          { revisionNumber: 0 },
          { revisionNumber: -1 },
          { revisionType: 'PUBLISHED_BASELINE' as const },
          { revisionNumber: 1 },
          { reason: null },
          { reason: '   ' },
          { status: 'CANCELLED' as const },
          { revisionType: 'CANCELLED' as const },
          { endsAt: base.startsAt },
          { timezone: ' ' },
        ]) {
          expect(
            await violation(tx, () =>
              tx.scheduledShiftRevision.create({
                data: { ...corrected, ...bad },
              }),
            ),
          ).toMatchObject(CHECK_VIOLATION);
        }
        expect(
          await violation(tx, () =>
            tx.scheduledShiftRevision.create({
              data: { ...corrected, changedByUserId: randomUUID() },
            }),
          ),
        ).toMatchObject(FK_VIOLATION);

        // Cancellation is final: a shift has at most one CANCELLED revision.
        const cancelled = {
          ...base,
          revisionType: 'CANCELLED' as const,
          status: 'CANCELLED' as const,
          reason: 'Closed',
        };
        await tx.scheduledShiftRevision.create({
          data: { ...cancelled, revisionNumber: 2 },
        });
        expect(
          await violation(tx, () =>
            tx.scheduledShiftRevision.create({
              data: { ...cancelled, revisionNumber: 3 },
            }),
          ),
        ).toMatchObject({ code: 'P2002' });
      });
    });
  });

  // ─── Regression ─────────────────────────────────────────────────────────────

  describe('Batch 2–3 regression', () => {
    it('keeps draft CRUD and draft conflicts unchanged and never records revisions for drafts', async () => {
      await scenario(async ({ tx, fx, service, schedule }) => {
        const publisher = ctx(fx.users.publisher);
        const scheduleId = await schedule(fx.deptA);
        const created = await service.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          publisher,
        );
        await service.updateShift(
          scheduleId,
          created.id,
          { endsAt: '2026-10-06T18:00:00-04:00' },
          publisher,
        );
        const body = await conflictBody(
          service.createShift(
            scheduleId,
            shift(fx.assignmentTeamA, '2026-10-06', '12:00', '14:00'),
            publisher,
          ),
        );
        expect(body.code).toBe('SCHEDULE_CONFLICT_ERROR');
        await service.deleteShift(scheduleId, created.id, publisher);
        await service.updateSchedule(
          scheduleId,
          { name: 'Renamed' },
          publisher,
        );
        await service.deleteSchedule(scheduleId, publisher);
        expect(
          await tx.scheduledShiftRevision.count({
            where: { changedByUserId: fx.users.publisher },
          }),
        ).toBe(0);
      });
    });
  });

  // ─── Concurrency (committed data, real concurrent transactions) ─────────────

  describe('concurrency', () => {
    let fx: Fixtures;
    const scheduleIds: string[] = [];

    beforeAll(async () => {
      fx = await prisma.$transaction((tx) => createFixtures(tx), {
        timeout: 30_000,
      });
    });

    afterAll(async () => {
      if (fx) await cleanupFixtures(prisma, fx, scheduleIds);
    });

    async function committedSchedule(name: string) {
      const id = await createSchedule(
        schedulingService(prisma),
        fx,
        fx.deptA,
        name,
      );
      scheduleIds.push(id);
      return id;
    }

    /** Each request pauses after its shift queries, widening the race window. */
    function racingService(pauseMs = 250) {
      const client = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property === '$transaction') {
            return (run: (tx: Tx) => Promise<unknown>) =>
              target.$transaction((tx) => run(pausingTx(tx, pauseMs)), {
                timeout: 20_000,
              });
          }
          return Reflect.get(target, property, receiver);
        },
      }) as unknown as PrismaService;
      return schedulingService(client);
    }

    async function settle(...operations: Promise<unknown>[]) {
      const results = await Promise.allSettled(operations);
      return {
        fulfilled: results.filter((r) => r.status === 'fulfilled').length,
        rejected: results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason as unknown),
      };
    }

    async function revisions(shiftId: string) {
      return prisma.scheduledShiftRevision.findMany({
        where: { scheduledShiftId: shiftId },
        orderBy: { revisionNumber: 'asc' },
      });
    }

    it('publishes a schedule only once under concurrent publish requests', async () => {
      const admin = ctx(fx.users.publisher);
      const scheduleId = await committedSchedule('Concurrent publish');
      const plain = schedulingService(prisma);
      const created = [
        await plain.createShift(
          scheduleId,
          shift(fx.assignmentTeamA, '2026-10-05', '09:00', '17:00'),
          admin,
        ),
        await plain.createShift(
          scheduleId,
          shift(fx.otherEmployeeTeamA, '2026-10-05', '09:00', '17:00'),
          admin,
        ),
      ];
      const service = racingService();
      const { fulfilled, rejected } = await settle(
        service.publishSchedule(scheduleId, admin),
        service.publishSchedule(scheduleId, admin),
      );
      expect(fulfilled).toBe(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toBeInstanceOf(ConflictException);
      for (const row of created) {
        expect((await revisions(row.id)).map((r) => r.revisionNumber)).toEqual([
          1,
        ]);
      }
      expect(
        await prisma.auditLog.count({
          where: { action: 'SCHEDULE_PUBLISHED', entityId: scheduleId },
        }),
      ).toBe(1);
    });

    it('never leaves a partially published schedule when publication races a draft change', async () => {
      const admin = ctx(fx.users.publisher);
      const scheduleId = await committedSchedule('Publish vs draft');
      await schedulingService(prisma).createShift(
        scheduleId,
        shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
        admin,
      );
      const service = racingService();
      await settle(
        service.publishSchedule(scheduleId, admin),
        service.createShift(
          scheduleId,
          shift(fx.otherEmployeeTeamA, '2026-10-06', '09:00', '17:00'),
          admin,
        ),
      );
      const stored = await prisma.schedule.findUniqueOrThrow({
        where: { id: scheduleId },
      });
      expect(stored.status).toBe('PUBLISHED');
      // Whichever won, every shift in the published schedule has exactly its baseline.
      const shifts = await prisma.scheduledShift.findMany({
        where: { scheduleId },
      });
      for (const row of shifts) {
        expect((await revisions(row.id)).map((r) => r.revisionType)).toEqual([
          'PUBLISHED_BASELINE',
        ]);
      }
    });

    it('rolls publication back completely when a baseline cannot be written', async () => {
      const admin = ctx(fx.users.publisher);
      const scheduleId = await committedSchedule('Atomic publish');
      const created = await schedulingService(prisma).createShift(
        scheduleId,
        shift(fx.assignmentTeamA, '2026-10-07', '09:00', '17:00'),
        admin,
      );
      const failing = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property === '$transaction') {
            return (run: (tx: Tx) => Promise<unknown>) =>
              target.$transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(inner, key, innerReceiver) {
                      if (key === 'scheduledShiftRevision') {
                        return {
                          createMany: () =>
                            Promise.reject(new Error('baseline write failed')),
                        };
                      }
                      return Reflect.get(inner, key, innerReceiver);
                    },
                  }),
                ),
              );
          }
          return Reflect.get(target, property, receiver);
        },
      }) as unknown as PrismaService;
      await expect(
        schedulingService(failing).publishSchedule(scheduleId, admin),
      ).rejects.toThrow('baseline write failed');
      await expect(
        prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } }),
      ).resolves.toMatchObject({
        status: 'DRAFT',
        publishedAt: null,
        publishedByUserId: null,
      });
      expect(await revisions(created.id)).toEqual([]);
      expect(
        await prisma.auditLog.count({
          where: { action: 'SCHEDULE_PUBLISHED', entityId: scheduleId },
        }),
      ).toBe(0);
    });

    it('serializes concurrent corrections without duplicate revision numbers', async () => {
      const admin = ctx(fx.users.publisher);
      const scheduleId = await committedSchedule('Concurrent corrections');
      const plain = schedulingService(prisma);
      const created = await plain.createShift(
        scheduleId,
        shift(fx.assignmentTeamA, '2026-10-08', '09:00', '17:00'),
        admin,
      );
      await plain.publishSchedule(scheduleId, admin);
      const service = racingService();
      const { fulfilled, rejected } = await settle(
        service.correctShift(
          scheduleId,
          created.id,
          { reason: 'A', endsAt: '2026-10-08T18:00:00-04:00' },
          admin,
        ),
        service.correctShift(
          scheduleId,
          created.id,
          { reason: 'B', startsAt: '2026-10-08T08:00:00-04:00' },
          admin,
        ),
        service.correctShift(
          scheduleId,
          created.id,
          { reason: 'C', workLocationId: fx.workLocationToronto },
          admin,
        ),
      );
      expect(rejected).toEqual([]);
      expect(fulfilled).toBe(3);
      const history = await revisions(created.id);
      expect(history.map((r) => r.revisionNumber)).toEqual([1, 2, 3, 4]);
      // Serialized: every correction builds on the previous one, so nothing is lost.
      const current = await prisma.scheduledShift.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(current).toMatchObject({
        startsAt: new Date('2026-10-08T12:00:00.000Z'),
        endsAt: new Date('2026-10-08T22:00:00.000Z'),
        workLocationId: fx.workLocationToronto,
      });
      expect(snapshot(history.at(-1)!)).toEqual(snapshot(current));
    });

    it('resolves a correction racing a cancellation deterministically', async () => {
      const admin = ctx(fx.users.publisher);
      const scheduleId = await committedSchedule('Correct vs cancel');
      const plain = schedulingService(prisma);
      const created = await plain.createShift(
        scheduleId,
        shift(fx.assignmentTeamA, '2026-10-09', '09:00', '17:00'),
        admin,
      );
      await plain.publishSchedule(scheduleId, admin);
      const service = racingService();
      const { rejected } = await settle(
        service.correctShift(
          scheduleId,
          created.id,
          { reason: 'Later', endsAt: '2026-10-09T18:00:00-04:00' },
          admin,
        ),
        service.cancelShift(scheduleId, created.id, { reason: 'Off' }, admin),
        service.cancelShift(scheduleId, created.id, { reason: 'Off' }, admin),
      );
      const history = await revisions(created.id);
      const types = history.map((r) => r.revisionType);
      // Either the correction landed first, or it was refused after the cancellation.
      expect([
        ['PUBLISHED_BASELINE', 'CORRECTED', 'CANCELLED'],
        ['PUBLISHED_BASELINE', 'CANCELLED'],
      ]).toContainEqual(types);
      expect(rejected).toHaveLength(types.length === 2 ? 1 : 0);
      expect(history.map((r) => r.revisionNumber)).toEqual(
        types.map((_, index) => index + 1),
      );
      const current = await prisma.scheduledShift.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(current.status).toBe('CANCELLED');
      expect(snapshot(history.at(-1)!)).toEqual(snapshot(current));
    });
  });
});

const CHECK_VIOLATION = { code: expect.stringMatching(/^P(2004|2010|2039)$/) };
const FK_VIOLATION = { code: expect.stringMatching(/^P(2003|2010)$/) };

/** Each violation runs in a savepoint so the scenario transaction stays usable. */
async function violation(tx: Tx, run: () => Promise<unknown>) {
  await tx.$executeRawUnsafe('SAVEPOINT revision_check');
  const error = await rejection(run());
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT revision_check');
  return error;
}

async function expectStillDraft(tx: Tx, scheduleId: string) {
  await expect(
    tx.schedule.findUniqueOrThrow({ where: { id: scheduleId } }),
  ).resolves.toMatchObject({
    status: 'DRAFT',
    publishedAt: null,
    publishedByUserId: null,
  });
  expect(
    await tx.scheduledShiftRevision.count({
      where: { scheduledShift: { scheduleId } },
    }),
  ).toBe(0);
  expect(
    await tx.auditLog.count({
      where: { action: 'SCHEDULE_PUBLISHED', entityId: scheduleId },
    }),
  ).toBe(0);
}

async function createSchedule(
  service: SchedulingService,
  fx: Fixtures,
  departmentId: string,
  name: string,
) {
  return (
    await service.createSchedule(
      {
        scopeType: 'DEPARTMENT',
        organizationId: fx.orgA,
        departmentId,
        name,
        type: 'STANDARD',
        ...WEEK,
      },
      ctx(fx.users.publisher),
    )
  ).id;
}

/** An assignment whose position belongs to Org B, for organization-boundary checks. */
async function assignmentInOrgB(tx: Tx, fx: Fixtures) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const jobTitle = await tx.jobTitle.create({
    data: { organizationId: fx.orgB, name: 'B', code: `PJB-${suffix}` },
  });
  const position = await tx.position.create({
    data: {
      organizationId: fx.orgB,
      jobTitleId: jobTitle.id,
      name: 'B',
      code: `PPB-${suffix}`,
    },
  });
  return (
    await tx.employmentAssignment.create({
      data: {
        employeeId: fx.employee,
        positionId: position.id,
        employmentType: 'PART_TIME',
        status: 'ACTIVE',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    })
  ).id;
}

/** Routes the service's own $transaction calls into the test transaction so it rolls back. */
function rollbackClient(tx: Tx) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (run: (client: Tx) => Promise<unknown>) => run(tx);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as PrismaService;
}

/** Delays every shift query result so concurrent requests overlap inside the race window. */
function pausingTx(tx: Tx, pauseMs: number): Tx {
  const shifts = new Proxy(tx.scheduledShift, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        (property !== 'findMany' && property !== 'findFirst') ||
        typeof value !== 'function'
      ) {
        return value;
      }
      return async (...args: unknown[]) => {
        const result = await (
          value as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
        return result;
      };
    },
  });
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'scheduledShift') return shifts;
      return Reflect.get(target, property, receiver);
    },
  });
}

function schedulingService(prisma: PrismaService) {
  return new SchedulingService(
    prisma,
    new SchedulingDomainService(),
    new AuthorizationService(prisma),
    new PositionAuthorizationTargetResolver(prisma),
    new AuditService(prisma),
  );
}

async function createFixtures(tx: Tx): Promise<Fixtures> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const code = (prefix: string) => `${prefix}-${suffix}`;

  const permissions = Object.fromEntries(
    await Promise.all(
      PERMISSIONS.map(async (key) => [
        key,
        (
          await tx.permission.upsert({
            where: { key },
            create: { key, name: key, isActive: true },
            update: { isActive: true },
          })
        ).id,
      ]),
    ),
  ) as Record<(typeof PERMISSIONS)[number], string>;

  const orgA = await tx.organization.create({
    data: { name: 'Publication Org A', code: code('PA') },
  });
  const orgB = await tx.organization.create({
    data: { name: 'Publication Org B', code: code('PB') },
  });
  const unitA = await tx.organizationalUnit.create({
    data: { organizationId: orgA.id, name: 'Unit A', code: code('UA') },
  });
  const unitB = await tx.organizationalUnit.create({
    data: { organizationId: orgA.id, name: 'Unit B', code: code('UB') },
  });
  const deptA = await tx.department.create({
    data: {
      organizationId: orgA.id,
      organizationalUnitId: unitA.id,
      name: 'Dept A',
      code: code('DA'),
    },
  });
  const deptB = await tx.department.create({
    data: {
      organizationId: orgA.id,
      organizationalUnitId: unitB.id,
      name: 'Dept B',
      code: code('DB'),
    },
  });
  const teamA = await tx.team.create({
    data: {
      organizationId: orgA.id,
      departmentId: deptA.id,
      name: 'Team A',
      code: code('TA'),
    },
  });
  const jobTitle = await tx.jobTitle.create({
    data: { organizationId: orgA.id, name: 'Associate', code: code('JA') },
  });
  const positionTeamA = await tx.position.create({
    data: {
      organizationId: orgA.id,
      jobTitleId: jobTitle.id,
      organizationalUnitId: unitA.id,
      departmentId: deptA.id,
      teamId: teamA.id,
      name: 'Team A Associate',
      code: code('PTA'),
    },
  });
  const positionDeptB = await tx.position.create({
    data: {
      organizationId: orgA.id,
      jobTitleId: jobTitle.id,
      organizationalUnitId: unitB.id,
      departmentId: deptB.id,
      name: 'Dept B Associate',
      code: code('PDB'),
    },
  });
  const workLocation = await tx.workLocation.create({
    data: {
      organizationId: orgA.id,
      name: 'Toronto',
      code: code('WTO'),
      timezone: 'America/Toronto',
    },
  });

  let employeeIndex = 0;
  const employee = async () => {
    employeeIndex += 1;
    const person = await tx.person.create({ data: {} });
    return tx.employee.create({
      data: {
        personId: person.id,
        employeeNumber: code(`PE${employeeIndex}`),
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
  };
  const assignment = async (
    employeeId: string,
    positionId: string,
    isPrimary: boolean,
  ) =>
    (
      await tx.employmentAssignment.create({
        data: {
          employeeId,
          positionId,
          employmentType: isPrimary ? 'FULL_TIME' : 'PART_TIME',
          status: 'ACTIVE',
          isPrimary,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      })
    ).id;
  const shared = await employee();
  const other = await employee();

  const role = async (
    organizationId: string,
    keys: readonly (typeof PERMISSIONS)[number][],
  ) => {
    const created = await tx.role.create({
      data: {
        organizationId,
        code: code(`R${randomUUID().slice(0, 6)}`),
        name: 'Publication role',
      },
    });
    for (const key of keys) {
      await tx.rolePermission.create({
        data: { roleId: created.id, permissionId: permissions[key] },
      });
    }
    return created.id;
  };
  const all = await role(orgA.id, PERMISSIONS);
  const manageOverride = await role(orgA.id, [
    'schedule.manage',
    'schedule.override_conflict',
  ]);
  const readPublish = await role(orgA.id, [
    'schedule.read',
    'schedule.publish',
  ]);
  const managePublish = await role(orgA.id, [
    'schedule.manage',
    'schedule.publish',
  ]);
  const read = await role(orgA.id, ['schedule.read']);
  const allB = await role(orgB.id, PERMISSIONS);

  type Grant = {
    roleId: string;
    organizationId: string;
    scopeType: 'ORGANIZATION' | 'DEPARTMENT';
    departmentId?: string;
  };
  const user = async (label: string, grants: Grant[]) => {
    const person = await tx.person.create({ data: {} });
    const created = await tx.user.create({
      data: {
        personId: person.id,
        email: `publication-${label}-${suffix.toLowerCase()}@example.com`,
        status: 'ACTIVE',
      },
    });
    for (const grant of grants) {
      await tx.roleAssignment.create({
        data: {
          userId: created.id,
          roleId: grant.roleId,
          roleOrganizationId: grant.organizationId,
          scopeType: grant.scopeType,
          organizationId: grant.organizationId,
          departmentId: grant.departmentId,
        },
      });
    }
    return created.id;
  };
  const org = (roleId: string, organizationId = orgA.id): Grant => ({
    roleId,
    organizationId,
    scopeType: 'ORGANIZATION',
  });
  const dept = (roleId: string, departmentId: string): Grant => ({
    roleId,
    organizationId: orgA.id,
    scopeType: 'DEPARTMENT',
    departmentId,
  });

  return {
    orgA: orgA.id,
    orgB: orgB.id,
    deptA: deptA.id,
    deptB: deptB.id,
    employee: shared.id,
    assignmentTeamA: await assignment(shared.id, positionTeamA.id, true),
    assignmentDeptB: await assignment(shared.id, positionDeptB.id, false),
    otherEmployeeTeamA: await assignment(other.id, positionTeamA.id, true),
    workLocationToronto: workLocation.id,
    users: {
      publisher: await user('publisher', [org(all)]),
      managerNoPublish: await user('manager', [org(manageOverride)]),
      publishNoManage: await user('publish-only', [org(readPublish)]),
      publisherNoOverride: await user('no-override', [org(managePublish)]),
      deptBPublisher: await user('dept-b', [dept(all, deptB.id)]),
      deptAReader: await user('dept-a-reader', [dept(read, deptA.id)]),
      orgBPublisher: await user('org-b', [org(allB, orgB.id)]),
    },
  };
}

/** Removes committed concurrency fixtures in foreign-key order. */
async function cleanupFixtures(
  prisma: PrismaService,
  fx: Fixtures,
  scheduleIds: string[],
) {
  const userIds = Object.values(fx.users);
  const organizationIds = [fx.orgA, fx.orgB];
  await prisma.$transaction(async (tx) => {
    const shiftIds = (
      await tx.scheduledShift.findMany({
        where: { scheduleId: { in: scheduleIds } },
        select: { id: true },
      })
    ).map((row) => row.id);
    // Batch R2: audit entries are append-only; test clean-up bypasses the guard (superuser only).
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    // Entries by the fixture users go too: deleting those users would otherwise rewrite the
    // entries' actor (ON DELETE SET NULL), which the guard refuses.
    await tx.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: [...shiftIds, ...scheduleIds] } },
          { actorUserId: { in: userIds } },
        ],
      },
    });
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
    await tx.scheduledShiftRevision.deleteMany({
      where: { scheduledShiftId: { in: shiftIds } },
    });
    await tx.scheduleConflictOverride.deleteMany({
      where: { scheduledShiftId: { in: shiftIds } },
    });
    await tx.scheduledShift.deleteMany({ where: { id: { in: shiftIds } } });
    await tx.schedule.deleteMany({ where: { id: { in: scheduleIds } } });
    const persons = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { personId: true },
    });
    await tx.roleAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    const roles = await tx.role.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { id: true },
    });
    await tx.rolePermission.deleteMany({
      where: { roleId: { in: roles.map((row) => row.id) } },
    });
    await tx.role.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    const assignments = await tx.employmentAssignment.findMany({
      where: { position: { organizationId: fx.orgA } },
      select: { employeeId: true },
    });
    const employeeIds = [...new Set(assignments.map((row) => row.employeeId))];
    const employees = await tx.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { personId: true },
    });
    await tx.employmentAssignment.deleteMany({
      where: { position: { organizationId: fx.orgA } },
    });
    await tx.employee.deleteMany({ where: { id: { in: employeeIds } } });
    await tx.person.deleteMany({
      where: {
        id: {
          in: [...persons, ...employees].map((row) => row.personId),
        },
      },
    });
    await tx.position.deleteMany({ where: { organizationId: fx.orgA } });
    await tx.jobTitle.deleteMany({ where: { organizationId: fx.orgA } });
    await tx.workLocation.deleteMany({ where: { organizationId: fx.orgA } });
    await tx.team.deleteMany({ where: { organizationId: fx.orgA } });
    await tx.department.deleteMany({ where: { organizationId: fx.orgA } });
    await tx.organizationalUnit.deleteMany({
      where: { organizationId: fx.orgA },
    });
    await tx.organization.deleteMany({
      where: { id: { in: organizationIds } },
    });
  });
}
