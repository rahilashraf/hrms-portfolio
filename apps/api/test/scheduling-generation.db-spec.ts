import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
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
import { EmployeeSchedulePatternService } from '../src/scheduling/employee-schedule-pattern.service.js';
import { runExtendGeneratedShiftsJob } from '../src/scheduling/generation-job.js';
import { ScheduleRuleSetService } from '../src/scheduling/schedule-rule-set.service.js';
import { SchedulingDomainService } from '../src/scheduling/scheduling-domain.service.js';
import { SchedulingService } from '../src/scheduling/scheduling.service.js';
import {
  ShiftGenerationService,
  type PatternGenerationResult,
} from '../src/scheduling/shift-generation.service.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type Tx = Prisma.TransactionClient;
type Day =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

interface Fixtures {
  orgA: string;
  orgB: string;
  deptA: string;
  deptB: string;
  teamA: string;
  /** Employee 1 on Team A (team-placed position). */
  assignmentTeamA: string;
  /** Employee 1 in Dept B (department-placed position). */
  assignmentDeptB: string;
  /** Employee 2 on Team A. */
  otherTeamA: string;
  /** Employee 2 in an organization-level position. */
  orgLevel: string;
  workLocationToronto: string;
  workLocationRegina: string;
  workLocationNoTimezone: string;
  users: {
    generator: string;
    patternsOnly: string;
    deptAGenerator: string;
    deptAReader: string;
    orgBAdmin: string;
  };
}

interface Services {
  scheduling: SchedulingService;
  patterns: EmployeeSchedulePatternService;
  generation: ShiftGenerationService;
}

const CORRELATION = 'scheduling-generation-db-spec';
const ctx = (actorUserId: string) => ({
  actorUserId,
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
  correlationId: CORRELATION,
});
const PERMISSIONS = [
  'schedule.read',
  'schedule.manage',
  'schedule.override_conflict',
  'schedule.publish',
  'schedule.manage_patterns',
] as const;
const TORONTO = 'America/Toronto';
const WEEKDAYS: Day[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
];

function rule(
  dayOfWeek: Day,
  startLocalTime: string,
  endLocalTime: string,
  extra: Partial<{
    weekIndex: number;
    workLocationId: string;
    timezone: string;
  }> = {},
) {
  return {
    weekIndex: 0,
    dayOfWeek,
    startLocalTime,
    endLocalTime,
    timezone: TORONTO,
    ...extra,
  };
}

