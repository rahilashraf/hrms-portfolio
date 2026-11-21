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

interface Fixtures {
  orgA: string;
  orgB: string;
  unitA: string;
  unitB: string;
  deptA: string;
  deptB: string;
  teamA: string;
  orgBDept: string;
  assignmentTeamA: string;
  assignmentDeptB: string;
  assignmentCancelled: string;
  assignmentFuture: string;
  assignmentOrgB: string;
  workLocationToronto: string;
  workLocationNoTimezone: string;
  workLocationArchived: string;
  workLocationOrgB: string;
  users: {
    orgAdmin: string;
    deptAManager: string;
    deptAReader: string;
    teamAManager: string;
    unitBManager: string;
    orgBAdmin: string;
    noAccess: string;
  };
}

interface Harness {
  tx: Tx;
  fx: Fixtures;
  service: SchedulingService;
}

const ctx = (actorUserId: string) => ({
  actorUserId,
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
  correlationId: 'scheduling-db-spec',
});

const WEEK = { periodStart: '2026-10-05', periodEnd: '2026-10-11' };

describe('Scheduling draft management (database)', () => {
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

  /** Runs a scenario against real services inside one transaction that is always rolled back. */
  async function scenario(run: (harness: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createFixtures(tx);
          await run({ tx, fx, service: schedulingService(tx) });
          throw new RollbackFixtures();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  function deptASchedule(fx: Fixtures, overrides: object = {}) {
    return {
      scopeType: 'DEPARTMENT' as const,
      organizationId: fx.orgA,
      departmentId: fx.deptA,
      name: 'Dept A week 41',
      type: 'STANDARD' as const,
      ...WEEK,
      ...overrides,
    };
  }

  function torontoShift(fx: Fixtures, overrides: object = {}) {
    return {
      employmentAssignmentId: fx.assignmentTeamA,
      workLocationId: fx.workLocationToronto,
      workDate: '2026-10-06',
      startsAt: '2026-10-06T09:00:00-04:00',
      endsAt: '2026-10-06T17:00:00-04:00',
      ...overrides,
    };
  }

  async function publish(tx: Tx, scheduleId: string, userId: string) {
    // Batch 4 owns publication; tests simulate a published row directly.
    await tx.schedule.update({
      where: { id: scheduleId },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date('2026-10-01T12:00:00.000Z'),
        publishedByUserId: userId,
      },
    });
  }

  // ─── Schedule create ────────────────────────────────────────────────────────

  describe('schedule create', () => {
    it('creates DRAFT schedules for each scope type', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const org = await service.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            name: 'Org',
            type: 'STANDARD',
            ...WEEK,
          },
          admin,
        );
        const unit = await service.createSchedule(
          {
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationId: fx.orgA,
            organizationalUnitId: fx.unitA,
            name: 'Unit',
            type: 'AD_HOC',
            ...WEEK,
          },
          admin,
        );
        const dept = await service.createSchedule(deptASchedule(fx), admin);
        const team = await service.createSchedule(
          {
            scopeType: 'TEAM',
            organizationId: fx.orgA,
            teamId: fx.teamA,
            name: 'Team',
            type: 'STANDARD',
            ...WEEK,
          },
          admin,
        );
        expect(org).toMatchObject({
          scopeType: 'ORGANIZATION',
          organizationalUnitId: null,
          departmentId: null,
          teamId: null,
          status: 'DRAFT',
          publishedAt: null,
          publishedByUserId: null,
          periodStart: '2026-10-05',
          periodEnd: '2026-10-11',
        });
        expect(unit).toMatchObject({
          scopeType: 'ORGANIZATIONAL_UNIT',
          organizationalUnitId: fx.unitA,
          type: 'AD_HOC',
        });
        expect(dept).toMatchObject({
          scopeType: 'DEPARTMENT',
          departmentId: fx.deptA,
        });
        expect(team).toMatchObject({ scopeType: 'TEAM', teamId: fx.teamA });
      });
    });

    it('rejects contradictory scope shapes', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        await expect(
          service.createSchedule(
            deptASchedule(fx, { scopeType: 'TEAM' }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.createSchedule(
            deptASchedule(fx, { scopeType: 'ORGANIZATION' }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.createSchedule(
            deptASchedule(fx, { teamId: fx.teamA }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('rejects a scope target from another organization', async () => {
      await scenario(async ({ fx, service }) => {
        await expect(
          service.createSchedule(
            deptASchedule(fx, { departmentId: fx.orgBDept }),
            ctx(fx.users.orgAdmin),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('rejects archived scope targets', async () => {
      await scenario(async ({ tx, fx, service }) => {
        await tx.department.update({
          where: { id: fx.deptA },
          data: { archivedAt: new Date() },
        });
        await expect(
          service.createSchedule(deptASchedule(fx), ctx(fx.users.orgAdmin)),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('rejects inverted periods and non DATE-only input', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        await expect(
          service.createSchedule(
            deptASchedule(fx, {
              periodStart: '2026-10-11',
              periodEnd: '2026-10-05',
            }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.createSchedule(
            deptASchedule(fx, { periodStart: '2026-02-30' }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('ignores client publication state and always creates DRAFT', async () => {
      await scenario(async ({ fx, service }) => {
        const created = await service.createSchedule(
          deptASchedule(fx, {
            status: 'PUBLISHED',
            publishedAt: '2026-10-01T00:00:00Z',
            publishedByUserId: fx.users.orgAdmin,
          }),
          ctx(fx.users.orgAdmin),
        );
        expect(created).toMatchObject({
          status: 'DRAFT',
          publishedAt: null,
          publishedByUserId: null,
        });
      });
    });

    it('requires schedule.manage on the target scope', async () => {
      await scenario(async ({ fx, service }) => {
        await expect(
          service.createSchedule(deptASchedule(fx), ctx(fx.users.deptAReader)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.createSchedule(deptASchedule(fx), ctx(fx.users.teamAManager)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.createSchedule(deptASchedule(fx), ctx(fx.users.unitBManager)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.createSchedule(deptASchedule(fx), ctx(fx.users.orgBAdmin)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.createSchedule(deptASchedule(fx), ctx(fx.users.deptAManager)),
        ).resolves.toMatchObject({ status: 'DRAFT' });
        await expect(
          service.createSchedule(
            {
              scopeType: 'TEAM',
              organizationId: fx.orgA,
              teamId: fx.teamA,
              name: 'Team',
              type: 'STANDARD',
              ...WEEK,
            },
            ctx(fx.users.deptAManager),
          ),
        ).resolves.toMatchObject({ scopeType: 'TEAM' });
      });
    });
  });

  // ─── Schedule read ──────────────────────────────────────────────────────────

  describe('schedule read', () => {
    it('returns only schedules inside the actor scope', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const deptA = await service.createSchedule(deptASchedule(fx), admin);
        const team = await service.createSchedule(
          {
            scopeType: 'TEAM',
            organizationId: fx.orgA,
            teamId: fx.teamA,
            name: 'Team A',
            type: 'AD_HOC',
            ...WEEK,
          },
          admin,
        );
        const deptB = await service.createSchedule(
          deptASchedule(fx, { departmentId: fx.deptB, name: 'Dept B' }),
          admin,
        );
        const orgLevel = await service.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            name: 'Org A',
            type: 'STANDARD',
            periodStart: '2026-11-02',
            periodEnd: '2026-11-08',
          },
          admin,
        );
        const orgB = await service.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgB,
            name: 'Org B',
            type: 'STANDARD',
            ...WEEK,
          },
          ctx(fx.users.orgBAdmin),
        );

        const ids = async (userId: string, query = {}) =>
          (await service.listSchedules(userId, query)).items
            .map((item) => item.id)
            .sort();

        expect(await ids(fx.users.deptAReader)).toEqual(
          [deptA.id, team.id].sort(),
        );
        expect(await ids(fx.users.teamAManager)).toEqual([team.id]);
        expect(await ids(fx.users.unitBManager)).toEqual([deptB.id]);
        expect(await ids(fx.users.orgAdmin)).toEqual(
          [deptA.id, team.id, deptB.id, orgLevel.id].sort(),
        );
        expect(await ids(fx.users.orgBAdmin)).toEqual([orgB.id]);
        expect(await ids(fx.users.noAccess)).toEqual([]);

        await expect(
          service.getSchedule(fx.users.deptAReader, deptA.id),
        ).resolves.toMatchObject({ id: deptA.id });
        await expect(
          service.getSchedule(fx.users.deptAReader, deptB.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.getSchedule(fx.users.orgAdmin, orgB.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.getSchedule(fx.users.noAccess, deptA.id),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('applies list filters and pagination', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const deptA = await service.createSchedule(deptASchedule(fx), admin);
        const team = await service.createSchedule(
          {
            scopeType: 'TEAM',
            organizationId: fx.orgA,
            teamId: fx.teamA,
            name: 'Team A',
            type: 'AD_HOC',
            periodStart: '2026-10-08',
            periodEnd: '2026-10-08',
          },
          admin,
        );
        const november = await service.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            name: 'November',
            type: 'STANDARD',
            periodStart: '2026-11-02',
            periodEnd: '2026-11-08',
          },
          admin,
        );
        await publish(tx, november.id, fx.users.orgAdmin);
        const user = fx.users.orgAdmin;
        const ids = async (query: object) =>
          (await service.listSchedules(user, query)).items.map(
            (item) => item.id,
          );

        expect(await ids({ type: 'AD_HOC' })).toEqual([team.id]);
        expect(await ids({ status: 'PUBLISHED' })).toEqual([november.id]);
        expect(await ids({ scopeType: 'DEPARTMENT' })).toEqual([deptA.id]);
        expect(await ids({ departmentId: fx.deptA })).toEqual([deptA.id]);
        expect(await ids({ teamId: fx.teamA })).toEqual([team.id]);
        expect(await ids({ from: '2026-10-09', to: '2026-10-31' })).toEqual([
          deptA.id,
        ]);
        expect(await ids({ from: '2026-11-08' })).toEqual([november.id]);
        expect(await ids({ organizationId: fx.orgB })).toEqual([]);
        await expect(
          service.listSchedules(user, { from: '2026-10-10', to: '2026-10-01' }),
        ).rejects.toBeInstanceOf(BadRequestException);

        const first = await service.listSchedules(user, { limit: 2 });
        expect(first.items.map((item) => item.id)).toEqual([
          november.id,
          team.id,
        ]);
        expect(first.nextAfterId).toBe(team.id);
        const second = await service.listSchedules(user, {
          limit: 2,
          afterId: first.nextAfterId!,
        });
        expect(second.items.map((item) => item.id)).toEqual([deptA.id]);
        expect(second.nextAfterId).toBeNull();
      });
    });
  });

  // ─── Schedule update ────────────────────────────────────────────────────────

  describe('schedule update', () => {
    it('updates draft metadata, type, scope, and period', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await service.createShift(schedule.id, torontoShift(fx), admin);

        const updated = await service.updateSchedule(
          schedule.id,
          {
            name: '  Renamed  ',
            type: 'AD_HOC',
            scopeType: 'TEAM',
            teamId: fx.teamA,
            periodStart: '2026-10-06',
            periodEnd: '2026-10-20',
          },
          admin,
        );
        expect(updated).toMatchObject({
          name: 'Renamed',
          type: 'AD_HOC',
          scopeType: 'TEAM',
          departmentId: null,
          teamId: fx.teamA,
          periodStart: '2026-10-06',
          periodEnd: '2026-10-20',
          status: 'DRAFT',
        });
      });
    });

    it('rejects a period that would exclude existing shifts', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await service.createShift(schedule.id, torontoShift(fx), admin);
        await expect(
          service.updateSchedule(
            schedule.id,
            { periodStart: '2026-10-07' },
            admin,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          service.updateSchedule(
            schedule.id,
            { periodEnd: '2026-10-05' },
            admin,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        const unchanged = await tx.schedule.findUniqueOrThrow({
          where: { id: schedule.id },
        });
        expect(unchanged.periodStart.toISOString().slice(0, 10)).toBe(
          '2026-10-05',
        );
        await expect(
          service.updateSchedule(
            schedule.id,
            { periodStart: '2026-10-06', periodEnd: '2026-10-06' },
            admin,
          ),
        ).resolves.toMatchObject({
          periodStart: '2026-10-06',
          periodEnd: '2026-10-06',
        });
      });
    });

    it('rejects invalid scope updates and out-of-scope actors', async () => {
      await scenario(async ({ fx, service }) => {
        const schedule = await service.createSchedule(
          deptASchedule(fx),
          ctx(fx.users.orgAdmin),
        );
        await expect(
          service.updateSchedule(
            schedule.id,
            { scopeType: 'TEAM' },
            ctx(fx.users.orgAdmin),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.updateSchedule(
            schedule.id,
            { teamId: fx.teamA },
            ctx(fx.users.orgAdmin),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.updateSchedule(
            schedule.id,
            { scopeType: 'DEPARTMENT', departmentId: fx.orgBDept },
            ctx(fx.users.orgAdmin),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        // Moving the schedule outside the manager's own branch is forbidden.
        await expect(
          service.updateSchedule(
            schedule.id,
            { scopeType: 'DEPARTMENT', departmentId: fx.deptB },
            ctx(fx.users.deptAManager),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.updateSchedule(
            schedule.id,
            { name: 'x' },
            ctx(fx.users.deptAReader),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.updateSchedule(
            schedule.id,
            { name: 'x' },
            ctx(fx.users.unitBManager),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('rejects updates to PUBLISHED schedules', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await publish(tx, schedule.id, fx.users.orgAdmin);
        await expect(
          service.updateSchedule(schedule.id, { name: 'Changed' }, admin),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });
  });

  // ─── Schedule delete ────────────────────────────────────────────────────────

  describe('schedule delete', () => {
    it('deletes an empty draft and rejects one that still has shifts', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const empty = await service.createSchedule(deptASchedule(fx), admin);
        await expect(service.deleteSchedule(empty.id, admin)).resolves.toEqual({
          success: true,
        });
        expect(
          await tx.schedule.findUnique({ where: { id: empty.id } }),
        ).toBeNull();

        const withShift = await service.createSchedule(
          deptASchedule(fx),
          admin,
        );
        await service.createShift(withShift.id, torontoShift(fx), admin);
        await expect(
          service.deleteSchedule(withShift.id, admin),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(
          await tx.scheduledShift.count({
            where: { scheduleId: withShift.id },
          }),
        ).toBe(1);
      });
    });

    it('rejects deleting PUBLISHED or out-of-scope schedules', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await expect(
          service.deleteSchedule(schedule.id, ctx(fx.users.deptAReader)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.deleteSchedule(schedule.id, ctx(fx.users.orgBAdmin)),
        ).rejects.toBeInstanceOf(NotFoundException);
        await publish(tx, schedule.id, fx.users.orgAdmin);
        await expect(
          service.deleteSchedule(schedule.id, admin),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });
  });

  // ─── Shift create ───────────────────────────────────────────────────────────

  describe('shift create', () => {
    it('creates normal and overnight MANUAL shifts on the period boundaries', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const normal = await service.createShift(
          schedule.id,
          torontoShift(fx, {
            workDate: '2026-10-05',
            startsAt: '2026-10-05T09:00:00-04:00',
            endsAt: '2026-10-05T17:00:00-04:00',
          }),
          admin,
        );
        expect(normal).toMatchObject({
          scheduleId: schedule.id,
          workDate: '2026-10-05',
          startsAt: '2026-10-05T13:00:00.000Z',
          endsAt: '2026-10-05T21:00:00.000Z',
          timezone: 'America/Toronto',
          status: 'ACTIVE',
          sourceType: 'MANUAL',
        });
        const overnight = await service.createShift(
          schedule.id,
          torontoShift(fx, {
            workDate: '2026-10-11',
            startsAt: '2026-10-11T22:00:00-04:00',
            endsAt: '2026-10-12T06:00:00-04:00',
          }),
          admin,
        );
        expect(overnight).toMatchObject({
          workDate: '2026-10-11',
          endsAt: '2026-10-12T10:00:00.000Z',
        });
      });
    });

    it('rejects workDates outside the period and invalid intervals', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, {
              workDate: '2026-10-12',
              startsAt: '2026-10-12T09:00:00-04:00',
              endsAt: '2026-10-12T17:00:00-04:00',
            }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { endsAt: '2026-10-06T09:00:00-04:00' }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { endsAt: '2026-10-06T08:00:00-04:00' }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        // workDate must be the local start date in the resolved timezone.
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { workDate: '2026-10-07' }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        // Floating local timestamps are ambiguous and rejected.
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { startsAt: '2026-10-06T09:00:00' }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('enforces assignment organization and lifecycle', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        for (const employmentAssignmentId of [
          fx.assignmentOrgB,
          fx.assignmentCancelled,
          fx.assignmentFuture,
        ]) {
          await expect(
            service.createShift(
              schedule.id,
              torontoShift(fx, { employmentAssignmentId }),
              admin,
            ),
          ).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { employmentAssignmentId: randomUUID() }),
            admin,
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('enforces WorkLocation organization and timezone precedence', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { workLocationId: fx.workLocationOrgB }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { workLocationId: fx.workLocationArchived }),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        const precedence = await service.createShift(
          schedule.id,
          torontoShift(fx, { timezone: 'Europe/London' }),
          admin,
        );
        expect(precedence.timezone).toBe('America/Toronto');

        const fallback = await service.createShift(
          schedule.id,
          torontoShift(fx, {
            workLocationId: fx.workLocationNoTimezone,
            timezone: 'Europe/London',
            // Separate days keep these same-assignment shifts from overlapping (Batch 3).
            workDate: '2026-10-07',
            startsAt: '2026-10-07T09:00:00+01:00',
            endsAt: '2026-10-07T17:00:00+01:00',
          }),
          admin,
        );
        expect(fallback).toMatchObject({
          timezone: 'Europe/London',
          workLocationId: fx.workLocationNoTimezone,
        });

        const noLocation = await service.createShift(
          schedule.id,
          torontoShift(fx, {
            workLocationId: undefined,
            timezone: 'America/Vancouver',
            workDate: '2026-10-08',
            startsAt: '2026-10-08T09:00:00-07:00',
            endsAt: '2026-10-08T17:00:00-07:00',
          }),
          admin,
        );
        expect(noLocation).toMatchObject({
          workLocationId: null,
          timezone: 'America/Vancouver',
        });

        for (const timezone of ['EST', undefined]) {
          await expect(
            service.createShift(
              schedule.id,
              torontoShift(fx, { workLocationId: undefined, timezone }),
              admin,
            ),
          ).rejects.toBeInstanceOf(BadRequestException);
        }
      });
    });

    it('controls sourceType and status server-side', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const shift = await service.createShift(
          schedule.id,
          torontoShift(fx, { sourceType: 'PATTERN', status: 'CANCELLED' }),
          admin,
        );
        expect(shift).toMatchObject({ sourceType: 'MANUAL', status: 'ACTIVE' });
      });
    });

    it('rejects shifts under PUBLISHED schedules', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await publish(tx, schedule.id, fx.users.orgAdmin);
        await expect(
          service.createShift(schedule.id, torontoShift(fx), admin),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    it('requires schedule.manage for both the schedule and the assignment scope', async () => {
      await scenario(async ({ fx, service }) => {
        const schedule = await service.createSchedule(
          deptASchedule(fx),
          ctx(fx.users.orgAdmin),
        );
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx),
            ctx(fx.users.deptAReader),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // Dept A manager cannot place an employee whose position is in Dept B.
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx, { employmentAssignmentId: fx.assignmentDeptB }),
            ctx(fx.users.deptAManager),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.createShift(
            schedule.id,
            torontoShift(fx),
            ctx(fx.users.deptAManager),
          ),
        ).resolves.toMatchObject({ sourceType: 'MANUAL' });
      });
    });
  });

  // ─── Shift update ───────────────────────────────────────────────────────────

  describe('shift update', () => {
    it('updates assignment, location, timezone, times, and workDate', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const shift = await service.createShift(
          schedule.id,
          torontoShift(fx),
          admin,
        );

        const moved = await service.updateShift(
          schedule.id,
          shift.id,
          {
            employmentAssignmentId: fx.assignmentDeptB,
            workDate: '2026-10-08',
            startsAt: '2026-10-08T10:00:00-04:00',
            endsAt: '2026-10-08T18:00:00-04:00',
          },
          admin,
        );
        expect(moved).toMatchObject({
          employmentAssignmentId: fx.assignmentDeptB,
          workDate: '2026-10-08',
          startsAt: '2026-10-08T14:00:00.000Z',
          timezone: 'America/Toronto',
        });

        const relocated = await service.updateShift(
          schedule.id,
          shift.id,
          {
            workLocationId: null,
            timezone: 'America/Vancouver',
            startsAt: '2026-10-08T10:00:00-07:00',
            endsAt: '2026-10-08T18:00:00-07:00',
          },
          admin,
        );
        expect(relocated).toMatchObject({
          workLocationId: null,
          timezone: 'America/Vancouver',
          workDate: '2026-10-08',
        });
      });
    });

    it('re-runs every validation on update', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const shift = await service.createShift(
          schedule.id,
          torontoShift(fx),
          admin,
        );
        const reject = (input: object) =>
          expect(
            service.updateShift(schedule.id, shift.id, input, admin),
          ).rejects.toBeInstanceOf(BadRequestException);

        await reject({
          workDate: '2026-10-12',
          startsAt: '2026-10-12T09:00:00-04:00',
          endsAt: '2026-10-12T17:00:00-04:00',
        });
        await reject({ endsAt: '2026-10-06T08:00:00-04:00' });
        await reject({ employmentAssignmentId: fx.assignmentOrgB });
        await reject({ employmentAssignmentId: fx.assignmentCancelled });
        await reject({ workLocationId: fx.workLocationOrgB });
        await reject({ workDate: '2026-10-07' });
      });
    });

    it('rejects updates under PUBLISHED schedules and from other schedules', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const other = await service.createSchedule(deptASchedule(fx), admin);
        const shift = await service.createShift(
          schedule.id,
          torontoShift(fx),
          admin,
        );
        await expect(
          service.updateShift(other.id, shift.id, { timezone: 'UTC' }, admin),
        ).rejects.toBeInstanceOf(NotFoundException);
        await publish(tx, schedule.id, fx.users.orgAdmin);
        await expect(
          service.updateShift(
            schedule.id,
            shift.id,
            { endsAt: '2026-10-06T18:00:00-04:00' },
            admin,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });
  });

  // ─── Shift delete / read ────────────────────────────────────────────────────

  describe('shift delete and read', () => {
    it('hard-deletes draft shifts and guards scope, schedule, and status', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const other = await service.createSchedule(deptASchedule(fx), admin);
        const first = await service.createShift(
          schedule.id,
          torontoShift(fx),
          admin,
        );
        const second = await service.createShift(
          schedule.id,
          torontoShift(fx, {
            workDate: '2026-10-07',
            startsAt: '2026-10-07T09:00:00-04:00',
            endsAt: '2026-10-07T17:00:00-04:00',
          }),
          admin,
        );

        await expect(
          service.deleteShift(other.id, first.id, admin),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.deleteShift(schedule.id, first.id, ctx(fx.users.deptAReader)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.deleteShift(schedule.id, first.id, ctx(fx.users.orgBAdmin)),
        ).rejects.toBeInstanceOf(NotFoundException);

        await expect(
          service.deleteShift(schedule.id, first.id, admin),
        ).resolves.toEqual({ success: true });
        expect(
          await tx.scheduledShift.findUnique({ where: { id: first.id } }),
        ).toBeNull();

        await publish(tx, schedule.id, fx.users.orgAdmin);
        await expect(
          service.deleteShift(schedule.id, second.id, admin),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(
          await tx.scheduledShift.findUnique({ where: { id: second.id } }),
        ).not.toBeNull();
      });
    });

    it('lists and reads shifts for readers of the schedule scope only', async () => {
      await scenario(async ({ fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const late = await service.createShift(
          schedule.id,
          torontoShift(fx, {
            workDate: '2026-10-09',
            startsAt: '2026-10-09T09:00:00-04:00',
            endsAt: '2026-10-09T17:00:00-04:00',
          }),
          admin,
        );
        const early = await service.createShift(
          schedule.id,
          torontoShift(fx),
          admin,
        );
        const reader = fx.users.deptAReader;

        const all = await service.listShifts(reader, schedule.id);
        expect(all.items.map((item) => item.id)).toEqual([early.id, late.id]);
        const ranged = await service.listShifts(reader, schedule.id, {
          from: '2026-10-08',
        });
        expect(ranged.items.map((item) => item.id)).toEqual([late.id]);
        const paged = await service.listShifts(reader, schedule.id, {
          limit: 1,
        });
        expect(paged).toMatchObject({
          items: [{ id: early.id }],
          nextAfterId: early.id,
        });

        await expect(
          service.getShift(reader, schedule.id, late.id),
        ).resolves.toMatchObject({ id: late.id });
        await expect(
          service.listShifts(fx.users.unitBManager, schedule.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.getShift(fx.users.orgBAdmin, schedule.id, late.id),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  // ─── Audit ──────────────────────────────────────────────────────────────────

  describe('audit', () => {
    it('records create, update, and delete events', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        const shift = await service.createShift(
          schedule.id,
          torontoShift(fx),
          admin,
        );
        await service.updateShift(
          schedule.id,
          shift.id,
          { endsAt: '2026-10-06T18:00:00-04:00' },
          admin,
        );
        await service.deleteShift(schedule.id, shift.id, admin);
        await service.updateSchedule(schedule.id, { name: 'Final' }, admin);
        await service.deleteSchedule(schedule.id, admin);

        const logs = await tx.auditLog.findMany({
          where: { entityId: { in: [schedule.id, shift.id] } },
          orderBy: { occurredAt: 'asc' },
        });
        expect(
          logs.map((log) => [log.action, log.entityType, log.entityId]),
        ).toEqual(
          expect.arrayContaining([
            ['SCHEDULE_CREATED', 'Schedule', schedule.id],
            ['SCHEDULED_SHIFT_CREATED', 'ScheduledShift', shift.id],
            ['SCHEDULED_SHIFT_UPDATED', 'ScheduledShift', shift.id],
            ['SCHEDULED_SHIFT_DELETED', 'ScheduledShift', shift.id],
            ['SCHEDULE_UPDATED', 'Schedule', schedule.id],
            ['SCHEDULE_DELETED', 'Schedule', schedule.id],
          ]),
        );
        expect(logs).toHaveLength(6);
        for (const log of logs) {
          expect(log).toMatchObject({
            actorUserId: fx.users.orgAdmin,
            ipAddress: '127.0.0.1',
            correlationId: 'scheduling-db-spec',
          });
        }
        const shiftUpdate = logs.find(
          (log) => log.action === 'SCHEDULED_SHIFT_UPDATED',
        );
        // Phase 19: entries are tagged with their organization (audit viewer / retention).
        expect(shiftUpdate?.metadata).toEqual({
          organizationId: fx.orgA,
          scheduleId: schedule.id,
          changes: {
            endsAt: {
              from: '2026-10-06T21:00:00.000Z',
              to: '2026-10-06T22:00:00.000Z',
            },
          },
        });
        const scheduleUpdate = logs.find(
          (log) => log.action === 'SCHEDULE_UPDATED',
        );
        expect(scheduleUpdate?.metadata).toEqual({
          organizationId: fx.orgA,
          changes: { name: { from: 'Dept A week 41', to: 'Final' } },
        });
      });
    });

    it('writes no audit entry for rejected or no-op mutations', async () => {
      await scenario(async ({ tx, fx, service }) => {
        const admin = ctx(fx.users.orgAdmin);
        const schedule = await service.createSchedule(deptASchedule(fx), admin);
        await service.updateSchedule(
          schedule.id,
          { name: 'Dept A week 41' },
          admin,
        );
        await expect(
          service.updateSchedule(
            schedule.id,
            { name: 'x' },
            ctx(fx.users.deptAReader),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(
          await tx.auditLog.count({ where: { entityId: schedule.id } }),
        ).toBe(1);
      });
    });
  });
});

function schedulingService(tx: Tx) {
  // Route the service's own $transaction calls into the test transaction so it rolls back.
  const prisma = new Proxy(tx, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (run: (client: Tx) => Promise<unknown>) => run(tx);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as PrismaService;
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

  const [readPermission, managePermission] = await Promise.all(
    (['schedule.read', 'schedule.manage'] as const).map((key) =>
      tx.permission.upsert({
        where: { key },
        create: { key, name: key, isActive: true },
        update: { isActive: true },
      }),
    ),
  );

  const orgA = await tx.organization.create({
    data: { name: 'Sched Org A', code: code('SA') },
  });
  const orgB = await tx.organization.create({
    data: { name: 'Sched Org B', code: code('SB') },
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
  const orgBDept = await tx.department.create({
    data: { organizationId: orgB.id, name: 'Org B Dept', code: code('OBD') },
  });

  const jobTitleA = await tx.jobTitle.create({
    data: { organizationId: orgA.id, name: 'Associate', code: code('JA') },
  });
  const jobTitleB = await tx.jobTitle.create({
    data: { organizationId: orgB.id, name: 'Associate', code: code('JB') },
  });
  const positionTeamA = await tx.position.create({
    data: {
      organizationId: orgA.id,
      jobTitleId: jobTitleA.id,
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
      jobTitleId: jobTitleA.id,
      organizationalUnitId: unitB.id,
      departmentId: deptB.id,
      name: 'Dept B Associate',
      code: code('PDB'),
    },
  });
  const positionOrgB = await tx.position.create({
    data: {
      organizationId: orgB.id,
      jobTitleId: jobTitleB.id,
      departmentId: orgBDept.id,
      name: 'Org B Associate',
      code: code('POB'),
    },
  });

  const workLocation = (
    organizationId: string,
    prefix: string,
    timezone: string | null,
    archivedAt: Date | null = null,
  ) =>
    tx.workLocation.create({
      data: {
        organizationId,
        name: prefix,
        code: code(prefix),
        timezone,
        archivedAt,
      },
    });
  const workLocationToronto = await workLocation(
    orgA.id,
    'WTO',
    'America/Toronto',
  );
  const workLocationNoTimezone = await workLocation(orgA.id, 'WNT', null);
  const workLocationArchived = await workLocation(
    orgA.id,
    'WAR',
    'America/Toronto',
    new Date('2026-01-01T00:00:00.000Z'),
  );
  const workLocationOrgB = await workLocation(
    orgB.id,
    'WOB',
    'America/Toronto',
  );

  let employeeIndex = 0;
  const assignment = async (
    positionId: string,
    status: 'ACTIVE' | 'PLANNED' | 'CANCELLED',
    startDate: string,
  ) => {
    employeeIndex += 1;
    const person = await tx.person.create({ data: {} });
    const employee = await tx.employee.create({
      data: {
        personId: person.id,
        employeeNumber: code(`E${employeeIndex}`),
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const row = await tx.employmentAssignment.create({
      data: {
        employeeId: employee.id,
        positionId,
        employmentType: 'FULL_TIME',
        status,
        startDate: new Date(`${startDate}T00:00:00.000Z`),
      },
    });
    return row.id;
  };

  const role = async (organizationId: string, permissionId: string) => {
    const created = await tx.role.create({
      data: {
        organizationId,
        code: code(`R${randomUUID().slice(0, 6)}`),
        name: 'Scheduling role',
      },
    });
    await tx.rolePermission.create({
      data: { roleId: created.id, permissionId },
    });
    return created.id;
  };
  const manageA = await role(orgA.id, managePermission.id);
  const readA = await role(orgA.id, readPermission.id);
  const manageB = await role(orgB.id, managePermission.id);

  const user = async (
    label: string,
    grant?: {
      roleId: string;
      organizationId: string;
      scopeType: 'ORGANIZATION' | 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM';
      organizationalUnitId?: string;
      departmentId?: string;
      teamId?: string;
    },
  ) => {
    const person = await tx.person.create({ data: {} });
    const created = await tx.user.create({
      data: {
        personId: person.id,
        email: `${label}-${suffix.toLowerCase()}@example.com`,
        status: 'ACTIVE',
      },
    });
    if (grant) {
      await tx.roleAssignment.create({
        data: {
          userId: created.id,
          roleId: grant.roleId,
          roleOrganizationId: grant.organizationId,
          scopeType: grant.scopeType,
          organizationId: grant.organizationId,
          organizationalUnitId: grant.organizationalUnitId,
          departmentId: grant.departmentId,
          teamId: grant.teamId,
        },
      });
    }
    return created.id;
  };

  return {
    orgA: orgA.id,
    orgB: orgB.id,
    unitA: unitA.id,
    unitB: unitB.id,
    deptA: deptA.id,
    deptB: deptB.id,
    teamA: teamA.id,
    orgBDept: orgBDept.id,
    assignmentTeamA: await assignment(positionTeamA.id, 'ACTIVE', '2026-01-01'),
    assignmentDeptB: await assignment(positionDeptB.id, 'ACTIVE', '2026-01-01'),
    assignmentCancelled: await assignment(
      positionTeamA.id,
      'CANCELLED',
      '2026-01-01',
    ),
    assignmentFuture: await assignment(
      positionTeamA.id,
      'PLANNED',
      '2026-12-01',
    ),
    assignmentOrgB: await assignment(positionOrgB.id, 'ACTIVE', '2026-01-01'),
    workLocationToronto: workLocationToronto.id,
    workLocationNoTimezone: workLocationNoTimezone.id,
    workLocationArchived: workLocationArchived.id,
    workLocationOrgB: workLocationOrgB.id,
    users: {
      orgAdmin: await user('org-admin', {
        roleId: manageA,
        organizationId: orgA.id,
        scopeType: 'ORGANIZATION',
      }),
      deptAManager: await user('dept-a-manager', {
        roleId: manageA,
        organizationId: orgA.id,
        scopeType: 'DEPARTMENT',
        departmentId: deptA.id,
      }),
      deptAReader: await user('dept-a-reader', {
        roleId: readA,
        organizationId: orgA.id,
        scopeType: 'DEPARTMENT',
        departmentId: deptA.id,
      }),
      teamAManager: await user('team-a-manager', {
        roleId: manageA,
        organizationId: orgA.id,
        scopeType: 'TEAM',
        teamId: teamA.id,
      }),
      unitBManager: await user('unit-b-manager', {
        roleId: manageA,
        organizationId: orgA.id,
        scopeType: 'ORGANIZATIONAL_UNIT',
        organizationalUnitId: unitB.id,
      }),
      orgBAdmin: await user('org-b-admin', {
        roleId: manageB,
        organizationId: orgB.id,
        scopeType: 'ORGANIZATION',
      }),
      noAccess: await user('no-access'),
    },
  };
}
