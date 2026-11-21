import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { SchedulingViewService } from '../src/scheduling/scheduling-view.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  schedulingServices,
  torontoShift,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  deptAManager: [
    {
      permissions: [
        'schedule.read',
        'schedule.manage',
        'schedule.publish',
        'schedule.override_conflict',
      ],
      scope: 'deptA' as const,
    },
  ],
  deptAReader: [{ permissions: ['schedule.read'], scope: 'deptA' as const }],
  patternManager: [
    {
      permissions: ['schedule.read', 'schedule.manage_patterns'],
      scope: 'org' as const,
    },
  ],
  outsider: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'orgB' as const }],
};

interface World {
  deptADraft: string;
  deptAPublished: string;
  deptBPublished: string;
  shifts: Record<string, string>;
}

function views(prisma: PrismaService) {
  const svc = schedulingServices(prisma);
  return new SchedulingViewService(
    prisma,
    svc.domain,
    svc.authorization,
    svc.targets,
    svc.policyResolver,
  );
}

describe('Scheduling views (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * Week of 2027-03-01: a Dept A draft and a Dept A published schedule, a Dept B published
   * schedule, plus one generated (PATTERN) shift in a Team A container.
   */
  async function scenario(
    run: (h: {
      tx: Tx;
      fx: SchedulingFixtures;
      world: World;
      view: SchedulingViewService;
      svc: ReturnType<typeof schedulingServices>;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const client = rollbackClient(tx);
          const svc = schedulingServices(client);
          const admin = ctx(fx.users.admin!);
          const schedule = async (
            departmentId: string,
            name: string,
            type: 'STANDARD' | 'AD_HOC' = 'AD_HOC',
          ) =>
            (
              await svc.scheduling.createSchedule(
                {
                  scopeType: 'DEPARTMENT',
                  organizationId: fx.orgA,
                  departmentId,
                  name,
                  type,
                  periodStart: '2027-03-01',
                  periodEnd: '2027-03-07',
                },
                admin,
              )
            ).id;
          const deptADraft = await schedule(fx.deptA, 'A draft');
          const deptAPublished = await schedule(fx.deptA, 'A published');
          const deptBPublished = await schedule(fx.deptB, 'B published');
          const add = async (
            scheduleId: string,
            input: ReturnType<typeof torontoShift>,
          ) => (await svc.scheduling.createShift(scheduleId, input, admin)).id;
          const shifts: Record<string, string> = {
            draftE1: await add(
              deptADraft,
              torontoShift(fx.assignmentTeamA, '2027-03-01', '06:00', '08:00'),
            ),
            pubE1: await add(deptAPublished, {
              ...torontoShift(
                fx.assignmentTeamA,
                '2027-03-02',
                '09:00',
                '17:00',
              ),
              workLocationId: fx.workLocationToronto,
            } as never),
            pubE1Cancelled: await add(
              deptAPublished,
              torontoShift(fx.assignmentTeamA, '2027-03-03', '09:00', '17:00'),
            ),
            pubE2: await add(
              deptAPublished,
              torontoShift(fx.otherTeamA, '2027-03-02', '09:00', '17:00'),
            ),
            pubE1DeptB: await add(
              deptBPublished,
              torontoShift(fx.assignmentDeptB, '2027-03-04', '18:00', '22:00'),
            ),
          };
          await svc.scheduling.publishSchedule(deptAPublished, admin);
          await svc.scheduling.publishSchedule(deptBPublished, admin);
          await svc.scheduling.cancelShift(
            deptAPublished,
            shifts.pubE1Cancelled!,
            { reason: 'Closed' },
            admin,
          );
          const pattern = await svc.patterns.createPattern(
            fx.otherTeamA,
            {
              effectiveFrom: '2027-03-01',
              anchorDate: '2027-03-01',
              rotationWeeks: 1,
              rules: [
                {
                  weekIndex: 0,
                  dayOfWeek: 'FRIDAY',
                  startLocalTime: '09:00',
                  endLocalTime: '17:00',
                  timezone: 'America/Toronto',
                },
              ],
            },
            admin,
          );
          await svc.generation.generateForPattern(
            fx.otherTeamA,
            pattern.id,
            { from: '2027-03-01', to: '2027-03-07' },
            admin,
          );
          shifts.generated = (
            await tx.scheduledShift.findFirstOrThrow({
              where: { sourcePatternId: pattern.id },
            })
          ).id;
          await run({
            tx,
            fx,
            world: { deptADraft, deptAPublished, deptBPublished, shifts },
            view: views(client),
            svc,
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const WEEK = { from: '2027-03-01', to: '2027-03-07' };

  // ─── Employee view ──────────────────────────────────────────────────────────

  describe('employee view', () => {
    it('shows only the employee’s own published shifts across all assignments', async () => {
      await scenario(async ({ fx, world, view }) => {
        const mine = await view.mySchedule(fx.selfUser1, WEEK);
        expect(mine.employeeId).toBe(fx.employee1);
        expect(mine.items.map((item) => item.id)).toEqual([
          world.shifts.pubE1,
          world.shifts.pubE1DeptB,
        ]);
        expect(mine.items[0]).toMatchObject({
          employmentAssignmentId: fx.assignmentTeamA,
          workDate: '2027-03-02',
          startsAt: '2027-03-02T14:00:00.000Z',
          endsAt: '2027-03-02T22:00:00.000Z',
          durationMinutes: 480,
          timezone: 'America/Toronto',
          status: 'ACTIVE',
          sourceType: 'MANUAL',
          schedule: { id: world.deptAPublished, status: 'PUBLISHED' },
          assignment: {
            position: { id: fx.positionTeamA, teamId: fx.teamA },
            organization: { id: fx.orgA },
          },
          workLocation: {
            id: fx.workLocationToronto,
            timezone: 'America/Toronto',
          },
          currentRevision: {
            revisionNumber: 1,
            revisionType: 'PUBLISHED_BASELINE',
          },
          actions: {},
        });
        expect(mine.items[1]).toMatchObject({
          employmentAssignmentId: fx.assignmentDeptB,
          schedule: { id: world.deptBPublished },
        });
        // Cancelled shifts only on request; drafts never.
        const withCancelled = await view.mySchedule(fx.selfUser1, {
          ...WEEK,
          includeCancelled: true,
        });
        expect(
          withCancelled.items.map((item) => [item.id, item.status]),
        ).toEqual([
          [world.shifts.pubE1, 'ACTIVE'],
          [world.shifts.pubE1Cancelled, 'CANCELLED'],
          [world.shifts.pubE1DeptB, 'ACTIVE'],
        ]);
        // The other employee sees their own work, including generated shifts once published.
        const theirs = await view.mySchedule(fx.selfUser2, WEEK);
        expect(theirs.items.map((item) => item.id)).toEqual([
          world.shifts.pubE2,
        ]);
      });
    });

    it('shows generated shifts once published and bounds the range', async () => {
      await scenario(async ({ fx, world, view, svc, tx }) => {
        const generated = await tx.scheduledShift.findUniqueOrThrow({
          where: { id: world.shifts.generated! },
        });
        await svc.scheduling.publishSchedule(
          generated.scheduleId,
          ctx(fx.users.admin!),
        );
        const theirs = await view.mySchedule(fx.selfUser2, WEEK);
        expect(theirs.items.map((item) => [item.id, item.sourceType])).toEqual([
          [world.shifts.pubE2, 'MANUAL'],
          [world.shifts.generated, 'PATTERN'],
        ]);
        await expect(
          view.mySchedule(fx.selfUser1, {
            from: '2027-03-01',
            to: '2027-05-15',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          view.mySchedule(fx.selfUser1, {
            from: '2027-03-07',
            to: '2027-03-01',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(
          (
            await view.mySchedule(fx.selfUser1, {
              from: '2027-03-03',
              to: '2027-03-03',
            })
          ).items,
        ).toEqual([]);
        await expect(
          view.mySchedule(fx.users.admin!, WEEK),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  // ─── Manager grid ───────────────────────────────────────────────────────────

  describe('manager grid', () => {
    const ids = async (
      view: SchedulingViewService,
      user: string,
      fx: SchedulingFixtures,
      filters: Record<string, unknown> = {},
    ) =>
      (
        await view.grid(user, {
          organizationId: fx.orgA,
          ...WEEK,
          ...filters,
        } as never)
      ).items.map((item) => item.id);

    it('shows each actor exactly the schedules in their scope', async () => {
      await scenario(async ({ fx, world, view }) => {
        const all = await ids(view, fx.users.admin!, fx);
        expect(new Set(all)).toEqual(new Set(Object.values(world.shifts)));
        expect(new Set(await ids(view, fx.users.deptAManager!, fx))).toEqual(
          new Set([
            world.shifts.draftE1,
            world.shifts.pubE1,
            world.shifts.pubE1Cancelled,
            world.shifts.pubE2,
            // The generated shift's Team A container is inside Dept A.
            world.shifts.generated,
          ]),
        );
        expect(await ids(view, fx.users.outsider!, fx)).toEqual([]);
        expect(await ids(view, fx.selfUser1, fx)).toEqual([]);
      });
    });

    it('filters by hierarchy, people, location, schedule, status, and source', async () => {
      await scenario(async ({ fx, world, view }) => {
        const admin = fx.users.admin!;
        const s = world.shifts;
        expect(
          new Set(await ids(view, admin, fx, { teamId: fx.teamA })),
        ).toEqual(
          new Set([s.draftE1, s.pubE1, s.pubE1Cancelled, s.pubE2, s.generated]),
        );
        expect(await ids(view, admin, fx, { departmentId: fx.deptB })).toEqual([
          s.pubE1DeptB,
        ]);
        // A unit filter includes positions in its descendant units.
        expect(
          (await ids(view, admin, fx, { organizationalUnitId: fx.unitRoot }))
            .length,
        ).toBe(5);
        expect(
          new Set(await ids(view, admin, fx, { employeeId: fx.employee2 })),
        ).toEqual(new Set([s.pubE2, s.generated]));
        expect(
          await ids(view, admin, fx, {
            employmentAssignmentId: fx.assignmentDeptB,
          }),
        ).toEqual([s.pubE1DeptB]);
        expect(
          await ids(view, admin, fx, { positionId: fx.positionDeptB }),
        ).toEqual([s.pubE1DeptB]);
        expect(
          await ids(view, admin, fx, {
            workLocationId: fx.workLocationToronto,
          }),
        ).toEqual([s.pubE1]);
        expect(
          new Set(await ids(view, admin, fx, { scheduleId: world.deptADraft })),
        ).toEqual(new Set([s.draftE1]));
        expect(await ids(view, admin, fx, { status: 'CANCELLED' })).toEqual([
          s.pubE1Cancelled,
        ]);
        expect(await ids(view, admin, fx, { sourceType: 'PATTERN' })).toEqual([
          s.generated,
        ]);
        expect(
          new Set(await ids(view, admin, fx, { scheduleStatus: 'DRAFT' })),
        ).toEqual(new Set([s.draftE1, s.generated]));
        expect(
          await ids(view, admin, fx, { from: '2027-03-04', to: '2027-03-04' }),
        ).toEqual([s.pubE1DeptB]);
        await expect(
          view.grid(admin, {
            organizationId: fx.orgA,
            from: '2027-01-01',
            to: '2027-04-01',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('pages in start order with a cursor', async () => {
      await scenario(async ({ fx, view }) => {
        const query = { organizationId: fx.orgA, ...WEEK, limit: 2 };
        const pages: string[][] = [];
        let afterId: string | undefined;
        do {
          const page = await view.grid(fx.users.admin!, {
            ...query,
            ...(afterId ? { afterId } : {}),
          });
          pages.push(page.items.map((item) => item.startsAt));
          afterId = page.nextAfterId ?? undefined;
        } while (afterId);
        expect(pages.map((page) => page.length)).toEqual([2, 2, 2]);
        const flat = pages.flat();
        expect(flat).toEqual([...flat].sort());
      });
    });

    it('computes actions from permissions and lifecycle state', async () => {
      await scenario(async ({ tx, fx, world, view }) => {
        const byId = async (user: string) =>
          new Map(
            (
              await view.grid(user, { organizationId: fx.orgA, ...WEEK })
            ).items.map((item) => [item.id, item.actions]),
          );
        const manager = await byId(fx.users.deptAManager!);
        expect(manager.get(world.shifts.draftE1)).toEqual({
          canEditDraft: true,
          canDeleteDraft: true,
          canPublish: true,
          canCorrect: false,
          canCancel: false,
          canOverrideConflict: true,
          canManagePattern: false,
        });
        expect(manager.get(world.shifts.pubE1)).toMatchObject({
          canEditDraft: false,
          canPublish: false,
          canCorrect: true,
          canCancel: true,
          canOverrideConflict: true,
        });
        expect(manager.get(world.shifts.pubE1Cancelled)).toMatchObject({
          canCorrect: false,
          canCancel: false,
          canOverrideConflict: false,
        });
        const reader = await byId(fx.users.deptAReader!);
        expect(
          [...reader.values()].every((actions) =>
            Object.values(actions).every((flag) => flag === false),
          ),
        ).toBe(true);
        const patterns = await byId(fx.users.patternManager!);
        expect(patterns.get(world.shifts.generated)).toMatchObject({
          canManagePattern: true,
          canEditDraft: false,
          canPublish: false,
        });
        const admin = await byId(fx.users.admin!);
        // Generated drafts are generator-owned: never editable as MANUAL drafts.
        expect(admin.get(world.shifts.generated)).toMatchObject({
          canEditDraft: false,
          canPublish: true,
          canManagePattern: true,
        });
        // A policy that disallows overrides removes the action.
        await tx.schedulePolicy.create({
          data: {
            scopeType: 'TEAM',
            organizationId: fx.orgA,
            teamId: fx.teamA,
            effectiveFrom: new Date('2027-01-01T00:00:00Z'),
            allowManagerConflictOverride: false,
          },
        });
        expect(
          (await byId(fx.users.deptAManager!)).get(world.shifts.draftE1),
        ).toMatchObject({
          canEditDraft: true,
          canOverrideConflict: false,
        });
      });
    });

    it('loads a page with a constant number of queries', async () => {
      await scenario(async ({ tx, fx, view, svc }) => {
        const counted = (client: Tx) => {
          let calls = 0;
          const proxy = new Proxy(client, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver) as unknown;
              if (
                typeof property !== 'string' ||
                property.startsWith('$') ||
                typeof value !== 'object' ||
                value === null
              ) {
                return value;
              }
              return new Proxy(value, {
                get(delegate, method, r) {
                  const fn = Reflect.get(delegate, method, r) as unknown;
                  if (typeof fn !== 'function') return fn;
                  return (...args: unknown[]) => {
                    calls += 1;
                    return (fn as (...a: unknown[]) => unknown).apply(
                      delegate,
                      args,
                    );
                  };
                },
              });
            },
          });
          return { client: proxy as Tx, count: () => calls };
        };
        const measure = async () => {
          const { client, count } = counted(tx);
          await views(rollbackClient(client)).grid(fx.users.deptAReader!, {
            organizationId: fx.orgA,
            ...WEEK,
          });
          return count();
        };
        const before = await measure();
        // Many more shifts for the same people and positions.
        const week = (
          await svc.scheduling.createSchedule(
            {
              scopeType: 'DEPARTMENT',
              organizationId: fx.orgA,
              departmentId: fx.deptA,
              name: 'More',
              type: 'AD_HOC',
              periodStart: '2027-03-01',
              periodEnd: '2027-03-07',
            },
            ctx(fx.users.admin!),
          )
        ).id;
        for (const day of ['2027-03-05', '2027-03-06', '2027-03-07']) {
          for (const [start, end] of [
            ['00:00', '02:00'],
            ['03:00', '05:00'],
            ['20:00', '22:00'],
          ] as const) {
            await svc.scheduling.createShift(
              week,
              torontoShift(fx.assignmentTeamA, day, start, end),
              ctx(fx.users.admin!),
            );
          }
        }
        expect(await measure()).toBe(before);
        void view;
      });
    });
  });

  // ─── Holiday markers (R4-A.6) ───────────────────────────────────────────────

  describe('holiday markers', () => {
    /** Organization A: org-wide, Team A, Dept A, Dept B and an archived one; one in B. */
    async function holidays(tx: Tx, fx: SchedulingFixtures) {
      const add = (
        organizationId: string,
        date: string,
        name: string,
        scope: { teamId?: string; departmentId?: string } = {},
        archived = false,
      ) =>
        tx.organizationHoliday.create({
          data: {
            organizationId,
            date: new Date(`${date}T00:00:00.000Z`),
            name,
            kind: name.includes('Closure') ? 'CLOSURE' : 'STATUTORY_HOLIDAY',
            ...scope,
            ...(archived
              ? { archivedAt: new Date('2027-01-01T00:00:00Z') }
              : {}),
          },
        });
      await add(fx.orgA, '2027-03-01', 'A Founders Day');
      await add(fx.orgA, '2027-03-02', 'Team A Closure', { teamId: fx.teamA });
      await add(fx.orgA, '2027-03-03', 'Dept B Day', {
        departmentId: fx.deptB,
      });
      await add(fx.orgA, '2027-03-05', 'Dept A Day', {
        departmentId: fx.deptA,
      });
      await add(fx.orgA, '2027-03-04', 'Withdrawn', {}, true);
      await add(fx.orgB, '2027-03-01', 'B Only Day');
      // Outside the range.
      await add(fx.orgA, '2027-03-08', 'Next Monday');
    }
    const names = (items: Array<{ name: string }>) =>
      items.map((item) => item.name);

    it('marks the holidays of each employee’s own assignments on My Schedule, date-only', async () => {
      await scenario(async ({ tx, fx, view }) => {
        await holidays(tx, fx);
        const one = await view.mySchedule(fx.selfUser1, WEEK);
        // Employee 1: Team A (in Dept A) and Dept B.
        expect(one.holidays).toEqual([
          {
            date: '2027-03-01',
            name: 'A Founders Day',
            kind: 'STATUTORY_HOLIDAY',
            organizationId: fx.orgA,
          },
          {
            date: '2027-03-02',
            name: 'Team A Closure',
            kind: 'CLOSURE',
            organizationId: fx.orgA,
          },
          expect.objectContaining({ date: '2027-03-03', name: 'Dept B Day' }),
          expect.objectContaining({ date: '2027-03-05', name: 'Dept A Day' }),
        ]);
        // Employee 2: Team A and an organization-level position; not Dept B's day.
        expect(
          names((await view.mySchedule(fx.selfUser2, WEEK)).holidays),
        ).toEqual(['A Founders Day', 'Team A Closure', 'Dept A Day']);
      });
    });

    it('shows managers only the holidays of the schedules they may see', async () => {
      await scenario(async ({ tx, fx, view }) => {
        await holidays(tx, fx);
        const grid = (userId: string, organizationId = fx.orgA) =>
          view.grid(userId, { organizationId, ...WEEK });
        expect(names((await grid(fx.users.admin!)).holidays)).toEqual([
          'A Founders Day',
          'Team A Closure',
          'Dept B Day',
          'Dept A Day',
        ]);
        // Dept A only: Dept B's day is not revealed.
        expect(names((await grid(fx.users.deptAReader!)).holidays)).toEqual([
          'A Founders Day',
          'Team A Closure',
          'Dept A Day',
        ]);
        // Another organization's scheduler, or an employee, sees none of A's.
        expect((await grid(fx.users.outsider!)).holidays).toEqual([]);
        expect((await grid(fx.selfUser1)).holidays).toEqual([]);
        // B's own grid (no schedules there) reveals nothing either.
        expect((await grid(fx.users.outsider!, fx.orgB)).holidays).toEqual([]);
      });
    });

    it('changes nothing about the shifts themselves (markers are information only)', async () => {
      await scenario(async ({ tx, fx, view }) => {
        const before = await view.grid(fx.users.admin!, {
          organizationId: fx.orgA,
          ...WEEK,
        });
        await holidays(tx, fx);
        const after = await view.grid(fx.users.admin!, {
          organizationId: fx.orgA,
          ...WEEK,
        });
        expect(after.items).toEqual(before.items);
      });
    });
  });
});