function services(prisma: PrismaService): Services {
  const domain = new SchedulingDomainService();
  const authorization = new AuthorizationService(prisma);
  const targets = new PositionAuthorizationTargetResolver(prisma);
  const audit = new AuditService(prisma);
  return {
    scheduling: new SchedulingService(
      prisma,
      domain,
      authorization,
      targets,
      audit,
    ),
    patterns: new EmployeeSchedulePatternService(
      prisma,
      authorization,
      targets,
      domain,
      new ScheduleRuleSetService(domain),
      audit,
    ),
    generation: new ShiftGenerationService(
      prisma,
      authorization,
      targets,
      domain,
      audit,
    ),
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

const iso = (value: Date) => value.toISOString();
const day = (value: Date) => value.toISOString().slice(0, 10);

describe('Recurring shift generation (database)', () => {
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

  interface Harness extends Services {
    tx: Tx;
    fx: Fixtures;
    pattern: (
      assignmentId: string,
      rules: unknown[],
      options?: Partial<{
        from: string;
        to: string;
        anchor: string;
        rotationWeeks: number;
      }>,
    ) => Promise<{
      id: string;
      rules: Array<{ id: string; dayOfWeek: string }>;
    }>;
    generate: (
      assignmentId: string,
      patternId: string,
      from: string,
      to: string,
      user?: string,
    ) => Promise<PatternGenerationResult>;
    shifts: (patternId: string) => Promise<
      Array<
        Prisma.ScheduledShiftGetPayload<{
          include: { schedule: true };
        }>
      >
    >;
  }

  async function scenario(run: (harness: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createFixtures(tx);
          const svc = services(rollbackClient(tx));
          await run({
            tx,
            fx,
            ...svc,
            pattern: (assignmentId, rules, options = {}) =>
              svc.patterns.createPattern(
                assignmentId,
                {
                  effectiveFrom: options.from ?? '2027-03-01',
                  ...(options.to ? { effectiveTo: options.to } : {}),
                  anchorDate: options.anchor ?? '2027-03-01',
                  rotationWeeks: options.rotationWeeks ?? 1,
                  rules: rules as never,
                },
                ctx(fx.users.generator),
              ),
            generate: (assignmentId, patternId, from, to, user) =>
              svc.generation.generateForPattern(
                assignmentId,
                patternId,
                { from, to },
                ctx(user ?? fx.users.generator),
              ),
            shifts: (patternId) =>
              tx.scheduledShift.findMany({
                where: { sourcePatternId: patternId },
                include: { schedule: true },
                orderBy: { startsAt: 'asc' },
              }),
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const weekdays = (start = '09:00', end = '17:00') =>
    WEEKDAYS.map((name) => rule(name, start, end));

  // ─── Generation basics ──────────────────────────────────────────────────────

  describe('generation', () => {
    it('materializes PATTERN shifts with provenance into weekly DRAFT containers', async () => {
      await scenario(async ({ tx, fx, pattern, generate, shifts }) => {
        const created = await pattern(fx.assignmentTeamA, weekdays());
        const result = await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-01',
          '2027-03-14',
        );
        expect(result).toMatchObject({
          range: { from: '2027-03-01', to: '2027-03-14' },
          created: 10,
          updated: 0,
          unchanged: 0,
          removed: 0,
          blocked: [],
          errors: [],
        });
        expect(result.schedulesCreated).toHaveLength(2);
        const rows = await shifts(created.id);
        expect(rows.map((row) => day(row.workDate))).toEqual([
          '2027-03-01',
          '2027-03-02',
          '2027-03-03',
          '2027-03-04',
          '2027-03-05',
          '2027-03-08',
          '2027-03-09',
          '2027-03-10',
          '2027-03-11',
          '2027-03-12',
        ]);
        const monday = created.rules.find((r) => r.dayOfWeek === 'MONDAY')!;
        expect(rows[0]).toMatchObject({
          employmentAssignmentId: fx.assignmentTeamA,
          startsAt: new Date('2027-03-01T14:00:00.000Z'),
          endsAt: new Date('2027-03-01T22:00:00.000Z'),
          timezone: TORONTO,
          status: 'ACTIVE',
          sourceType: 'PATTERN',
          sourcePatternId: created.id,
          sourcePatternRuleId: monday.id,
          sourceOccurrenceKey: `v1:${created.id}:${monday.id}:2027-03-01`,
          generatedAt: expect.any(Date),
        });
        // Containers: the Team A STANDARD DRAFT schedule of each Monday–Sunday week.
        const containers = [
          ...new Map(
            rows.map((row) => [row.scheduleId, row.schedule]),
          ).values(),
        ];
        expect(
          containers.map((s) => [
            s.scopeType,
            s.teamId,
            s.organizationId,
            day(s.periodStart),
            day(s.periodEnd),
            s.type,
            s.status,
          ]),
        ).toEqual([
          [
            'TEAM',
            fx.teamA,
            fx.orgA,
            '2027-03-01',
            '2027-03-07',
            'STANDARD',
            'DRAFT',
          ],
          [
            'TEAM',
            fx.teamA,
            fx.orgA,
            '2027-03-08',
            '2027-03-14',
            'STANDARD',
            'DRAFT',
          ],
        ]);
        // Draft generation never writes published history.
        expect(
          await tx.scheduledShiftRevision.count({
            where: { scheduledShiftId: { in: rows.map((row) => row.id) } },
          }),
        ).toBe(0);
        const audit = await tx.auditLog.findMany({
          where: { action: 'SCHEDULE_PATTERN_GENERATED', entityId: created.id },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorUserId: fx.users.generator,
          entityType: 'EmployeeSchedulePattern',
          metadata: expect.objectContaining({
            created: 10,
            blocked: 0,
            errors: 0,
            range: { from: '2027-03-01', to: '2027-03-14' },
          }),
        });
        expect(
          await tx.auditLog.count({
            where: {
              action: 'SCHEDULE_CREATED',
              entityId: { in: result.schedulesCreated },
            },
          }),
        ).toBe(2);
      });
    });

    it('is idempotent, including across overlapping ranges', async () => {
      await scenario(async ({ tx, fx, pattern, generate, shifts }) => {
        const created = await pattern(fx.assignmentTeamA, weekdays());
        await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-01',
          '2027-03-14',
        );
        const before = await shifts(created.id);
        const again = await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-01',
          '2027-03-14',
        );
        expect(again).toMatchObject({
          created: 0,
          updated: 0,
          unchanged: 10,
          removed: 0,
          schedulesCreated: [],
        });
        expect(await shifts(created.id)).toEqual(before);
        const overlapping = await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-08',
          '2027-03-21',
        );
        expect(overlapping).toMatchObject({ created: 5, unchanged: 5 });
        const all = await shifts(created.id);
        expect(all).toHaveLength(15);
        expect(new Set(all.map((row) => row.sourceOccurrenceKey)).size).toBe(
          15,
        );
        expect(
          await tx.schedule.count({
            where: { teamId: fx.teamA, type: 'STANDARD' },
          }),
        ).toBe(3);
      });
    });

    it('expands multi-week rotations from the anchor, including dates before it', async () => {
      await scenario(async ({ fx, pattern, generate, shifts }) => {
        const created = await pattern(
          fx.assignmentTeamA,
          [
            rule('MONDAY', '09:00', '17:00'),
            rule('WEDNESDAY', '22:00', '06:00', { weekIndex: 1 }),
          ],
          { from: '2027-03-01', anchor: '2027-03-15', rotationWeeks: 2 },
        );
        await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-01',
          '2027-03-28',
        );
        const rows = await shifts(created.id);
        expect(
          rows.map((row) => [
            day(row.workDate),
            iso(row.startsAt),
            iso(row.endsAt),
          ]),
        ).toEqual([
          // Two weeks before the anchor: rotation week 0.
          [
            '2027-03-01',
            '2027-03-01T14:00:00.000Z',
            '2027-03-01T22:00:00.000Z',
          ],
          // Week 1 overnight keeps its start date as workDate.
          [
            '2027-03-10',
            '2027-03-11T03:00:00.000Z',
            '2027-03-11T11:00:00.000Z',
          ],
          // The anchor week (after spring-forward: EDT).
          [
            '2027-03-15',
            '2027-03-15T13:00:00.000Z',
            '2027-03-15T21:00:00.000Z',
          ],
          [
            '2027-03-24',
            '2027-03-25T02:00:00.000Z',
            '2027-03-25T10:00:00.000Z',
          ],
        ]);
      });
    });

    it('stays within the requested range, the pattern period, and the assignment lifecycle', async () => {
      await scenario(async ({ tx, fx, pattern, generate, shifts }) => {
        const bounded = await pattern(fx.assignmentTeamA, weekdays(), {
          from: '2027-03-03',
          to: '2027-03-10',
        });
        await generate(
          fx.assignmentTeamA,
          bounded.id,
          '2027-03-01',
          '2027-03-21',
        );
        expect(
          (await shifts(bounded.id)).map((row) => day(row.workDate)),
        ).toEqual([
          '2027-03-03',
          '2027-03-04',
          '2027-03-05',
          '2027-03-08',
          '2027-03-09',
          '2027-03-10',
        ]);
        const open = await pattern(fx.assignmentDeptB, [
          rule('TUESDAY', '18:00', '22:00'),
        ]);
        // The assignment ends after the pattern was defined.
        await tx.employmentAssignment.update({
          where: { id: fx.assignmentDeptB },
          data: {
            endDate: new Date('2027-03-16T00:00:00.000Z'),
            status: 'ENDED',
          },
        });
        await generate(fx.assignmentDeptB, open.id, '2027-03-01', '2027-03-31');
        expect((await shifts(open.id)).map((row) => day(row.workDate))).toEqual(
          ['2027-03-02', '2027-03-09', '2027-03-16'],
        );
      });
    });

    it('validates the range: not in the past, ordered, and bounded', async () => {
      await scenario(async ({ fx, pattern, generate }) => {
        const created = await pattern(fx.assignmentTeamA, weekdays());
        for (const [from, to] of [
          ['2026-01-05', '2026-01-10'],
          ['2027-03-10', '2027-03-01'],
          ['2027-03-01', '2028-03-10'],
        ] as const) {
          await expect(
            generate(fx.assignmentTeamA, created.id, from, to),
          ).rejects.toBeInstanceOf(BadRequestException);
        }
      });
    });
  });

  // ─── Timezones and DST ──────────────────────────────────────────────────────

  describe('timezones', () => {
    it('reports nonexistent spring-forward times and resolves overnight shifts across it', async () => {
      await scenario(async ({ fx, pattern, generate, shifts }) => {
        const gap = await pattern(fx.assignmentTeamA, [
          rule('SUNDAY', '02:30', '10:00'),
        ]);
        const result = await generate(
          fx.assignmentTeamA,
          gap.id,
          '2027-03-07',
          '2027-03-21',
        );
        expect(result.errors).toEqual([
          expect.objectContaining({
            code: 'LOCAL_TIME_NONEXISTENT',
            workDate: '2027-03-14',
            patternId: gap.id,
            ruleId: gap.rules[0]!.id,
          }),
        ]);
        expect((await shifts(gap.id)).map((row) => day(row.workDate))).toEqual([
          '2027-03-07',
          '2027-03-21',
        ]);
        const overnight = await pattern(fx.otherTeamA, [
          rule('SATURDAY', '22:00', '06:00'),
        ]);
        await generate(fx.otherTeamA, overnight.id, '2027-03-13', '2027-03-13');
        const [row] = await shifts(overnight.id);
        expect([
          day(row!.workDate),
          iso(row!.startsAt),
          iso(row!.endsAt),
        ]).toEqual([
          '2027-03-13',
          '2027-03-14T03:00:00.000Z',
          '2027-03-14T10:00:00.000Z',
        ]);
      });
    });

    it('resolves ambiguous fall-back times to the earlier instant with a notice', async () => {
      await scenario(async ({ fx, pattern, generate, shifts }) => {
        const repeated = await pattern(fx.assignmentTeamA, [
          rule('SUNDAY', '01:30', '09:00'),
        ]);
        const result = await generate(
          fx.assignmentTeamA,
          repeated.id,
          '2027-10-31',
          '2027-11-07',
        );
        expect(result.errors).toEqual([]);
        expect(result.notices).toEqual([
          expect.objectContaining({
            code: 'LOCAL_TIME_AMBIGUOUS',
            workDate: '2027-11-07',
          }),
        ]);
        expect(
          (await shifts(repeated.id)).map((row) => [
            iso(row.startsAt),
            iso(row.endsAt),
          ]),
        ).toEqual([
          ['2027-10-31T05:30:00.000Z', '2027-10-31T13:00:00.000Z'],
          ['2027-11-07T05:30:00.000Z', '2027-11-07T14:00:00.000Z'],
        ]);
        const overnight = await pattern(fx.otherTeamA, [
          rule('SATURDAY', '22:00', '06:00'),
        ]);
        await generate(fx.otherTeamA, overnight.id, '2027-11-06', '2027-11-06');
        const [row] = await shifts(overnight.id);
        expect([iso(row!.startsAt), iso(row!.endsAt)]).toEqual([
          '2027-11-07T02:00:00.000Z',
          '2027-11-07T11:00:00.000Z',
        ]);
      });
    });

    it('prefers the WorkLocation timezone, falls back to the rule timezone, and reports unusable ones', async () => {
      await scenario(async ({ tx, fx, pattern, generate, shifts }) => {
        const created = await pattern(fx.assignmentTeamA, [
          rule('MONDAY', '09:00', '17:00', {
            workLocationId: fx.workLocationRegina,
          }),
          rule('TUESDAY', '09:00', '17:00', {
            workLocationId: fx.workLocationNoTimezone,
          }),
          rule('WEDNESDAY', '09:00', '17:00'),
        ]);
        await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-01',
          '2027-03-07',
        );
        expect(
          (await shifts(created.id)).map((row) => [
            row.timezone,
            iso(row.startsAt),
            row.workLocationId,
          ]),
        ).toEqual([
          ['America/Regina', '2027-03-01T15:00:00.000Z', fx.workLocationRegina],
          [TORONTO, '2027-03-02T14:00:00.000Z', fx.workLocationNoTimezone],
          [TORONTO, '2027-03-03T14:00:00.000Z', null],
        ]);
        await tx.workLocation.update({
          where: { id: fx.workLocationRegina },
          data: { archivedAt: new Date() },
        });
        const wednesday = created.rules.find(
          (r) => r.dayOfWeek === 'WEDNESDAY',
        )!;
        await tx.employeeSchedulePatternRule.update({
          where: { id: wednesday.id },
          data: { timezone: 'Mars/Olympus_Mons' },
        });
        const result = await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-01',
          '2027-03-07',
        );
        expect(
          result.errors.map((issue) => [issue.workDate, issue.code]),
        ).toEqual([
          ['2027-03-01', 'WORK_LOCATION_ARCHIVED'],
          ['2027-03-03', 'TIMEZONE_UNRESOLVABLE'],
        ]);
        // Stale untouched drafts for occurrences that can no longer be materialized are removed.
        expect(result).toMatchObject({ removed: 2, unchanged: 1 });
        expect(
          (await shifts(created.id)).map((row) => day(row.workDate)),
        ).toEqual(['2027-03-02']);
      });
    });
  });

  // ─── Reconciliation ─────────────────────────────────────────────────────────

  describe('reconciliation', () => {
    it('updates, removes, and creates only untouched generated drafts', async () => {
      await scenario(
        async ({ tx, fx, scheduling, patterns, pattern, generate, shifts }) => {
          const user = ctx(fx.users.generator);
          const created = await pattern(fx.assignmentTeamA, [
            rule('MONDAY', '09:00', '17:00'),
            rule('TUESDAY', '09:00', '17:00'),
            rule('WEDNESDAY', '09:00', '17:00'),
          ]);
          const byDay = (name: string) =>
            created.rules.find((r) => r.dayOfWeek === name)!.id;
          await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-14',
          );
          const original = await shifts(created.id);

          // A MANUAL shift the generator must never touch.
          const draft = await scheduling.createSchedule(
            {
              scopeType: 'DEPARTMENT',
              organizationId: fx.orgA,
              departmentId: fx.deptA,
              name: 'Manual week',
              type: 'AD_HOC',
              periodStart: '2027-03-01',
              periodEnd: '2027-03-07',
            },
            user,
          );
          const manual = await scheduling.createShift(
            draft.id,
            {
              employmentAssignmentId: fx.assignmentTeamA,
              workDate: '2027-03-04',
              startsAt: '2027-03-04T09:00:00-05:00',
              endsAt: '2027-03-04T17:00:00-05:00',
              timezone: TORONTO,
            },
            user,
          );

          // Changed recurrence output updates the same rows in place.
          await patterns.updateRule(
            fx.assignmentTeamA,
            created.id,
            byDay('MONDAY'),
            { endLocalTime: '18:00' },
            user,
          );
          const updated = await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-14',
          );
          expect(updated).toMatchObject({
            updated: 2,
            unchanged: 4,
            created: 0,
          });
          const afterUpdate = await shifts(created.id);
          expect(afterUpdate.map((row) => row.id)).toEqual(
            original.map((row) => row.id),
          );
          expect(iso(afterUpdate[0]!.endsAt)).toBe('2027-03-01T23:00:00.000Z');

          // Tuesday → Thursday: old occurrences go; Thursday Mar 4 hits the MANUAL shift.
          await patterns.updateRule(
            fx.assignmentTeamA,
            created.id,
            byDay('TUESDAY'),
            { dayOfWeek: 'THURSDAY' },
            user,
          );
          const moved = await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-14',
          );
          expect(moved).toMatchObject({ removed: 2, created: 1 });
          expect(moved.blocked).toEqual([
            expect.objectContaining({
              code: 'SAME_ASSIGNMENT_OVERLAP',
              workDate: '2027-03-04',
              conflictingShiftId: manual.id,
            }),
          ]);
          await expect(
            scheduling.getShift(fx.users.generator, draft.id, manual.id),
          ).resolves.toEqual(manual);

          // Ending the pattern removes the now-unjustified future drafts only.
          await patterns.updatePattern(
            fx.assignmentTeamA,
            created.id,
            { effectiveTo: '2027-03-07' },
            user,
          );
          const ended = await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-14',
          );
          expect(ended).toMatchObject({ removed: 3, created: 0 });
          expect(
            (await shifts(created.id)).every(
              (row) => day(row.workDate) <= '2027-03-07',
            ),
          ).toBe(true);
          expect(
            await tx.scheduledShift.count({ where: { id: manual.id } }),
          ).toBe(1);
        },
      );
    });

    it('never modifies published, corrected, or cancelled generated shifts', async () => {
      await scenario(
        async ({ tx, fx, scheduling, patterns, pattern, generate, shifts }) => {
          const user = ctx(fx.users.generator);
          const created = await pattern(fx.assignmentTeamA, [
            rule('MONDAY', '09:00', '17:00'),
            rule('TUESDAY', '09:00', '17:00'),
          ]);
          await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-14',
          );
          const [monday, tuesday] = await shifts(created.id);
          await scheduling.publishSchedule(monday!.scheduleId, user);
          // Published generated shifts keep their provenance and can be corrected explicitly.
          const corrected = await scheduling.correctShift(
            monday!.scheduleId,
            monday!.id,
            { reason: 'Coverage', endsAt: '2027-03-01T15:00:00-05:00' },
            user,
          );
          expect(corrected.shift.sourceType).toBe('PATTERN');
          await scheduling.cancelShift(
            tuesday!.scheduleId,
            tuesday!.id,
            { reason: 'Closed' },
            user,
          );
          const protectedRows = await tx.scheduledShift.findMany({
            where: { id: { in: [monday!.id, tuesday!.id] } },
          });

          await patterns.updateRule(
            fx.assignmentTeamA,
            created.id,
            created.rules[0]!.id,
            { startLocalTime: '08:00' },
            user,
          );
          await patterns.createRule(
            fx.assignmentTeamA,
            created.id,
            rule('FRIDAY', '09:00', '17:00'),
            user,
          );
          const result = await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-14',
          );
          expect(result).toMatchObject({
            protected: 2,
            updated: 1,
            unchanged: 1,
            created: 1,
          });
          // The published week cannot receive new generated work.
          expect(result.blocked).toEqual([
            expect.objectContaining({
              code: 'SCHEDULE_PERIOD_PUBLISHED',
              workDate: '2027-03-05',
            }),
          ]);
          expect(
            await tx.scheduledShift.findMany({
              where: { id: { in: [monday!.id, tuesday!.id] } },
            }),
          ).toEqual(protectedRows);
          expect(protectedRows[0]).toMatchObject({
            sourceType: 'PATTERN',
            sourcePatternId: created.id,
            sourceOccurrenceKey: monday!.sourceOccurrenceKey,
          });

          // Ending the pattern leaves published history in place.
          await patterns.updatePattern(
            fx.assignmentTeamA,
            created.id,
            { effectiveTo: '2027-03-02' },
            user,
          );
          const ended = await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-14',
          );
          expect(ended).toMatchObject({ protected: 2, removed: 3 });
          expect(
            (await shifts(created.id)).map((row) => row.id).sort(),
          ).toEqual([monday!.id, tuesday!.id].sort());
          // A pattern with published generated shifts cannot be deleted.
          await expect(
            patterns.deletePattern(fx.assignmentTeamA, created.id, user),
          ).rejects.toThrow('end the pattern instead');
        },
      );
    });

    it('keeps generated drafts generator-owned and cleans them up with their pattern or rule', async () => {
      await scenario(
        async ({ tx, fx, scheduling, patterns, pattern, generate, shifts }) => {
          const user = ctx(fx.users.generator);
          const created = await pattern(fx.assignmentTeamA, [
            rule('MONDAY', '09:00', '17:00'),
            rule('TUESDAY', '09:00', '17:00'),
          ]);
          await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-07',
          );
          const [monday] = await shifts(created.id);
          for (const attempt of [
            () =>
              scheduling.updateShift(
                monday!.scheduleId,
                monday!.id,
                { endsAt: '2027-03-01T18:00:00-05:00' },
                user,
              ),
            () => scheduling.deleteShift(monday!.scheduleId, monday!.id, user),
            () =>
              scheduling.previewShiftConflicts(
                fx.users.generator,
                monday!.scheduleId,
                monday!.id,
                { endsAt: '2027-03-01T18:00:00-05:00' },
              ),
          ]) {
            await expect(attempt()).rejects.toThrow('Only MANUAL shifts');
          }
          await patterns.deleteRule(
            fx.assignmentTeamA,
            created.id,
            created.rules[0]!.id,
            user,
          );
          expect(
            (await shifts(created.id)).map((row) => day(row.workDate)),
          ).toEqual(['2027-03-02']);
          await patterns.deletePattern(fx.assignmentTeamA, created.id, user);
          expect(await shifts(created.id)).toEqual([]);
          const audit = await tx.auditLog.findFirst({
            where: {
              entityId: created.id,
              action: 'EMPLOYEE_SCHEDULE_PATTERN_DELETED',
            },
          });
          expect(audit?.metadata).toMatchObject({ removedGeneratedShifts: 1 });
        },
      );
    });
  });

  // ─── Conflicts ──────────────────────────────────────────────────────────────

  describe('conflicts', () => {
    it('blocks Batch 3 conflicts without overrides and allows other employees and touching shifts', async () => {
      await scenario(
        async ({ tx, fx, scheduling, pattern, generate, shifts }) => {
          const user = ctx(fx.users.generator);
          const deptBWeek = await scheduling.createSchedule(
            {
              scopeType: 'DEPARTMENT',
              organizationId: fx.orgA,
              departmentId: fx.deptB,
              name: 'Dept B',
              type: 'AD_HOC',
              periodStart: '2027-03-01',
              periodEnd: '2027-03-07',
            },
            user,
          );
          const crossAssignment = await scheduling.createShift(
            deptBWeek.id,
            {
              employmentAssignmentId: fx.assignmentDeptB,
              workDate: '2027-03-01',
              startsAt: '2027-03-01T12:00:00-05:00',
              endsAt: '2027-03-01T20:00:00-05:00',
              timezone: TORONTO,
            },
            user,
          );
          await scheduling.createShift(
            deptBWeek.id,
            {
              employmentAssignmentId: fx.assignmentDeptB,
              workDate: '2027-03-03',
              startsAt: '2027-03-03T17:00:00-05:00',
              endsAt: '2027-03-03T21:00:00-05:00',
              timezone: TORONTO,
            },
            user,
          );
          const coworker = await pattern(fx.otherTeamA, weekdays());
          await generate(
            fx.otherTeamA,
            coworker.id,
            '2027-03-01',
            '2027-03-07',
          );

          const created = await pattern(fx.assignmentTeamA, weekdays());
          const result = await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-07',
          );
          expect(result.created).toBe(4);
          expect(result.blocked).toEqual([
            expect.objectContaining({
              code: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              workDate: '2027-03-01',
              conflictingShiftId: crossAssignment.id,
            }),
          ]);
          expect(
            (await shifts(created.id)).map((row) => day(row.workDate)),
          ).toEqual(['2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05']);
          expect(await shifts(coworker.id)).toHaveLength(5);
          expect(
            await tx.scheduleConflictOverride.count({
              where: { overriddenByUserId: fx.users.generator },
            }),
          ).toBe(0);
        },
      );
    });
  });

  // ─── Containers ─────────────────────────────────────────────────────────────

  describe('containers', () => {
    it('reuses a draft for the week, never fills a published week, and follows the position scope', async () => {
      await scenario(
        async ({ tx, fx, scheduling, pattern, generate, shifts }) => {
          const user = ctx(fx.users.generator);
          const teamSchedule = (periodStart: string, periodEnd: string) =>
            scheduling.createSchedule(
              {
                scopeType: 'TEAM',
                organizationId: fx.orgA,
                teamId: fx.teamA,
                name: `Team ${periodStart}`,
                type: 'STANDARD',
                periodStart,
                periodEnd,
              },
              user,
            );
          const existing = await teamSchedule('2027-03-01', '2027-03-07');
          const published = await teamSchedule('2027-03-08', '2027-03-14');
          await scheduling.createShift(
            published.id,
            {
              employmentAssignmentId: fx.otherTeamA,
              workDate: '2027-03-13',
              startsAt: '2027-03-13T09:00:00-05:00',
              endsAt: '2027-03-13T17:00:00-05:00',
              timezone: TORONTO,
            },
            user,
          );
          await scheduling.publishSchedule(published.id, user);

          const created = await pattern(fx.assignmentTeamA, [
            rule('MONDAY', '09:00', '17:00'),
          ]);
          const result = await generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-21',
          );
          expect(result.schedulesCreated).toHaveLength(1);
          expect(
            result.blocked.map((issue) => [issue.workDate, issue.code]),
          ).toEqual([['2027-03-08', 'SCHEDULE_PERIOD_PUBLISHED']]);
          const rows = await shifts(created.id);
          expect(
            rows.map((row) => [day(row.workDate), row.scheduleId]),
          ).toEqual([
            ['2027-03-01', existing.id],
            ['2027-03-15', result.schedulesCreated[0]],
          ]);

          // Department and organization-level positions get matching container scopes.
          const deptPattern = await pattern(fx.assignmentDeptB, [
            rule('FRIDAY', '09:00', '17:00'),
          ]);
          await generate(
            fx.assignmentDeptB,
            deptPattern.id,
            '2027-03-01',
            '2027-03-07',
          );
          const orgPattern = await pattern(fx.orgLevel, [
            rule('FRIDAY', '09:00', '17:00'),
          ]);
          await generate(
            fx.orgLevel,
            orgPattern.id,
            '2027-03-01',
            '2027-03-07',
          );
          const [deptShift] = await shifts(deptPattern.id);
          const [orgShift] = await shifts(orgPattern.id);
          expect(deptShift!.schedule).toMatchObject({
            scopeType: 'DEPARTMENT',
            departmentId: fx.deptB,
            teamId: null,
          });
          expect(orgShift!.schedule).toMatchObject({
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            departmentId: null,
            teamId: null,
          });

          // An archived scope target cannot receive new containers.
          await tx.department.update({
            where: { id: fx.deptB },
            data: { archivedAt: new Date() },
          });
          const unavailable = await generate(
            fx.assignmentDeptB,
            deptPattern.id,
            '2027-03-08',
            '2027-03-14',
          );
          expect(unavailable.errors.map((issue) => issue.code)).toEqual([
            'SCHEDULE_SCOPE_UNAVAILABLE',
          ]);
        },
      );
    });
  });

  // ─── Authorization ──────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('requires manage_patterns on the assignment and manage on the container scope', async () => {
      await scenario(async ({ tx, fx, pattern, generate, shifts }) => {
        const created = await pattern(fx.assignmentTeamA, weekdays());
        const deptB = await pattern(fx.assignmentDeptB, [
          rule('MONDAY', '09:00', '17:00'),
        ]);
        for (const [user, assignment, patternId, type] of [
          [
            fx.users.patternsOnly,
            fx.assignmentTeamA,
            created.id,
            ForbiddenException,
          ],
          [
            fx.users.deptAReader,
            fx.assignmentTeamA,
            created.id,
            ForbiddenException,
          ],
          [
            fx.users.orgBAdmin,
            fx.assignmentTeamA,
            created.id,
            NotFoundException,
          ],
          [
            fx.users.deptAGenerator,
            fx.assignmentDeptB,
            deptB.id,
            NotFoundException,
          ],
          [
            fx.users.generator,
            fx.assignmentDeptB,
            created.id,
            NotFoundException,
          ],
        ] as const) {
          await expect(
            generate(assignment, patternId, '2027-03-01', '2027-03-07', user),
          ).rejects.toBeInstanceOf(type);
        }
        expect(await shifts(created.id)).toEqual([]);
        expect(
          await tx.auditLog.count({
            where: {
              action: 'SCHEDULE_PATTERN_GENERATED',
              entityId: { in: [created.id, deptB.id] },
            },
          }),
        ).toBe(0);
        // A department-scoped manager can generate for an assignment on a team in that department.
        await expect(
          generate(
            fx.assignmentTeamA,
            created.id,
            '2027-03-01',
            '2027-03-07',
            fx.users.deptAGenerator,
          ),
        ).resolves.toMatchObject({ created: 5 });
      });
    });
  });

  // ─── Database integrity ─────────────────────────────────────────────────────

  describe('constraints', () => {
    it('enforces provenance shape and one shift per occurrence', async () => {
      await scenario(async ({ tx, fx, pattern, generate, shifts }) => {
        const created = await pattern(fx.assignmentTeamA, [
          rule('MONDAY', '09:00', '17:00'),
        ]);
        await generate(
          fx.assignmentTeamA,
          created.id,
          '2027-03-01',
          '2027-03-07',
        );
        const [row] = await shifts(created.id);
        const {
          id: _id,
          schedule: _s,
          createdAt: _c,
          updatedAt: _u,
          ...data
        } = row!;
        expect(
          await violation(tx, () => tx.scheduledShift.create({ data })),
        ).toMatchObject({ code: 'P2002' });
        const otherRule = randomUUID();
        for (const bad of [
          {
            sourceOccurrenceKey: `v1:${created.id}:${row!.sourcePatternRuleId}:2027-03-15`,
            sourcePatternId: null,
          },
          { sourceOccurrenceKey: `v1:${created.id}:${otherRule}:2027-03-15` },
          { sourceOccurrenceKey: 'not-a-key' },
          {
            sourceOccurrenceKey: `v1:${created.id}:${row!.sourcePatternRuleId}:2027-03-15`,
            generatedAt: null,
          },
          {
            sourceType: 'MANUAL' as const,
            sourceOccurrenceKey: `v1:${created.id}:${row!.sourcePatternRuleId}:2027-03-15`,
          },
        ]) {
          expect(
            await violation(tx, () =>
              tx.scheduledShift.create({ data: { ...data, ...bad } }),
            ),
          ).toMatchObject({
            code: expect.stringMatching(/^P(2004|2010|2011|2039)$/),
          });
        }
        expect(
          await violation(tx, () =>
            tx.employeeSchedulePatternRule.delete({
              where: { id: row!.sourcePatternRuleId! },
            }),
          ),
        ).toMatchObject({ code: expect.stringMatching(/^P(2003|2010)$/) });
      });
    });
  });

  // ─── Concurrency and worker (committed data) ────────────────────────────────

  describe('concurrency and worker', () => {
    let fx: Fixtures;

    beforeAll(async () => {
      fx = await prisma.$transaction((tx) => createFixtures(tx), {
        timeout: 30_000,
      });
    });

    afterAll(async () => {
      if (fx) await cleanupFixtures(prisma, fx);
    });

    function racing(pauseMs = 200) {
      const client = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property === '$transaction') {
            return (run: (tx: Tx) => Promise<unknown>, options?: object) =>
              target.$transaction((tx) => run(pausingTx(tx, pauseMs)), {
                ...options,
                timeout: 60_000,
              });
          }
          return Reflect.get(target, property, receiver);
        },
      }) as unknown as PrismaService;
      return services(client);
    }

    async function settle(...operations: Promise<unknown>[]) {
      const results = await Promise.allSettled(operations);
      return results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason as unknown);
    }

    const createPattern = (
      assignmentId: string,
      from: string,
      to: string,
      rules = weekdays(),
    ) =>
      services(prisma).patterns.createPattern(
        assignmentId,
        {
          effectiveFrom: from,
          effectiveTo: to,
          anchorDate: from,
          rotationWeeks: 1,
          rules,
        },
        ctx(fx.users.generator),
      );

    it('generates the same pattern concurrently into exactly one shift per occurrence', async () => {
      const created = await createPattern(
        fx.assignmentTeamA,
        '2027-05-03',
        '2027-05-09',
      );
      const svc = racing();
      const run = () =>
        svc.generation.generateForPattern(
          fx.assignmentTeamA,
          created.id,
          { from: '2027-05-03', to: '2027-05-09' },
          ctx(fx.users.generator),
        );
      expect(await settle(run(), run(), run())).toEqual([]);
      expect(
        await prisma.scheduledShift.count({
          where: { sourcePatternId: created.id },
        }),
      ).toBe(5);
    });

    it('creates one container per scope and week when different patterns generate concurrently', async () => {
      const first = await createPattern(
        fx.assignmentTeamA,
        '2027-05-10',
        '2027-05-16',
      );
      const second = await createPattern(
        fx.otherTeamA,
        '2027-05-10',
        '2027-05-16',
      );
      const svc = racing();
      expect(
        await settle(
          svc.generation.generateForPattern(
            fx.assignmentTeamA,
            first.id,
            { from: '2027-05-10', to: '2027-05-16' },
            ctx(fx.users.generator),
          ),
          svc.generation.generateForPattern(
            fx.otherTeamA,
            second.id,
            { from: '2027-05-10', to: '2027-05-16' },
            ctx(fx.users.generator),
          ),
        ),
      ).toEqual([]);
      const containers = await prisma.schedule.findMany({
        where: {
          teamId: fx.teamA,
          periodStart: new Date('2027-05-10T00:00:00.000Z'),
        },
      });
      expect(containers).toHaveLength(1);
      expect(
        await prisma.scheduledShift.count({
          where: {
            scheduleId: containers[0]!.id,
            sourcePatternId: { in: [first.id, second.id] },
          },
        }),
      ).toBe(10);
    });

    it('keeps reconciliation and pattern deletion consistent under concurrency', async () => {
      const created = await createPattern(
        fx.assignmentTeamA,
        '2027-05-17',
        '2027-05-23',
      );
      const svc = racing();
      await settle(
        svc.generation.generateForPattern(
          fx.assignmentTeamA,
          created.id,
          { from: '2027-05-17', to: '2027-05-23' },
          ctx(fx.users.generator),
        ),
        svc.patterns.deletePattern(
          fx.assignmentTeamA,
          created.id,
          ctx(fx.users.generator),
        ),
      );
      expect(
        await prisma.employeeSchedulePattern.count({
          where: { id: created.id },
        }),
      ).toBe(0);
      expect(
        await prisma.scheduledShift.count({
          where: { sourcePatternId: created.id },
        }),
      ).toBe(0);
    });

    it('runs the worker job idempotently and isolates a failing pattern', async () => {
      const a = await createPattern(
        fx.assignmentDeptB,
        '2027-06-07',
        '2027-06-13',
      );
      const b = await createPattern(fx.orgLevel, '2027-06-07', '2027-06-13');
      const job = {
        asOf: '2027-06-07T12:00:00.000Z',
        horizonDays: 6,
        organizationId: fx.orgA,
      };
      const first = await runExtendGeneratedShiftsJob(job, { prisma });
      expect(first.failed).toEqual([]);
      expect(first.totals.created).toBe(10);
      expect(first.range).toEqual({ from: '2027-06-07', to: '2027-06-13' });
      const again = await runExtendGeneratedShiftsJob(job, { prisma });
      expect(again.totals).toMatchObject({
        created: 0,
        updated: 0,
        removed: 0,
      });
      // Background maintenance is not user activity.
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'SCHEDULE_PATTERN_GENERATED',
            entityId: { in: [a.id, b.id] },
          },
        }),
      ).toBe(0);

      // One pattern failing does not undo or block the others.
      await prisma.scheduledShift.deleteMany({
        where: { sourcePatternId: { in: [a.id, b.id] } },
      });
      const generation = services(prisma).generation;
      const original = (
        generation as unknown as { generate: (...args: unknown[]) => unknown }
      ).generate.bind(generation);
      (
        generation as unknown as { generate: (...args: unknown[]) => unknown }
      ).generate = (patternId: unknown, ...rest: unknown[]) => {
        if (patternId === a.id) throw new Error('simulated failure');
        return original(patternId, ...rest);
      };
      const partial = await generation.extendGeneratedShifts({
        asOf: new Date(job.asOf),
        horizonDays: 6,
        organizationId: fx.orgA,
      });
      expect(partial.failed).toEqual([
        { patternId: a.id, message: 'simulated failure' },
      ]);
      expect(
        await prisma.scheduledShift.count({ where: { sourcePatternId: a.id } }),
      ).toBe(0);
      expect(
        await prisma.scheduledShift.count({ where: { sourcePatternId: b.id } }),
      ).toBe(5);
    });
  });
});

