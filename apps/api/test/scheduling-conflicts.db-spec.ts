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
type ConflictCode =
  | 'SCHEDULE_CONFLICT_ERROR'
  | 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED'
  | 'SCHEDULE_CONFLICT_OVERRIDE_STALE';

interface ConflictBody {
  code: ConflictCode;
  conflicts: Array<{
    key: string;
    type: string;
    severity: string;
    overrideAllowed: boolean;
    overridden: boolean;
    overrideId: string | null;
    employeeId: string;
    employmentAssignmentId: string;
    conflictingShift: {
      id: string;
      scheduleId: string | null;
      employmentAssignmentId: string | null;
      startsAt: string;
      endsAt: string;
    };
  }>;
}

/**
 * One Employee with two concurrent assignments in different branches (Team A under
 * Dept A / Unit A, and Dept B under Unit B), plus a second Employee on Team A.
 */
interface Fixtures {
  suffix: string;
  orgA: string;
  orgB: string;
  deptA: string;
  deptB: string;
  teamA: string;
  employee: string;
  assignmentTeamA: string;
  assignmentDeptB: string;
  otherEmployeeTeamA: string;
  workLocationToronto: string;
  workLocationOttawa: string;
  users: {
    admin: string;
    manageOnly: string;
    deptAOverrider: string;
    deptAManagerOrgOverrider: string;
    overrideOnly: string;
    deptAReader: string;
    orgBAdmin: string;
  };
}

const CORRELATION = 'scheduling-conflicts-db-spec';
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
] as const;

