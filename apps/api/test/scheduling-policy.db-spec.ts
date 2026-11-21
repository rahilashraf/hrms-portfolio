import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  schedulingServices,
  torontoShift,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  scheduler: [
    {
      permissions: [
        'schedule.read',
        'schedule.manage',
        'schedule.override_conflict',
        'schedule.publish',
        'schedule.manage_patterns',
      ],
      scope: 'org' as const,
    },
  ],
  deptAPolicy: [
    { permissions: ['schedule.manage_policy'], scope: 'deptA' as const },
  ],
  reader: [{ permissions: ['schedule.read'], scope: 'deptA' as const }],
  outsider: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'orgB' as const }],
};

type Services = ReturnType<typeof schedulingServices>;

interface Harness extends Services {
  tx: Tx;
  fx: SchedulingFixtures;
  /** Creates a policy as the organization admin. */
  policy: (
    scope:
      | { scopeType: 'ORGANIZATION' }
      | { scopeType: 'ORGANIZATIONAL_UNIT'; organizationalUnitId: string }
      | { scopeType: 'DEPARTMENT'; departmentId: string }
      | { scopeType: 'TEAM'; teamId: string },
    settings: Record<string, unknown>,
    from?: string,
    to?: string,
  ) => Promise<{ id: string }>;
}