/** Each violation runs in a savepoint so the scenario transaction stays usable. */
async function violation(tx: Tx, run: () => Promise<unknown>) {
  await tx.$executeRawUnsafe('SAVEPOINT generation_check');
  const error = await rejection(run());
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT generation_check');
  return error;
}

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

/** Delays container and shift reads so concurrent runs overlap inside the race window. */
function pausingTx(tx: Tx, pauseMs: number): Tx {
  const delayed = <T extends object>(delegate: T) =>
    new Proxy(delegate, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property !== 'findMany' || typeof value !== 'function')
          return value;
        return async (...args: unknown[]) => {
          const result = await (
            value as (...a: unknown[]) => Promise<unknown>
          ).apply(target, args);
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
          return result;
        };
      },
    });
  const schedules = delayed(tx.schedule);
  const shifts = delayed(tx.scheduledShift);
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'schedule') return schedules;
      if (property === 'scheduledShift') return shifts;
      return Reflect.get(target, property, receiver);
    },
  });
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
    data: { name: 'Generation Org A', code: code('GA') },
  });
  const orgB = await tx.organization.create({
    data: { name: 'Generation Org B', code: code('GB') },
  });
  const unitA = await tx.organizationalUnit.create({
    data: { organizationId: orgA.id, name: 'Unit A', code: code('UA') },
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
    data: { organizationId: orgA.id, name: 'Dept B', code: code('DB') },
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
  const position = (label: string, data: Record<string, string>) =>
    tx.position.create({
      data: {
        organizationId: orgA.id,
        jobTitleId: jobTitle.id,
        name: label,
        code: code(label),
        ...data,
      },
    });
  const teamPosition = await position('PTA', {
    organizationalUnitId: unitA.id,
    departmentId: deptA.id,
    teamId: teamA.id,
  });
  const deptPosition = await position('PDB', { departmentId: deptB.id });
  const orgPosition = await position('PORG', {});
  const location = (name: string, timezone: string | null) =>
    tx.workLocation.create({
      data: {
        organizationId: orgA.id,
        name,
        code: code(name.slice(0, 4)),
        timezone,
      },
    });
  const toronto = await location('Toronto', TORONTO);
  // Regina keeps UTC-6 all year (no DST), so expected instants don't depend on the runtime's
  // time zone database version.
  const regina = await location('Regina', 'America/Regina');
  const noTimezone = await location('Nowhere', null);

  let index = 0;
  const employee = async () => {
    index += 1;
    const person = await tx.person.create({ data: {} });
    return tx.employee.create({
      data: {
        personId: person.id,
        employeeNumber: code(`GE${index}`),
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
  };
  const assignment = async (employeeId: string, positionId: string) =>
    (
      await tx.employmentAssignment.create({
        data: {
          employeeId,
          positionId,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      })
    ).id;
  const first = await employee();
  const second = await employee();

  const role = async (
    organizationId: string,
    keys: readonly (typeof PERMISSIONS)[number][],
  ) => {
    const created = await tx.role.create({
      data: {
        organizationId,
        code: code(`R${randomUUID().slice(0, 6)}`),
        name: 'Generation role',
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
  const patternsOnly = await role(orgA.id, [
    'schedule.read',
    'schedule.manage_patterns',
  ]);
  const deptGenerator = await role(orgA.id, [
    'schedule.manage',
    'schedule.manage_patterns',
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
        email: `generation-${label}-${suffix.toLowerCase()}@example.com`,
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
  const dept = (roleId: string): Grant => ({
    roleId,
    organizationId: orgA.id,
    scopeType: 'DEPARTMENT',
    departmentId: deptA.id,
  });

  return {
    orgA: orgA.id,
    orgB: orgB.id,
    deptA: deptA.id,
    deptB: deptB.id,
    teamA: teamA.id,
    assignmentTeamA: await assignment(first.id, teamPosition.id),
    assignmentDeptB: await assignment(first.id, deptPosition.id),
    otherTeamA: await assignment(second.id, teamPosition.id),
    orgLevel: await assignment(second.id, orgPosition.id),
    workLocationToronto: toronto.id,
    workLocationRegina: regina.id,
    workLocationNoTimezone: noTimezone.id,
    users: {
      generator: await user('generator', [org(all)]),
      patternsOnly: await user('patterns-only', [org(patternsOnly)]),
      deptAGenerator: await user('dept-a-generator', [dept(deptGenerator)]),
      deptAReader: await user('dept-a-reader', [dept(read)]),
      orgBAdmin: await user('org-b', [org(allB, orgB.id)]),
    },
  };
}

/** Removes committed fixtures in foreign-key order. */
async function cleanupFixtures(prisma: PrismaService, fx: Fixtures) {
  const userIds = Object.values(fx.users);
  const organizationIds = [fx.orgA, fx.orgB];
  await prisma.$transaction(async (tx) => {
    const schedules = (
      await tx.schedule.findMany({
        where: { organizationId: { in: organizationIds } },
        select: { id: true },
      })
    ).map((row) => row.id);
    const shifts = (
      await tx.scheduledShift.findMany({
        where: { scheduleId: { in: schedules } },
        select: { id: true },
      })
    ).map((row) => row.id);
    const patterns = (
      await tx.employeeSchedulePattern.findMany({
        where: {
          employmentAssignment: { position: { organizationId: fx.orgA } },
        },
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
          { entityId: { in: [...schedules, ...shifts, ...patterns] } },
          { actorUserId: { in: userIds } },
        ],
      },
    });
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
    await tx.scheduleConflictOverride.deleteMany({
      where: { scheduledShiftId: { in: shifts } },
    });
    await tx.scheduledShiftRevision.deleteMany({
      where: { scheduledShiftId: { in: shifts } },
    });
    await tx.scheduledShift.deleteMany({ where: { id: { in: shifts } } });
    await tx.schedule.deleteMany({ where: { id: { in: schedules } } });
    await tx.employeeSchedulePatternRule.deleteMany({
      where: { employeeSchedulePatternId: { in: patterns } },
    });
    await tx.employeeSchedulePattern.deleteMany({
      where: { id: { in: patterns } },
    });
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
        id: { in: [...persons, ...employees].map((row) => row.personId) },
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