/** Toronto is on EDT (-04:00) throughout the fixture week. */
function shift(
  assignmentId: string,
  workDate: string,
  start: string,
  end: string,
  endDate = workDate,
) {
  return {
    employmentAssignmentId: assignmentId,
    timezone: 'America/Toronto',
    workDate,
    startsAt: `${workDate}T${start}:00-04:00`,
    endsAt: `${endDate}T${end}:00-04:00`,
  };
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

function override(
  conflict: Pick<ConflictBody['conflicts'][number], 'type' | 'key'>,
  reason = 'Approved cross-assignment coverage',
) {
  return {
    conflictType: conflict.type as 'EMPLOYEE_ASSIGNMENT_OVERLAP',
    conflictKey: conflict.key,
    reason,
  };
}

describe('Scheduling conflicts and overrides (database)', () => {
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
    deptA: string;
    deptA2: string;
    deptB: string;
  }

  /** Runs a scenario against real services inside one transaction that is always rolled back. */
  async function scenario(run: (harness: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createFixtures(tx);
          const service = schedulingService(rollbackClient(tx));
          const schedule = (departmentId: string, name: string) =>
            service
              .createSchedule(
                {
                  scopeType: 'DEPARTMENT',
                  organizationId: fx.orgA,
                  departmentId,
                  name,
                  type: 'STANDARD',
                  ...WEEK,
                },
                ctx(fx.users.admin),
              )
              .then((row) => row.id);
          await run({
            tx,
            fx,
            service,
            deptA: await schedule(fx.deptA, 'Dept A week 41'),
            deptA2: await schedule(fx.deptA, 'Dept A ad hoc week 41'),
            deptB: await schedule(fx.deptB, 'Dept B week 41'),
          });
          throw new RollbackFixtures();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  // ─── Same-assignment overlap ────────────────────────────────────────────────

  describe('same-assignment overlap', () => {
    it.each([
      ['exact overlap', '09:00', '17:00'],
      ['partial overlap', '12:00', '20:00'],
      ['containing interval', '08:00', '18:00'],
      ['contained interval', '10:00', '12:00'],
      ['same start', '09:00', '12:00'],
      ['same end', '13:00', '17:00'],
    ])('rejects %s as a hard ERROR', async (_label, start, end) => {
      await scenario(async ({ tx, fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        const existing = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          admin,
        );
        const body = await conflictBody(
          service.createShift(
            deptA,
            shift(fx.assignmentTeamA, '2026-10-06', start, end),
            admin,
          ),
        );
        expect(body.code).toBe('SCHEDULE_CONFLICT_ERROR');
        expect(body.conflicts).toEqual([
          expect.objectContaining({
            type: 'SAME_ASSIGNMENT_OVERLAP',
            severity: 'ERROR',
            overrideAllowed: false,
            employeeId: fx.employee,
            employmentAssignmentId: fx.assignmentTeamA,
            conflictingShift: expect.objectContaining({
              id: existing.id,
              scheduleId: deptA,
            }),
          }),
        ]);
        expect(
          await tx.scheduledShift.count({ where: { scheduleId: deptA } }),
        ).toBe(1);
      });
    });

    it('allows touching intervals and shifts on other dates', async () => {
      await scenario(async ({ tx, fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '08:00', '12:00'),
          admin,
        );
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '12:00', '16:00'),
          admin,
        );
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '05:00', '08:00'),
          admin,
        );
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-07', '08:00', '12:00'),
          admin,
        );
        expect(
          await tx.scheduledShift.count({ where: { scheduleId: deptA } }),
        ).toBe(4);
      });
    });

    it('detects overlap across different Schedule containers', async () => {
      await scenario(async ({ fx, service, deptA, deptA2 }) => {
        const admin = ctx(fx.users.admin);
        const first = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-10', '08:00', '12:00'),
          admin,
        );
        const body = await conflictBody(
          service.createShift(
            deptA2,
            shift(fx.assignmentTeamA, '2026-10-10', '10:00', '14:00'),
            admin,
          ),
        );
        expect(body).toMatchObject({
          code: 'SCHEDULE_CONFLICT_ERROR',
          conflicts: [
            {
              type: 'SAME_ASSIGNMENT_OVERLAP',
              conflictingShift: { id: first.id, scheduleId: deptA },
            },
          ],
        });
      });
    });

    it('checks the merged final state on update and excludes the shift itself', async () => {
      await scenario(async ({ fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        const morning = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '08:00', '12:00'),
          admin,
        );
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '14:00', '18:00'),
          admin,
        );
        // Overlaps only its own previous interval.
        const moved = await service.updateShift(
          deptA,
          morning.id,
          { startsAt: '2026-10-06T09:00:00-04:00' },
          admin,
        );
        expect(moved.startsAt).toBe('2026-10-06T13:00:00.000Z');
        // Only endsAt is sent; merged with the stored startsAt it overlaps the afternoon shift.
        const body = await conflictBody(
          service.updateShift(
            deptA,
            morning.id,
            { endsAt: '2026-10-06T15:00:00-04:00' },
            admin,
          ),
        );
        expect(body.code).toBe('SCHEDULE_CONFLICT_ERROR');
        await expect(
          service.getShift(fx.users.admin, deptA, morning.id),
        ).resolves.toMatchObject({ endsAt: '2026-10-06T16:00:00.000Z' });
      });
    });

    it('rejects an update that moves a shift onto another assignment with overlapping work', async () => {
      await scenario(async ({ fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        await service.createShift(
          deptA,
          shift(fx.otherEmployeeTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const mine = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const body = await conflictBody(
          service.updateShift(
            deptA,
            mine.id,
            { employmentAssignmentId: fx.otherEmployeeTeamA },
            admin,
          ),
        );
        expect(body.conflicts[0]).toMatchObject({
          type: 'SAME_ASSIGNMENT_OVERLAP',
          employmentAssignmentId: fx.otherEmployeeTeamA,
        });
      });
    });

    it('ignores CANCELLED shifts', async () => {
      await scenario(async ({ tx, fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        const existing = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          admin,
        );
        // Batch 4 owns cancellation; simulate a cancelled row directly.
        await tx.scheduledShift.update({
          where: { id: existing.id },
          data: { status: 'CANCELLED' },
        });
        await expect(
          service.createShift(
            deptA,
            shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
            admin,
          ),
        ).resolves.toMatchObject({ status: 'ACTIVE' });
      });
    });

    it('cannot be overridden, even by a fully privileged actor', async () => {
      await scenario(async ({ tx, fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentTeamA,
          '2026-10-06',
          '12:00',
          '20:00',
        );
        const [conflict] = (
          await conflictBody(service.createShift(deptA, candidate, admin))
        ).conflicts;
        const body = await conflictBody(
          service.createShift(
            deptA,
            {
              ...candidate,
              conflictOverrides: [
                {
                  conflictType: 'SAME_ASSIGNMENT_OVERLAP',
                  conflictKey: conflict!.key,
                  reason: 'Please allow it',
                },
              ],
            },
            admin,
          ),
        );
        expect(body.code).toBe('SCHEDULE_CONFLICT_ERROR');
        expect(
          await tx.scheduleConflictOverride.count({
            where: { overriddenByUserId: fx.users.admin },
          }),
        ).toBe(0);
      });
    });

    it('handles overnight shifts by their real instants', async () => {
      await scenario(async ({ fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        await service.createShift(
          deptA,
          shift(
            fx.assignmentTeamA,
            '2026-10-06',
            '22:00',
            '06:00',
            '2026-10-07',
          ),
          admin,
        );
        const body = await conflictBody(
          service.createShift(
            deptA,
            shift(fx.assignmentTeamA, '2026-10-07', '05:00', '09:00'),
            admin,
          ),
        );
        expect(body.code).toBe('SCHEDULE_CONFLICT_ERROR');
        await expect(
          service.createShift(
            deptA,
            shift(fx.assignmentTeamA, '2026-10-07', '06:00', '10:00'),
            admin,
          ),
        ).resolves.toMatchObject({ workDate: '2026-10-07' });
      });
    });
  });

  // ─── Employee-wide overlap ──────────────────────────────────────────────────

  describe('employee-wide overlap', () => {
    it('requires an explicit override for overlapping work on another assignment', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        const teamShift = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const body = await conflictBody(
          service.createShift(
            deptB,
            shift(fx.assignmentDeptB, '2026-10-06', '12:00', '16:00'),
            admin,
          ),
        );
        expect(body).toMatchObject({
          code: 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
          conflicts: [
            {
              type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              severity: 'WARNING',
              overrideAllowed: true,
              overridden: false,
              employeeId: fx.employee,
              employmentAssignmentId: fx.assignmentDeptB,
              conflictingShift: {
                id: teamShift.id,
                scheduleId: deptA,
                employmentAssignmentId: fx.assignmentTeamA,
              },
            },
          ],
        });
        expect(body.conflicts[0]!.key).toMatch(/^[0-9a-f]{64}$/);
        expect(
          await tx.scheduledShift.count({ where: { scheduleId: deptB } }),
        ).toBe(0);
      });
    });

    it('allows non-overlapping work on another assignment and overlapping work for other Employees', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        await service.createShift(
          deptB,
          shift(fx.assignmentDeptB, '2026-10-06', '13:00', '17:00'),
          admin,
        );
        await service.createShift(
          deptA,
          shift(fx.otherEmployeeTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        expect(
          await tx.scheduledShift.count({
            where: { scheduleId: { in: [deptA, deptB] } },
          }),
        ).toBe(3);
      });
    });

    it('accepts an authorized override, persists it, and audits it', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        const teamShift = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const preview = await service.previewShiftConflicts(
          fx.users.admin,
          deptB,
          null,
          candidate,
        );
        expect(preview).toMatchObject({ valid: false, overrideRequired: true });
        const [conflict] = preview.conflicts;

        const created = await service.createShift(
          deptB,
          {
            ...candidate,
            conflictOverrides: [
              override(conflict as never, '  Covering a sick call  '),
            ],
          },
          admin,
        );
        const rows = await tx.scheduleConflictOverride.findMany({
          where: { scheduledShiftId: created.id },
        });
        expect(rows).toEqual([
          expect.objectContaining({
            conflictingShiftId: teamShift.id,
            conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
            conflictKey: conflict!.key,
            reason: 'Covering a sick call',
            overriddenByUserId: fx.users.admin,
            metadata: expect.objectContaining({
              employeeId: fx.employee,
              conflictingShift: expect.objectContaining({
                id: teamShift.id,
                startsAt: '2026-10-06T13:00:00.000Z',
                endsAt: '2026-10-06T17:00:00.000Z',
              }),
              overlap: {
                startsAt: '2026-10-06T16:00:00.000Z',
                endsAt: '2026-10-06T17:00:00.000Z',
              },
            }),
          }),
        ]);
        const audits = await tx.auditLog.findMany({
          where: {
            action: 'SCHEDULE_CONFLICT_OVERRIDDEN',
            entityId: created.id,
          },
        });
        expect(audits).toEqual([
          expect.objectContaining({
            actorUserId: fx.users.admin,
            entityType: 'ScheduledShift',
            correlationId: CORRELATION,
            metadata: expect.objectContaining({
              overrideId: rows[0]!.id,
              conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              conflictingShiftId: teamShift.id,
              reason: 'Covering a sick call',
            }),
          }),
        ]);

        // The persisted override is reported on later evaluations of the same state.
        await expect(
          service.previewShiftConflicts(fx.users.admin, deptB, created.id, {}),
        ).resolves.toMatchObject({
          valid: true,
          conflicts: [{ overridden: true, overrideId: rows[0]!.id }],
        });
      });
    });

    it('rejects an override without schedule.override_conflict', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          ctx(fx.users.admin),
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const actor = ctx(fx.users.manageOnly);
        const [conflict] = (
          await conflictBody(service.createShift(deptB, candidate, actor))
        ).conflicts;
        await expect(
          service.createShift(
            deptB,
            { ...candidate, conflictOverrides: [override(conflict!)] },
            actor,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expectNoOverride(tx, fx);
      });
    });

    it('rejects an override when the actor lacks authority over the conflicting assignment', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        await service.createShift(
          deptB,
          shift(fx.assignmentDeptB, '2026-10-06', '09:00', '13:00'),
          ctx(fx.users.admin),
        );
        const candidate = shift(
          fx.assignmentTeamA,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        for (const actorId of [
          // Manage + override on Dept A only: no rights over Dept B at all.
          fx.users.deptAOverrider,
          // Override organization-wide but manage on Dept A only.
          fx.users.deptAManagerOrgOverrider,
        ]) {
          const actor = ctx(actorId);
          const body = await conflictBody(
            service.createShift(deptA, candidate, actor),
          );
          expect(body.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_REQUIRED');
          await expect(
            service.createShift(
              deptA,
              {
                ...candidate,
                conflictOverrides: [override(body.conflicts[0]!)],
              },
              actor,
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
        }
        await expectNoOverride(tx, fx);
      });
    });

    it('hides the conflicting work context from actors who cannot see it', async () => {
      await scenario(async ({ fx, service, deptA, deptB }) => {
        const other = await service.createShift(
          deptB,
          shift(fx.assignmentDeptB, '2026-10-06', '09:00', '13:00'),
          ctx(fx.users.admin),
        );
        const preview = await service.previewShiftConflicts(
          fx.users.deptAOverrider,
          deptA,
          null,
          shift(fx.assignmentTeamA, '2026-10-06', '12:00', '16:00'),
        );
        expect(preview.conflicts[0]!.conflictingShift).toEqual({
          id: other.id,
          scheduleId: null,
          employmentAssignmentId: null,
          workDate: '2026-10-06',
          startsAt: '2026-10-06T13:00:00.000Z',
          endsAt: '2026-10-06T17:00:00.000Z',
        });
      });
    });

    it('rejects the whole save when an ERROR accompanies an overrideable WARNING', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '11:00'),
          admin,
        );
        await service.createShift(
          deptB,
          shift(fx.assignmentDeptB, '2026-10-06', '12:00', '14:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentTeamA,
          '2026-10-06',
          '10:00',
          '13:00',
        );
        const first = await conflictBody(
          service.createShift(deptA, candidate, admin),
        );
        expect(first.code).toBe('SCHEDULE_CONFLICT_ERROR');
        expect(first.conflicts.map((c) => c.severity)).toEqual([
          'ERROR',
          'WARNING',
        ]);
        const warning = first.conflicts.find((c) => c.severity === 'WARNING')!;
        const second = await conflictBody(
          service.createShift(
            deptA,
            { ...candidate, conflictOverrides: [override(warning)] },
            admin,
          ),
        );
        expect(second.code).toBe('SCHEDULE_CONFLICT_ERROR');
        await expectNoOverride(tx, fx);
      });
    });
  });

  // ─── Override integrity ─────────────────────────────────────────────────────

  describe('override integrity', () => {
    it('rejects invented conflicts and mismatched types', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        // No conflict exists at all.
        const invented = await conflictBody(
          service.createShift(
            deptB,
            {
              ...candidate,
              conflictOverrides: [
                {
                  conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
                  conflictKey: 'e'.repeat(64),
                  reason: 'Trust me',
                },
              ],
            },
            admin,
          ),
        );
        expect(invented).toMatchObject({
          code: 'SCHEDULE_CONFLICT_OVERRIDE_STALE',
          conflicts: [],
        });

        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const [conflict] = (
          await conflictBody(service.createShift(deptB, candidate, admin))
        ).conflicts;
        const mismatched = await conflictBody(
          service.createShift(
            deptB,
            {
              ...candidate,
              conflictOverrides: [
                {
                  conflictType: 'SAME_ASSIGNMENT_OVERLAP' as never,
                  conflictKey: conflict!.key,
                  reason: 'Wrong type',
                },
              ],
            },
            admin,
          ),
        );
        expect(mismatched.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_STALE');
        await expectNoOverride(tx, fx);
      });
    });

    it('rejects a stale override after the conflicting shift changes or the conflict disappears', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        const teamShift = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const [approved] = (
          await service.previewShiftConflicts(
            fx.users.admin,
            deptB,
            null,
            candidate,
          )
        ).conflicts;

        // Still overlapping, but no longer the state that was approved.
        await service.updateShift(
          deptA,
          teamShift.id,
          { endsAt: '2026-10-06T12:30:00-04:00' },
          admin,
        );
        const changed = await conflictBody(
          service.createShift(
            deptB,
            { ...candidate, conflictOverrides: [override(approved as never)] },
            admin,
          ),
        );
        expect(changed.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_STALE');
        expect(changed.conflicts).toHaveLength(1);
        expect(changed.conflicts[0]!.key).not.toBe(approved!.key);

        // The conflict no longer exists at all.
        await service.updateShift(
          deptA,
          teamShift.id,
          { endsAt: '2026-10-06T12:00:00-04:00' },
          admin,
        );
        const gone = await conflictBody(
          service.createShift(
            deptB,
            { ...candidate, conflictOverrides: [override(approved as never)] },
            admin,
          ),
        );
        expect(gone).toMatchObject({
          code: 'SCHEDULE_CONFLICT_OVERRIDE_STALE',
          conflicts: [],
        });
        await expectNoOverride(tx, fx);
      });
    });

    it('requires a reason', async () => {
      await scenario(async ({ fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const [conflict] = (
          await conflictBody(service.createShift(deptB, candidate, admin))
        ).conflicts;
        await expect(
          service.createShift(
            deptB,
            { ...candidate, conflictOverrides: [override(conflict!, '   ')] },
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('ties a recorded override to the exact approved state of both shifts', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        const teamShift = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const [conflict] = (
          await conflictBody(service.createShift(deptB, candidate, admin))
        ).conflicts;
        const deptBShift = await service.createShift(
          deptB,
          { ...candidate, conflictOverrides: [override(conflict!)] },
          admin,
        );

        // Changes that keep the approved overlap state need no new override, from either side.
        await expect(
          service.updateShift(
            deptB,
            deptBShift.id,
            { workLocationId: fx.workLocationToronto },
            admin,
          ),
        ).resolves.toMatchObject({ workLocationId: fx.workLocationToronto });
        await expect(
          service.updateShift(
            deptA,
            teamShift.id,
            { workLocationId: fx.workLocationToronto },
            admin,
          ),
        ).resolves.toMatchObject({ workLocationId: fx.workLocationToronto });

        // A different overlap state needs a new, explicit approval.
        const moved = await conflictBody(
          service.updateShift(
            deptB,
            deptBShift.id,
            { endsAt: '2026-10-06T17:00:00-04:00' },
            admin,
          ),
        );
        expect(moved).toMatchObject({
          code: 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
          conflicts: [{ overridden: false, overrideId: null }],
        });
        const otherSide = await conflictBody(
          service.updateShift(
            deptA,
            teamShift.id,
            { startsAt: '2026-10-06T08:00:00-04:00' },
            admin,
          ),
        );
        expect(otherSide.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_REQUIRED');

        await service.updateShift(
          deptB,
          deptBShift.id,
          {
            endsAt: '2026-10-06T17:00:00-04:00',
            conflictOverrides: [
              override(moved.conflicts[0]!, 'Extended coverage'),
            ],
          },
          admin,
        );
        expect(
          await tx.scheduleConflictOverride.count({
            where: { scheduledShiftId: deptBShift.id },
          }),
        ).toBe(2);
      });
    });

    it('records an exact approval once; resubmitting it on an unrelated update is idempotent', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        const teamShift = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const [conflict] = (
          await conflictBody(service.createShift(deptB, candidate, admin))
        ).conflicts;
        const approval = override(conflict!);
        const deptBShift = await service.createShift(
          deptB,
          { ...candidate, conflictOverrides: [approval] },
          admin,
        );
        const counts = async () => ({
          rows: await tx.scheduleConflictOverride.count({
            where: {
              OR: [
                { scheduledShiftId: { in: [teamShift.id, deptBShift.id] } },
                { conflictingShiftId: { in: [teamShift.id, deptBShift.id] } },
              ],
            },
          }),
          audits: await tx.auditLog.count({
            where: {
              action: 'SCHEDULE_CONFLICT_OVERRIDDEN',
              entityId: { in: [teamShift.id, deptBShift.id] },
            },
          }),
        });
        expect(await counts()).toEqual({ rows: 1, audits: 1 });
        const [original] = await tx.scheduleConflictOverride.findMany({
          where: { scheduledShiftId: deptBShift.id },
        });

        // Same exact conflict state, resubmitted with unrelated allowed changes.
        for (const workLocationId of [
          fx.workLocationToronto,
          fx.workLocationOttawa,
        ]) {
          await expect(
            service.updateShift(
              deptB,
              deptBShift.id,
              {
                workLocationId,
                conflictOverrides: [{ ...approval, reason: 'Re-approved' }],
              },
              admin,
            ),
          ).resolves.toMatchObject({ workLocationId });
        }
        expect(await counts()).toEqual({ rows: 1, audits: 1 });

        // From the opposite side the same pair is already approved under the reverse key.
        const [reverse] = (
          await service.previewShiftConflicts(
            fx.users.admin,
            deptA,
            teamShift.id,
            {},
          )
        ).conflicts;
        expect(reverse).toMatchObject({
          overridden: true,
          overrideId: original!.id,
          conflictingShift: { id: deptBShift.id },
        });
        expect(reverse!.key).not.toBe(conflict!.key);
        await expect(
          service.updateShift(
            deptA,
            teamShift.id,
            {
              workLocationId: fx.workLocationToronto,
              conflictOverrides: [override(reverse!)],
            },
            admin,
          ),
        ).resolves.toMatchObject({ workLocationId: fx.workLocationToronto });
        expect(await counts()).toEqual({ rows: 1, audits: 1 });
        await expect(
          tx.scheduleConflictOverride.findUnique({
            where: { id: original!.id },
          }),
        ).resolves.toMatchObject({ reason: original!.reason });

        // A changed overlap state still needs a fresh approval; history is kept.
        const changed = await conflictBody(
          service.updateShift(
            deptA,
            teamShift.id,
            {
              startsAt: '2026-10-06T08:00:00-04:00',
              conflictOverrides: [override(reverse!)],
            },
            admin,
          ),
        );
        expect(changed.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_STALE');
        await service.updateShift(
          deptA,
          teamShift.id,
          {
            startsAt: '2026-10-06T08:00:00-04:00',
            conflictOverrides: [
              override(changed.conflicts[0]!, 'Earlier start'),
            ],
          },
          admin,
        );
        expect(await counts()).toEqual({ rows: 2, audits: 2 });
      });
    });

    it('keeps override history when shifts are deleted', async () => {
      await scenario(async ({ tx, fx, service, deptA, deptB }) => {
        const admin = ctx(fx.users.admin);
        const teamShift = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          admin,
        );
        const candidate = shift(
          fx.assignmentDeptB,
          '2026-10-06',
          '12:00',
          '16:00',
        );
        const [conflict] = (
          await conflictBody(service.createShift(deptB, candidate, admin))
        ).conflicts;
        const deptBShift = await service.createShift(
          deptB,
          { ...candidate, conflictOverrides: [override(conflict!)] },
          admin,
        );
        const [row] = await tx.scheduleConflictOverride.findMany({
          where: { scheduledShiftId: deptBShift.id },
        });

        // Deleting the conflicting shift detaches the override; its snapshot remains.
        await service.deleteShift(deptA, teamShift.id, admin);
        await expect(
          tx.scheduleConflictOverride.findUnique({ where: { id: row!.id } }),
        ).resolves.toMatchObject({
          conflictingShiftId: null,
          metadata: expect.objectContaining({
            conflictingShift: expect.objectContaining({ id: teamShift.id }),
          }),
        });

        // Deleting the overridden draft shift removes its own overrides; audit keeps history.
        await service.deleteShift(deptB, deptBShift.id, admin);
        expect(
          await tx.scheduleConflictOverride.count({ where: { id: row!.id } }),
        ).toBe(0);
        await expect(
          tx.auditLog.findFirst({
            where: {
              action: 'SCHEDULED_SHIFT_DELETED',
              entityId: deptBShift.id,
            },
          }),
        ).resolves.toMatchObject({
          metadata: expect.objectContaining({ removedConflictOverrides: 1 }),
        });
        expect(
          await tx.auditLog.count({
            where: {
              action: 'SCHEDULE_CONFLICT_OVERRIDDEN',
              entityId: deptBShift.id,
            },
          }),
        ).toBe(1);
      });
    });
  });

  // ─── Authorization ──────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('keeps schedule.manage mandatory; override permission is not a substitute', async () => {
      await scenario(async ({ fx, service, deptA }) => {
        const candidate = shift(
          fx.assignmentTeamA,
          '2026-10-06',
          '09:00',
          '13:00',
        );
        await expect(
          service.createShift(deptA, candidate, ctx(fx.users.overrideOnly)),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.createShift(deptA, candidate, ctx(fx.users.deptAReader)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.previewShiftConflicts(
            fx.users.deptAReader,
            deptA,
            null,
            candidate,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('denies unrelated organizations', async () => {
      await scenario(async ({ fx, service, deptA }) => {
        const candidate = shift(
          fx.assignmentTeamA,
          '2026-10-06',
          '09:00',
          '13:00',
        );
        await expect(
          service.createShift(deptA, candidate, ctx(fx.users.orgBAdmin)),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.previewShiftConflicts(
            fx.users.orgBAdmin,
            deptA,
            null,
            candidate,
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('lets a scoped overrider override within their own branch', async () => {
      await scenario(async ({ tx, fx, service, deptA }) => {
        // A second assignment for the same Employee, also inside Dept A.
        const sibling = await tx.employmentAssignment.create({
          data: {
            employeeId: fx.employee,
            positionId: (
              await tx.employmentAssignment.findUniqueOrThrow({
                where: { id: fx.assignmentTeamA },
              })
            ).positionId,
            employmentType: 'PART_TIME',
            status: 'ACTIVE',
            startDate: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
        const actor = ctx(fx.users.deptAOverrider);
        await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '13:00'),
          actor,
        );
        const candidate = shift(sibling.id, '2026-10-06', '12:00', '16:00');
        const [conflict] = (
          await conflictBody(service.createShift(deptA, candidate, actor))
        ).conflicts;
        await expect(
          service.createShift(
            deptA,
            { ...candidate, conflictOverrides: [override(conflict!)] },
            actor,
          ),
        ).resolves.toMatchObject({ employmentAssignmentId: sibling.id });
      });
    });
  });

  // ─── Database integrity ─────────────────────────────────────────────────────

  describe('ScheduleConflictOverride constraints', () => {
    const CHECK_VIOLATION = {
      code: expect.stringMatching(/^P(2004|2010|2039)$/),
    };
    const FK_VIOLATION = { code: expect.stringMatching(/^P(2003|2010)$/) };

    async function pair(tx: Tx, fx: Fixtures, scheduleId: string) {
      const base = {
        scheduleId,
        workDate: new Date('2026-10-06T00:00:00.000Z'),
        timezone: 'America/Toronto',
      };
      const a = await tx.scheduledShift.create({
        data: {
          ...base,
          employmentAssignmentId: fx.assignmentTeamA,
          startsAt: new Date('2026-10-06T13:00:00.000Z'),
          endsAt: new Date('2026-10-06T17:00:00.000Z'),
        },
      });
      const b = await tx.scheduledShift.create({
        data: {
          ...base,
          employmentAssignmentId: fx.assignmentDeptB,
          startsAt: new Date('2026-10-06T16:00:00.000Z'),
          endsAt: new Date('2026-10-06T20:00:00.000Z'),
        },
      });
      const data = {
        scheduledShiftId: b.id,
        conflictingShiftId: a.id,
        conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP' as const,
        conflictKey: 'a'.repeat(64),
        reason: 'Approved',
        metadata: {},
        overriddenByUserId: fx.users.admin,
      };
      return { a, b, data };
    }

    /** Each violation runs in a savepoint so the scenario transaction stays usable. */
    async function violation(tx: Tx, run: () => Promise<unknown>) {
      await tx.$executeRawUnsafe('SAVEPOINT override_check');
      const error = await rejection(run());
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT override_check');
      return error;
    }

    it('enforces overrideable type, reason, key format, and distinct shifts', async () => {
      await scenario(async ({ tx, fx, deptA }) => {
        const { a, data } = await pair(tx, fx, deptA);
        await expect(
          tx.scheduleConflictOverride.create({ data }),
        ).resolves.toMatchObject({ overriddenAt: expect.any(Date) });
        for (const bad of [
          { conflictType: 'SAME_ASSIGNMENT_OVERLAP' as const },
          { reason: '   ' },
          { conflictKey: 'not-a-key' },
          { conflictKey: 'A'.repeat(64) },
          { scheduledShiftId: a.id, conflictingShiftId: a.id },
        ]) {
          expect(
            await violation(tx, () =>
              tx.scheduleConflictOverride.create({ data: { ...data, ...bad } }),
            ),
          ).toMatchObject(CHECK_VIOLATION);
        }
      });
    });

    it('allows only one approval per shift and exact conflict state', async () => {
      await scenario(async ({ tx, fx, deptA }) => {
        const { data } = await pair(tx, fx, deptA);
        await tx.scheduleConflictOverride.create({ data });
        expect(
          await violation(tx, () =>
            tx.scheduleConflictOverride.create({
              data: { ...data, reason: 'Again' },
            }),
          ),
        ).toMatchObject({ code: 'P2002' });
        // A different conflict state for the same shift is a separate approval.
        await expect(
          tx.scheduleConflictOverride.create({
            data: { ...data, conflictKey: 'b'.repeat(64) },
          }),
        ).resolves.toBeDefined();
      });
    });

    it('restricts deleting an overridden shift and detaches a deleted conflicting shift', async () => {
      await scenario(async ({ tx, fx, deptA }) => {
        const { a, b, data } = await pair(tx, fx, deptA);
        const row = await tx.scheduleConflictOverride.create({ data });
        expect(
          await violation(tx, () =>
            tx.scheduledShift.delete({ where: { id: b.id } }),
          ),
        ).toMatchObject(FK_VIOLATION);
        expect(
          await violation(tx, () =>
            tx.scheduleConflictOverride.create({
              data: {
                ...data,
                conflictKey: 'c'.repeat(64),
                overriddenByUserId: randomUUID(),
              },
            }),
          ),
        ).toMatchObject(FK_VIOLATION);
        await tx.scheduledShift.delete({ where: { id: a.id } });
        await expect(
          tx.scheduleConflictOverride.findUnique({ where: { id: row.id } }),
        ).resolves.toMatchObject({ conflictingShiftId: null });
      });
    });
  });

  // ─── Regression ─────────────────────────────────────────────────────────────

  describe('Batch 2 regression', () => {
    it('keeps non-conflicting CRUD, strict input rules, and audit unchanged', async () => {
      await scenario(async ({ tx, fx, service, deptA }) => {
        const admin = ctx(fx.users.admin);
        const created = await service.createShift(
          deptA,
          shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
          admin,
        );
        await service.updateShift(
          deptA,
          created.id,
          { endsAt: '2026-10-06T18:00:00-04:00' },
          admin,
        );
        await service.deleteShift(deptA, created.id, admin);
        expect(
          (
            await tx.auditLog.findMany({
              where: { entityId: created.id },
              orderBy: { occurredAt: 'asc' },
            })
          ).map((row) => row.action),
        ).toEqual([
          'SCHEDULED_SHIFT_CREATED',
          'SCHEDULED_SHIFT_UPDATED',
          'SCHEDULED_SHIFT_DELETED',
        ]);
        await expect(
          service.createShift(
            deptA,
            {
              ...shift(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
              startsAt: '2026-10-06T09:00:00',
            },
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.createShift(
            deptA,
            {
              ...shift(
                fx.assignmentTeamA,
                '2026-10-06',
                '22:00',
                '06:00',
                '2026-10-07',
              ),
              workDate: '2026-10-07',
            },
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });

  // ─── Concurrency (committed data, real concurrent transactions) ─────────────

  describe('concurrency', () => {
    let fx: Fixtures;
    let scheduleIds: string[] = [];
    let s1: string;
    let s2: string;
    let s3: string;

    beforeAll(async () => {
      fx = await prisma.$transaction((tx) => createFixtures(tx), {
        timeout: 30_000,
      });
      const service = schedulingService(prisma);
      const schedule = (departmentId: string, name: string) =>
        service
          .createSchedule(
            {
              scopeType: 'DEPARTMENT',
              organizationId: fx.orgA,
              departmentId,
              name,
              type: 'STANDARD',
              ...WEEK,
            },
            ctx(fx.users.admin),
          )
          .then((row) => row.id);
      s1 = await schedule(fx.deptA, 'Concurrency A1');
      s2 = await schedule(fx.deptA, 'Concurrency A2');
      s3 = await schedule(fx.deptB, 'Concurrency B');
      scheduleIds = [s1, s2, s3];
    });

    afterAll(async () => {
      if (fx) await cleanupFixtures(prisma, fx, scheduleIds);
    });

    /**
     * Each request pauses after its conflict query and before its write, widening the race
     * window: without the Employee lock both requests would pass detection.
     */
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

    async function activeOverlaps(employmentAssignmentIds: string[]) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM "ScheduledShift" a
           JOIN "ScheduledShift" b ON a."id" < b."id"
          WHERE a."status" = 'ACTIVE' AND b."status" = 'ACTIVE'
            AND a."employmentAssignmentId" = ANY($1::uuid[])
            AND b."employmentAssignmentId" = ANY($1::uuid[])
            AND a."startsAt" < b."endsAt" AND b."startsAt" < a."endsAt"`,
        employmentAssignmentIds,
      );
      return Number(rows[0]!.count);
    }

    function codeOf(error: unknown) {
      return error instanceof ConflictException
        ? (error.getResponse() as ConflictBody).code
        : error;
    }

    it('lets only one of two overlapping same-assignment creates in different Schedules succeed', async () => {
      const service = racingService();
      const admin = ctx(fx.users.admin);
      const { fulfilled, rejected } = await settle(
        service.createShift(
          s1,
          shift(fx.assignmentTeamA, '2026-10-05', '08:00', '12:00'),
          admin,
        ),
        service.createShift(
          s2,
          shift(fx.assignmentTeamA, '2026-10-05', '10:00', '14:00'),
          admin,
        ),
      );
      expect(fulfilled).toBe(1);
      expect(rejected.map(codeOf)).toEqual(['SCHEDULE_CONFLICT_ERROR']);
      expect(await activeOverlaps([fx.assignmentTeamA])).toBe(0);
    });

    it('lets only one of a colliding update and create succeed', async () => {
      const admin = ctx(fx.users.admin);
      const existing = await schedulingService(prisma).createShift(
        s1,
        shift(fx.assignmentTeamA, '2026-10-07', '06:00', '08:00'),
        admin,
      );
      const service = racingService();
      const { fulfilled, rejected } = await settle(
        service.updateShift(
          s1,
          existing.id,
          {
            startsAt: '2026-10-07T12:00:00-04:00',
            endsAt: '2026-10-07T16:00:00-04:00',
          },
          admin,
        ),
        service.createShift(
          s2,
          shift(fx.assignmentTeamA, '2026-10-07', '14:00', '18:00'),
          admin,
        ),
      );
      expect(fulfilled).toBe(1);
      expect(rejected.map(codeOf)).toEqual(['SCHEDULE_CONFLICT_ERROR']);
      expect(await activeOverlaps([fx.assignmentTeamA])).toBe(0);
    });

    it('serializes employee-wide evaluation across assignments', async () => {
      const service = racingService();
      const admin = ctx(fx.users.admin);
      const { fulfilled, rejected } = await settle(
        service.createShift(
          s1,
          shift(fx.assignmentTeamA, '2026-10-08', '09:00', '13:00'),
          admin,
        ),
        service.createShift(
          s3,
          shift(fx.assignmentDeptB, '2026-10-08', '12:00', '16:00'),
          admin,
        ),
      );
      expect(fulfilled).toBe(1);
      expect(rejected.map(codeOf)).toEqual([
        'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
      ]);
      expect(
        await activeOverlaps([fx.assignmentTeamA, fx.assignmentDeptB]),
      ).toBe(0);
    });

    it('records a concurrently resubmitted approval only once', async () => {
      const admin = ctx(fx.users.admin);
      const plain = schedulingService(prisma);
      await plain.createShift(
        s1,
        shift(fx.assignmentTeamA, '2026-10-10', '09:00', '13:00'),
        admin,
      );
      const candidate = shift(
        fx.assignmentDeptB,
        '2026-10-10',
        '12:00',
        '16:00',
      );
      const [conflict] = (
        await plain.previewShiftConflicts(fx.users.admin, s3, null, candidate)
      ).conflicts;
      const approval = {
        conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP' as const,
        conflictKey: conflict!.key,
        reason: 'Approved',
      };
      const created = await plain.createShift(
        s3,
        { ...candidate, conflictOverrides: [approval] },
        admin,
      );
      const service = racingService();
      const { fulfilled, rejected } = await settle(
        service.updateShift(
          s3,
          created.id,
          {
            workLocationId: fx.workLocationToronto,
            conflictOverrides: [approval],
          },
          admin,
        ),
        service.updateShift(
          s3,
          created.id,
          {
            workLocationId: fx.workLocationOttawa,
            conflictOverrides: [approval],
          },
          admin,
        ),
      );
      expect(rejected).toEqual([]);
      expect(fulfilled).toBe(2);
      expect(
        await prisma.scheduleConflictOverride.count({
          where: { scheduledShiftId: created.id },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'SCHEDULE_CONFLICT_OVERRIDDEN',
            entityId: created.id,
          },
        }),
      ).toBe(1);
    });

    it('still allows non-conflicting concurrent shifts', async () => {
      const service = racingService(100);
      const admin = ctx(fx.users.admin);
      const { fulfilled, rejected } = await settle(
        service.createShift(
          s1,
          shift(fx.assignmentTeamA, '2026-10-09', '08:00', '12:00'),
          admin,
        ),
        service.createShift(
          s2,
          shift(fx.assignmentTeamA, '2026-10-09', '12:00', '16:00'),
          admin,
        ),
        service.createShift(
          s3,
          shift(fx.assignmentDeptB, '2026-10-09', '16:00', '20:00'),
          admin,
        ),
        service.createShift(
          s1,
          shift(fx.otherEmployeeTeamA, '2026-10-09', '08:00', '12:00'),
          admin,
        ),
      );
      expect(rejected).toEqual([]);
      expect(fulfilled).toBe(4);
    });
  });
});

async function expectNoOverride(tx: Tx, fx: Fixtures) {
  expect(
    await tx.scheduleConflictOverride.count({
      where: { overriddenByUserId: { in: Object.values(fx.users) } },
    }),
  ).toBe(0);
  expect(
    await tx.auditLog.count({
      where: {
        action: 'SCHEDULE_CONFLICT_OVERRIDDEN',
        actorUserId: { in: Object.values(fx.users) },
      },
    }),
  ).toBe(0);
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

/** Delays every conflict query result so concurrent requests overlap inside the race window. */
function pausingTx(tx: Tx, pauseMs: number): Tx {
  const shifts = new Proxy(tx.scheduledShift, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'findMany' || typeof value !== 'function') return value;
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
    data: { name: 'Conflict Org A', code: code('CA') },
  });
  const orgB = await tx.organization.create({
    data: { name: 'Conflict Org B', code: code('CB') },
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
  const workLocationOttawa = await tx.workLocation.create({
    data: {
      organizationId: orgA.id,
      name: 'Ottawa',
      code: code('WOT'),
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
        employeeNumber: code(`CE${employeeIndex}`),
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
        name: 'Conflict role',
      },
    });
    for (const key of keys) {
      await tx.rolePermission.create({
        data: { roleId: created.id, permissionId: permissions[key] },
      });
    }
    return created.id;
  };
  const manage = await role(orgA.id, ['schedule.manage']);
  const read = await role(orgA.id, ['schedule.read']);
  const overrideRole = await role(orgA.id, ['schedule.override_conflict']);
  const manageOverride = await role(orgA.id, [
    'schedule.manage',
    'schedule.override_conflict',
  ]);
  const manageOverrideB = await role(orgB.id, [
    'schedule.manage',
    'schedule.override_conflict',
  ]);

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
        email: `conflict-${label}-${suffix.toLowerCase()}@example.com`,
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
    suffix,
    orgA: orgA.id,
    orgB: orgB.id,
    deptA: deptA.id,
    deptB: deptB.id,
    teamA: teamA.id,
    employee: shared.id,
    assignmentTeamA: await assignment(shared.id, positionTeamA.id, true),
    assignmentDeptB: await assignment(shared.id, positionDeptB.id, false),
    otherEmployeeTeamA: await assignment(other.id, positionTeamA.id, true),
    workLocationToronto: workLocation.id,
    workLocationOttawa: workLocationOttawa.id,
    users: {
      admin: await user('admin', [org(manageOverride)]),
      manageOnly: await user('manage-only', [org(manage)]),
      deptAOverrider: await user('dept-a-overrider', [
        dept(manageOverride, deptA.id),
      ]),
      deptAManagerOrgOverrider: await user('dept-a-manager-org-overrider', [
        dept(manage, deptA.id),
        org(overrideRole),
      ]),
      overrideOnly: await user('override-only', [org(overrideRole)]),
      deptAReader: await user('dept-a-reader', [dept(read, deptA.id)]),
      orgBAdmin: await user('org-b-admin', [org(manageOverrideB, orgB.id)]),
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