describe('Scheduling policy (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (harness: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const svc = schedulingServices(rollbackClient(tx));
          await run({
            tx,
            fx,
            ...svc,
            policy: (scope, settings, from = '2027-01-01', to) =>
              svc.policies.createPolicy(
                {
                  ...scope,
                  organizationId: fx.orgA,
                  effectiveFrom: from,
                  ...(to ? { effectiveTo: to } : {}),
                  ...settings,
                } as never,
                ctx(fx.users.admin!),
              ),
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const resolve = (h: Harness, assignmentId: string, date: string) =>
    h.policies.resolvePolicy(h.fx.users.admin!, {
      employmentAssignmentId: assignmentId,
      date,
    });

  // ─── Management ─────────────────────────────────────────────────────────────

  describe('management', () => {
    it('creates, reads, lists, and audits policies with scoped authorization', async () => {
      await scenario(async (h) => {
        const { tx, fx, policies } = h;
        const created = await h.policy(
          { scopeType: 'DEPARTMENT', departmentId: fx.deptA },
          { minimumRestMinutes: 600, name: 'Dept A rest' },
        );
        expect(created).toMatchObject({
          scopeType: 'DEPARTMENT',
          departmentId: fx.deptA,
          name: 'Dept A rest',
          effectiveFrom: '2027-01-01',
          effectiveTo: null,
          minimumRestMinutes: 600,
          generationHorizonDays: null,
        });
        await expect(
          policies.getPolicy(fx.users.reader!, created.id),
        ).resolves.toMatchObject({ id: created.id });
        await expect(
          policies.getPolicy(fx.users.outsider!, created.id),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(
          (
            await policies.listPolicies(fx.users.reader!, {
              organizationId: fx.orgA,
            })
          ).items.map((row) => row.id),
        ).toEqual([created.id]);

        // A department-scoped manager manages that department only.
        await expect(
          policies.createPolicy(
            {
              scopeType: 'TEAM',
              organizationId: fx.orgA,
              teamId: fx.teamA,
              effectiveFrom: '2027-01-01',
              clockInEarlyMinutes: 10,
            },
            ctx(fx.users.deptAPolicy!),
          ),
        ).resolves.toBeDefined();
        for (const [user, scope] of [
          [fx.users.deptAPolicy!, { scopeType: 'ORGANIZATION' as const }],
          [
            fx.users.deptAPolicy!,
            { scopeType: 'DEPARTMENT' as const, departmentId: fx.deptB },
          ],
          [fx.users.scheduler!, { scopeType: 'ORGANIZATION' as const }],
          [
            fx.users.reader!,
            { scopeType: 'DEPARTMENT' as const, departmentId: fx.deptA },
          ],
          [fx.users.outsider!, { scopeType: 'ORGANIZATION' as const }],
        ] as const) {
          await expect(
            policies.createPolicy(
              {
                ...scope,
                organizationId: fx.orgA,
                effectiveFrom: '2028-01-01',
                requireWorkLocation: true,
              },
              ctx(user),
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
        }
        expect(
          await tx.auditLog.count({
            where: { action: 'SCHEDULE_POLICY_CREATED', entityId: created.id },
          }),
        ).toBe(1);
      });
    });

    it('validates scope, settings, and dates', async () => {
      await scenario(async (h) => {
        const { fx, policies } = h;
        const admin = ctx(fx.users.admin!);
        const base = { organizationId: fx.orgA, effectiveFrom: '2027-01-01' };
        for (const [input, type] of [
          [{ ...base, scopeType: 'ORGANIZATION' }, BadRequestException],
          [
            { ...base, scopeType: 'TEAM', requireWorkLocation: true },
            BadRequestException,
          ],
          [
            {
              ...base,
              scopeType: 'ORGANIZATION',
              effectiveTo: '2026-12-31',
              requireWorkLocation: true,
            },
            BadRequestException,
          ],
          [
            {
              scopeType: 'TEAM',
              organizationId: fx.orgB,
              teamId: fx.teamA,
              effectiveFrom: '2027-01-01',
              requireWorkLocation: true,
            },
            BadRequestException,
          ],
        ] as const) {
          await expect(
            policies.createPolicy(input as never, admin),
          ).rejects.toBeInstanceOf(type);
        }
      });
    });

    it('rejects overlapping periods for the same scope, allows touching ones and other scopes', async () => {
      await scenario(async (h) => {
        const { fx } = h;
        const org = { scopeType: 'ORGANIZATION' as const };
        await h.policy(
          org,
          { generationHorizonDays: 30 },
          '2027-01-01',
          '2027-03-31',
        );
        const error = await rejection(
          h.policy(
            org,
            { generationHorizonDays: 40 },
            '2027-03-01',
            '2027-04-30',
          ),
        );
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'SCHEDULE_POLICY_PERIOD_OVERLAP',
        });
        await expect(
          h.policy(org, { generationHorizonDays: 40 }, '2027-04-01'),
        ).resolves.toBeDefined();
        await expect(
          h.policy(org, { generationHorizonDays: 50 }, '2028-01-01'),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          h.policy(
            { scopeType: 'DEPARTMENT', departmentId: fx.deptA },
            { generationHorizonDays: 10 },
            '2027-03-01',
          ),
        ).resolves.toBeDefined();
      });
    });

    it('edits future policies, ends policies in effect, and preserves history', async () => {
      await scenario(async (h) => {
        const { tx, fx, policies } = h;
        const admin = ctx(fx.users.admin!);
        const future = await h.policy(
          { scopeType: 'ORGANIZATION' },
          { generationHorizonDays: 30, minimumRestMinutes: 480 },
          '2030-01-01',
        );
        const updated = await policies.updatePolicy(
          future.id,
          {
            generationHorizonDays: 45,
            minimumRestMinutes: null,
            name: 'Future',
          },
          admin,
        );
        expect(updated).toMatchObject({
          generationHorizonDays: 45,
          minimumRestMinutes: null,
          name: 'Future',
        });
        await expect(
          policies.updatePolicy(
            future.id,
            { generationHorizonDays: null },
            admin,
          ),
        ).rejects.toThrow('at least one setting');
        await policies.deletePolicy(future.id, admin);

        const started = await h.policy(
          { scopeType: 'ORGANIZATION' },
          { requireWorkLocation: true },
          '2026-01-01',
        );
        for (const attempt of [
          () =>
            policies.updatePolicy(
              started.id,
              { requireWorkLocation: false },
              admin,
            ),
          () => policies.deletePolicy(started.id, admin),
        ]) {
          await expect(attempt()).rejects.toThrow('is in effect');
        }
        await expect(
          policies.endPolicy(started.id, { effectiveTo: '2026-02-01' }, admin),
        ).rejects.toThrow('before yesterday');
        const ended = await policies.endPolicy(
          started.id,
          { effectiveTo: '2029-12-31' },
          admin,
        );
        expect(ended).toMatchObject({
          effectiveFrom: '2026-01-01',
          effectiveTo: '2029-12-31',
        });
        await expect(
          policies.endPolicy(started.id, { effectiveTo: '2030-06-30' }, admin),
        ).rejects.toThrow('only shorten');
        await expect(
          policies.endPolicy(started.id, { effectiveTo: '2029-12-31' }, admin),
        ).resolves.toEqual(ended);
        // The successor starts the next day; the old row remains as history.
        await h.policy(
          { scopeType: 'ORGANIZATION' },
          { requireWorkLocation: false },
          '2030-01-01',
        );
        expect(
          (await resolve(h, fx.assignmentTeamA, '2029-12-31'))
            .requireWorkLocation,
        ).toBe(true);
        expect(
          (await resolve(h, fx.assignmentTeamA, '2030-01-01'))
            .requireWorkLocation,
        ).toBe(false);
        expect(
          (
            await tx.auditLog.findMany({
              where: { entityId: { in: [future.id, started.id] } },
              orderBy: { occurredAt: 'asc' },
            })
          ).map((row) => row.action),
        ).toEqual([
          'SCHEDULE_POLICY_CREATED',
          'SCHEDULE_POLICY_UPDATED',
          'SCHEDULE_POLICY_DELETED',
          'SCHEDULE_POLICY_CREATED',
          'SCHEDULE_POLICY_ENDED',
        ]);
      });
    });

    it('enforces database constraints on settings, shape, and periods', async () => {
      await scenario(async ({ tx, fx }) => {
        const base = {
          scopeType: 'ORGANIZATION' as const,
          organizationId: fx.orgA,
          effectiveFrom: new Date('2027-01-01T00:00:00Z'),
        };
        for (const data of [
          base,
          { ...base, generationHorizonDays: 0 },
          { ...base, generationHorizonDays: 367 },
          { ...base, clockInEarlyMinutes: -1 },
          { ...base, minimumRestMinutes: 3000 },
          { ...base, maximumShiftDurationMinutes: 0 },
          { ...base, requireWorkLocation: true, teamId: fx.teamA },
          {
            ...base,
            requireWorkLocation: true,
            effectiveTo: new Date('2026-12-31T00:00:00Z'),
          },
          { ...base, requireWorkLocation: true, name: ' ' },
        ]) {
          expect(
            await violation(tx, () => tx.schedulePolicy.create({ data })),
          ).toMatchObject({
            code: expect.stringMatching(/^P(2004|2010|2011|2039)$/),
          });
        }
      });
    });
  });

  // ─── Inheritance ────────────────────────────────────────────────────────────

  describe('inheritance', () => {
    it('resolves per field: team over department over units over organization, never WorkLocation', async () => {
      await scenario(async (h) => {
        const { fx } = h;
        const org = await h.policy(
          { scopeType: 'ORGANIZATION' },
          {
            generationHorizonDays: 30,
            minimumRestMinutes: 720,
            clockInEarlyMinutes: 50,
            unscheduledWorkMode: 'WARN_UNSCHEDULED',
          },
        );
        const root = await h.policy(
          {
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationalUnitId: fx.unitRoot,
          },
          { clockInEarlyMinutes: 40, clockInLateMinutes: 35 },
        );
        const child = await h.policy(
          {
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationalUnitId: fx.unitChild,
          },
          { clockInEarlyMinutes: 20 },
        );
        const dept = await h.policy(
          { scopeType: 'DEPARTMENT', departmentId: fx.deptA },
          { minimumRestMinutes: 600, requireWorkLocation: true },
        );
        const team = await h.policy(
          { scopeType: 'TEAM', teamId: fx.teamA },
          { minimumRestMinutes: 480 },
        );
        const teamA = await resolve(h, fx.assignmentTeamA, '2027-03-01');
        expect(teamA).toMatchObject({
          minimumRestMinutes: 480,
          requireWorkLocation: true,
          clockInEarlyMinutes: 20,
          clockInLateMinutes: 35,
          generationHorizonDays: 30,
          unscheduledWorkMode: 'WARN_UNSCHEDULED',
          autoCreateSchedules: true,
        });
        expect(teamA.sources).toMatchObject({
          minimumRestMinutes: { policyId: team.id },
          requireWorkLocation: { policyId: dept.id },
          clockInEarlyMinutes: { policyId: child.id },
          clockInLateMinutes: { policyId: root.id },
          generationHorizonDays: { policyId: org.id },
          autoCreateSchedules: 'DEFAULT',
        });
        // Dept B has no unit: only the organization applies.
        expect(
          await resolve(h, fx.assignmentDeptB, '2027-03-01'),
        ).toMatchObject({
          minimumRestMinutes: 720,
          requireWorkLocation: false,
          clockInEarlyMinutes: 50,
        });
        // Before any policy takes effect, the built-in defaults apply.
        expect(
          await resolve(h, fx.assignmentTeamA, '2026-12-31'),
        ).toMatchObject({
          generationHorizonDays: 90,
          minimumRestMinutes: null,
          unscheduledWorkMode: 'ALLOW_UNSCHEDULED',
        });
        // The resolve endpoint is scoped like any read.
        await expect(
          h.policies.resolvePolicy(fx.users.outsider!, {
            employmentAssignmentId: fx.assignmentTeamA,
            date: '2027-03-01',
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          h.policies.resolvePolicy(fx.users.reader!, {
            employmentAssignmentId: fx.assignmentDeptB,
            date: '2027-03-01',
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  // ─── Generation ─────────────────────────────────────────────────────────────

  describe('generation', () => {
    const weekdays = () =>
      (['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const).map(
        (dayOfWeek) => ({
          weekIndex: 0,
          dayOfWeek,
          startLocalTime: '09:00',
          endLocalTime: '17:00',
          timezone: 'America/Toronto',
        }),
      );

    it('uses the resolved horizon, period, and auto-creation setting', async () => {
      await scenario(async (h) => {
        const { tx, fx, patterns, generation } = h;
        await h.policy(
          { scopeType: 'TEAM', teamId: fx.teamA },
          { generationHorizonDays: 9, defaultSchedulePeriod: 'WEEKLY' },
        );
        const created = await patterns.createPattern(
          fx.assignmentTeamA,
          {
            effectiveFrom: '2027-03-01',
            anchorDate: '2027-03-01',
            rotationWeeks: 1,
            rules: weekdays(),
          },
          ctx(fx.users.admin!),
        );
        const job = await generation.extendGeneratedShifts({
          asOf: new Date('2027-03-01T12:00:00Z'),
          organizationId: fx.orgA,
        });
        expect(job.range.to).toBeNull();
        const shifts = await tx.scheduledShift.findMany({
          where: { sourcePatternId: created.id },
          include: { schedule: true },
          orderBy: { startsAt: 'asc' },
        });
        // Mar 1 + 9 days = Mar 10: two working weeks' worth up to Wednesday.
        expect(
          shifts.map((row) => row.workDate.toISOString().slice(0, 10)),
        ).toEqual([
          '2027-03-01',
          '2027-03-02',
          '2027-03-03',
          '2027-03-04',
          '2027-03-05',
          '2027-03-08',
          '2027-03-09',
          '2027-03-10',
        ]);
        expect([
          ...new Set(
            shifts.map((row) => row.schedule.periodStart.toISOString()),
          ),
        ]).toEqual(['2027-03-01T00:00:00.000Z', '2027-03-08T00:00:00.000Z']);

        // A manual run without "to" also follows the policy horizon.
        const manual = await generation.generateForPattern(
          fx.assignmentTeamA,
          created.id,
          { from: '2027-03-08' },
          ctx(fx.users.admin!),
        );
        expect(manual.range).toEqual({ from: '2027-03-08', to: '2027-03-17' });
      });
    });

    it('does not create containers when the policy disables auto-creation', async () => {
      await scenario(async (h) => {
        const { fx, patterns, generation, scheduling } = h;
        await h.policy(
          { scopeType: 'ORGANIZATION' },
          { autoCreateSchedules: false },
        );
        const created = await patterns.createPattern(
          fx.assignmentTeamA,
          {
            effectiveFrom: '2027-03-01',
            anchorDate: '2027-03-01',
            rotationWeeks: 1,
            rules: weekdays().slice(0, 1),
          },
          ctx(fx.users.admin!),
        );
        const existing = await scheduling.createSchedule(
          {
            scopeType: 'TEAM',
            organizationId: fx.orgA,
            teamId: fx.teamA,
            name: 'Prepared week',
            type: 'STANDARD',
            periodStart: '2027-03-01',
            periodEnd: '2027-03-07',
          },
          ctx(fx.users.admin!),
        );
        const result = await generation.generateForPattern(
          fx.assignmentTeamA,
          created.id,
          { from: '2027-03-01', to: '2027-03-14' },
          ctx(fx.users.admin!),
        );
        expect(result).toMatchObject({ created: 1, schedulesCreated: [] });
        expect(result.blocked).toEqual([
          expect.objectContaining({
            code: 'SCHEDULE_CONTAINER_MISSING',
            workDate: '2027-03-08',
          }),
        ]);
        expect(existing.id).toBeDefined();
      });
    });

    it('requires a WorkLocation on generated occurrences when the policy says so', async () => {
      await scenario(async (h) => {
        const { fx, patterns, generation } = h;
        await h.policy(
          { scopeType: 'DEPARTMENT', departmentId: fx.deptA },
          { requireWorkLocation: true },
        );
        const created = await patterns.createPattern(
          fx.assignmentTeamA,
          {
            effectiveFrom: '2027-03-01',
            anchorDate: '2027-03-01',
            rotationWeeks: 1,
            rules: [
              weekdays()[0]!,
              { ...weekdays()[1]!, workLocationId: fx.workLocationToronto },
            ],
          },
          ctx(fx.users.admin!),
        );
        const result = await generation.generateForPattern(
          fx.assignmentTeamA,
          created.id,
          { from: '2027-03-01', to: '2027-03-07' },
          ctx(fx.users.admin!),
        );
        expect(result.created).toBe(1);
        expect(
          result.errors.map((issue) => [issue.workDate, issue.code]),
        ).toEqual([['2027-03-01', 'WORK_LOCATION_REQUIRED']]);
      });
    });

    it('blocks generated occurrences that violate policy conflict rules', async () => {
      await scenario(async (h) => {
        const { fx, patterns, generation } = h;
        await h.policy(
          { scopeType: 'ORGANIZATION' },
          { maximumShiftDurationMinutes: 420 },
        );
        const created = await patterns.createPattern(
          fx.assignmentTeamA,
          {
            effectiveFrom: '2027-03-01',
            anchorDate: '2027-03-01',
            rotationWeeks: 1,
            rules: weekdays().slice(0, 2),
          },
          ctx(fx.users.admin!),
        );
        const result = await generation.generateForPattern(
          fx.assignmentTeamA,
          created.id,
          { from: '2027-03-01', to: '2027-03-07' },
          ctx(fx.users.admin!),
        );
        expect(result.created).toBe(0);
        expect(result.blocked.map((issue) => issue.code)).toEqual([
          'MAXIMUM_SHIFT_DURATION_EXCEEDED',
          'MAXIMUM_SHIFT_DURATION_EXCEEDED',
        ]);
      });
    });
  });

  // ─── Conflicts ──────────────────────────────────────────────────────────────

  describe('conflicts', () => {
    async function draftWeek(h: Harness, scope: 'deptA' | 'deptB') {
      return (
        await h.scheduling.createSchedule(
          {
            scopeType: 'DEPARTMENT',
            organizationId: h.fx.orgA,
            departmentId: scope === 'deptA' ? h.fx.deptA : h.fx.deptB,
            name: `Week ${scope}`,
            type: 'STANDARD',
            periodStart: '2027-03-01',
            periodEnd: '2027-03-07',
          },
          ctx(h.fx.users.admin!),
        )
      ).id;
    }

    it('requires an override for a minimum-rest violation and records it', async () => {
      await scenario(async (h) => {
        const { tx, fx, scheduling } = h;
        await h.policy(
          { scopeType: 'ORGANIZATION' },
          { minimumRestMinutes: 600 },
        );
        const admin = ctx(fx.users.admin!);
        const week = await draftWeek(h, 'deptA');
        const first = await scheduling.createShift(
          week,
          torontoShift(fx.assignmentTeamA, '2027-03-01', '09:00', '17:00'),
          admin,
        );
        const late = torontoShift(
          fx.assignmentTeamA,
          '2027-03-02',
          '01:00',
          '05:00',
        );
        const body = (
          (await rejection(
            scheduling.createShift(week, late, admin),
          )) as ConflictException
        ).getResponse() as {
          code: string;
          conflicts: Array<{
            key: string;
            type: string;
            conflictingShift: { id: string };
          }>;
        };
        expect(body.code).toBe('SCHEDULE_CONFLICT_OVERRIDE_REQUIRED');
        expect(body.conflicts).toEqual([
          expect.objectContaining({
            type: 'MINIMUM_REST_VIOLATION',
            severity: 'WARNING',
            conflictingShift: expect.objectContaining({ id: first.id }),
          }),
        ]);
        const saved = await scheduling.createShift(
          week,
          {
            ...late,
            conflictOverrides: [
              {
                conflictType: 'MINIMUM_REST_VIOLATION',
                conflictKey: body.conflicts[0]!.key,
                reason: 'Approved short turnaround',
              },
            ],
          },
          admin,
        );
        await expect(
          tx.scheduleConflictOverride.findFirst({
            where: { scheduledShiftId: saved.id },
          }),
        ).resolves.toMatchObject({
          conflictType: 'MINIMUM_REST_VIOLATION',
          conflictingShiftId: first.id,
        });
        // Same-assignment overlap is still a hard error regardless of policy.
        await expect(
          scheduling.createShift(
            week,
            torontoShift(fx.assignmentTeamA, '2027-03-01', '12:00', '13:00'),
            admin,
          ),
        ).rejects.toThrow('cannot be saved');
      });
    });

    it('requires an override for an over-long shift, honoring it on later unchanged edits', async () => {
      await scenario(async (h) => {
        const { tx, fx, scheduling } = h;
        await h.policy(
          { scopeType: 'TEAM', teamId: fx.teamA },
          { maximumShiftDurationMinutes: 600 },
        );
        const admin = ctx(fx.users.admin!);
        const week = await draftWeek(h, 'deptA');
        const long = torontoShift(
          fx.assignmentTeamA,
          '2027-03-03',
          '07:00',
          '19:00',
        );
        const body = (
          (await rejection(
            scheduling.createShift(week, long, admin),
          )) as ConflictException
        ).getResponse() as {
          code: string;
          conflicts: Array<{
            key: string;
            type: string;
            conflictingShift: unknown;
          }>;
        };
        expect(body.conflicts).toEqual([
          expect.objectContaining({
            type: 'MAXIMUM_SHIFT_DURATION_EXCEEDED',
            conflictingShift: null,
          }),
        ]);
        const saved = await scheduling.createShift(
          week,
          {
            ...long,
            conflictOverrides: [
              {
                conflictType: 'MAXIMUM_SHIFT_DURATION_EXCEEDED',
                conflictKey: body.conflicts[0]!.key,
                reason: 'Inventory day',
              },
            ],
          },
          admin,
        );
        await expect(
          tx.scheduleConflictOverride.findFirst({
            where: { scheduledShiftId: saved.id },
          }),
        ).resolves.toMatchObject({ conflictingShiftId: null });
        // Changing something that is not part of the conflict state keeps the approval.
        await expect(
          scheduling.updateShift(
            week,
            saved.id,
            { workLocationId: fx.workLocationToronto },
            admin,
          ),
        ).resolves.toMatchObject({ workLocationId: fx.workLocationToronto });
        // The limit is Team A's: an organization-level position keeps the default (none).
        await expect(
          scheduling.createShift(
            week,
            torontoShift(fx.orgLevel, '2027-03-03', '07:00', '19:00'),
            admin,
          ),
        ).resolves.toBeDefined();
      });
    });

    it('applies overlap severity and the override switch from policy', async () => {
      await scenario(async (h) => {
        const { fx, scheduling } = h;
        const admin = ctx(fx.users.admin!);
        const deptA = await draftWeek(h, 'deptA');
        const deptB = await draftWeek(h, 'deptB');
        await scheduling.createShift(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-04', '09:00', '13:00'),
          admin,
        );
        // Dept B (Employee 1's other assignment) treats cross-assignment overlap as an ERROR.
        await h.policy(
          { scopeType: 'DEPARTMENT', departmentId: fx.deptB },
          { overlapConflictSeverity: 'ERROR' },
        );
        const error = (await rejection(
          scheduling.createShift(
            deptB,
            torontoShift(fx.assignmentDeptB, '2027-03-04', '12:00', '16:00'),
            admin,
          ),
        )) as ConflictException;
        expect(error.getResponse()).toMatchObject({
          code: 'SCHEDULE_CONFLICT_ERROR',
          conflicts: [
            expect.objectContaining({
              type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              severity: 'ERROR',
              overrideAllowed: false,
            }),
          ],
        });
        // With overrides disabled, a would-be warning blocks as an error too.
        await h.policy(
          { scopeType: 'TEAM', teamId: fx.teamA },
          {
            allowManagerConflictOverride: false,
            maximumShiftDurationMinutes: 120,
          },
        );
        const blocked = (await rejection(
          scheduling.createShift(
            deptA,
            torontoShift(fx.assignmentTeamA, '2027-03-05', '09:00', '13:00'),
            admin,
          ),
        )) as ConflictException;
        expect(blocked.getResponse()).toMatchObject({
          code: 'SCHEDULE_CONFLICT_ERROR',
          conflicts: [
            expect.objectContaining({
              type: 'MAXIMUM_SHIFT_DURATION_EXCEEDED',
              overrideAllowed: false,
            }),
          ],
        });
      });
    });

    it('requires a WorkLocation on new or changed shifts without invalidating published ones', async () => {
      await scenario(async (h) => {
        const { fx, scheduling } = h;
        const admin = ctx(fx.users.admin!);
        const week = await draftWeek(h, 'deptA');
        const published = await scheduling.createShift(
          week,
          torontoShift(fx.assignmentTeamA, '2027-03-01', '09:00', '17:00'),
          admin,
        );
        await scheduling.publishSchedule(week, admin);
        await h.policy(
          { scopeType: 'ORGANIZATION' },
          { requireWorkLocation: true },
        );

        const draft = await draftWeek(h, 'deptB');
        await expect(
          scheduling.createShift(
            draft,
            torontoShift(fx.assignmentDeptB, '2027-03-02', '09:00', '17:00'),
            admin,
          ),
        ).rejects.toThrow('requires a WorkLocation');
        await expect(
          scheduling.createShift(
            draft,
            {
              ...torontoShift(
                fx.assignmentDeptB,
                '2027-03-02',
                '09:00',
                '17:00',
              ),
              workLocationId: fx.workLocationOttawa,
            },
            admin,
          ),
        ).resolves.toBeDefined();
        // The published shift stays valid and can still be cancelled; a correction must add one.
        await expect(
          scheduling.getShift(fx.users.admin!, week, published.id),
        ).resolves.toMatchObject({ workLocationId: null });
        await expect(
          scheduling.correctShift(
            week,
            published.id,
            { reason: 'Later', endsAt: '2027-03-01T18:00:00-05:00' },
            admin,
          ),
        ).rejects.toThrow('requires a WorkLocation');
        await expect(
          scheduling.correctShift(
            week,
            published.id,
            {
              reason: 'Later at Toronto',
              endsAt: '2027-03-01T18:00:00-05:00',
              workLocationId: fx.workLocationToronto,
            },
            admin,
          ),
        ).resolves.toMatchObject({ revision: { revisionNumber: 2 } });
      });
    });
  });

  // ─── Concurrency ────────────────────────────────────────────────────────────

  describe('concurrency', () => {
    let fx: SchedulingFixtures;

    beforeAll(async () => {
      fx = await prisma.$transaction(
        (tx) => createSchedulingFixtures(tx, USERS),
        {
          timeout: 60_000,
        },
      );
    });

    afterAll(async () => {
      if (fx) await cleanupSchedulingFixtures(prisma, fx);
    });

    it('never creates overlapping policies for one scope under concurrent requests', async () => {
      const client = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property === '$transaction') {
            return (run: (tx: Tx) => Promise<unknown>) =>
              target.$transaction((tx) =>
                run(
                  new Proxy(tx, {
                    get(inner, key, innerReceiver) {
                      const value = Reflect.get(
                        inner,
                        key,
                        innerReceiver,
                      ) as unknown;
                      if (key !== 'schedulePolicy') return value;
                      return new Proxy(value as object, {
                        get(delegate, method, r) {
                          const fn = Reflect.get(
                            delegate,
                            method,
                            r,
                          ) as unknown;
                          if (
                            method !== 'findFirst' ||
                            typeof fn !== 'function'
                          )
                            return fn;
                          return async (...args: unknown[]) => {
                            const result = await (
                              fn as (...a: unknown[]) => Promise<unknown>
                            ).apply(delegate, args);
                            await new Promise((resolve) =>
                              setTimeout(resolve, 200),
                            );
                            return result;
                          };
                        },
                      });
                    },
                  }),
                ),
              );
          }
          return Reflect.get(target, property, receiver);
        },
      }) as unknown as PrismaService;
      const { policies } = schedulingServices(client);
      const input = (from: string) => ({
        scopeType: 'TEAM' as const,
        organizationId: fx.orgA,
        teamId: fx.teamA,
        effectiveFrom: from,
        minimumRestMinutes: 480,
      });
      const results = await Promise.allSettled([
        policies.createPolicy(input('2027-01-01'), ctx(fx.users.admin!)),
        policies.createPolicy(input('2027-02-01'), ctx(fx.users.admin!)),
        policies.createPolicy(input('2027-03-01'), ctx(fx.users.admin!)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.schedulePolicy.count({ where: { teamId: fx.teamA } }),
      ).toBe(1);
    });
  });
});
