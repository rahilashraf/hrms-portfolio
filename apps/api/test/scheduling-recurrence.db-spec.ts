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
import { EmployeeSchedulePatternService } from '../src/scheduling/employee-schedule-pattern.service.js';
import { ScheduleRuleSetService } from '../src/scheduling/schedule-rule-set.service.js';
import { ScheduleTemplateService } from '../src/scheduling/schedule-template.service.js';
import { SchedulingDomainService } from '../src/scheduling/scheduling-domain.service.js';

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
  /** Team A (under Dept A) assignment of the shared Employee, started 2026-01-01. */
  assignmentTeamA: string;
  /** Dept B assignment of the same Employee. */
  assignmentDeptB: string;
  /** Ends 2030-06-30. */
  endingAssignment: string;
  cancelledAssignment: string;
  workLocationToronto: string;
  /** A WorkLocation with no timezone of its own. */
  workLocationNoTimezone: string;
  workLocationOrgB: string;
  users: {
    templateAdmin: string;
    patternAdmin: string;
    deptAPatterns: string;
    deptAReader: string;
    orgBAdmin: string;
    nobody: string;
  };
}

interface Services {
  templates: ScheduleTemplateService;
  patterns: EmployeeSchedulePatternService;
}

const CORRELATION = 'scheduling-recurrence-db-spec';
const ctx = (actorUserId: string) => ({
  actorUserId,
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
  correlationId: CORRELATION,
});
const PERMISSIONS = [
  'schedule.read',
  'schedule.manage_templates',
  'schedule.manage_patterns',
] as const;
/** Mondays. FUTURE patterns have not started; STARTED ones began in the past. */
const FUTURE = '2030-01-07';
const STARTED = '2026-01-05';

function rule(
  dayOfWeek: Day,
  startLocalTime: string,
  endLocalTime: string,
  extra: Partial<{
    weekIndex: number;
    workLocationId: string;
    timezone: string;
    sortOrder: number;
  }> = {},
) {
  return {
    weekIndex: 0,
    dayOfWeek,
    startLocalTime,
    endLocalTime,
    timezone: 'America/Toronto',
    ...extra,
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

function services(prisma: PrismaService, audit = new AuditService(prisma)) {
  const domain = new SchedulingDomainService();
  const rules = new ScheduleRuleSetService(domain);
  const authorization = new AuthorizationService(prisma);
  return {
    templates: new ScheduleTemplateService(prisma, authorization, rules, audit),
    patterns: new EmployeeSchedulePatternService(
      prisma,
      authorization,
      new PositionAuthorizationTargetResolver(prisma),
      domain,
      rules,
      audit,
    ),
  };
}

describe('Schedule templates and recurring patterns (database)', () => {
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
    /** Creates an Org A template as the template admin. */
    template: (
      input?: Partial<{
        name: string;
        rotationWeeks: number;
        rules: unknown[];
      }>,
    ) => Promise<{ id: string; rules: Array<{ id: string }> }>;
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
            template: (input = {}) =>
              svc.templates.createTemplate(
                {
                  organizationId: fx.orgA,
                  name: input.name ?? 'Weekday days',
                  rotationWeeks: input.rotationWeeks ?? 1,
                  rules: (input.rules ?? [
                    rule('MONDAY', '09:00', '17:00'),
                  ]) as never,
                },
                ctx(fx.users.templateAdmin),
              ),
          });
          throw new RollbackFixtures();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  async function auditActions(tx: Tx, entityId: string) {
    return (
      await tx.auditLog.findMany({
        where: { entityId },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((row) => row.action);
  }

  // ─── Templates ──────────────────────────────────────────────────────────────

  describe('templates', () => {
    it('creates a template with several intervals per day and overnight rules', async () => {
      await scenario(async ({ tx, fx, templates }) => {
        const created = await templates.createTemplate(
          {
            organizationId: fx.orgA,
            name: '  Two-week split  ',
            description: 'Alternating weeks',
            rotationWeeks: 2,
            rules: [
              rule('MONDAY', '13:00', '17:00'),
              rule('MONDAY', '09:00', '12:00', {
                workLocationId: fx.workLocationToronto,
              }),
              rule('FRIDAY', '22:00', '06:00', { weekIndex: 1 }),
            ],
          },
          ctx(fx.users.templateAdmin),
        );
        expect(created).toMatchObject({
          organizationId: fx.orgA,
          name: 'Two-week split',
          rotationWeeks: 2,
          archivedAt: null,
        });
        expect(
          created.rules.map((row) => [
            row.weekIndex,
            row.dayOfWeek,
            row.startLocalTime,
            row.endLocalTime,
            row.overnight,
          ]),
        ).toEqual([
          [0, 'MONDAY', '09:00', '12:00', false],
          [0, 'MONDAY', '13:00', '17:00', false],
          [1, 'FRIDAY', '22:00', '06:00', true],
        ]);
        // Local wall-clock times are stored as DB-native TIME values.
        const [raw] = await tx.$queryRawUnsafe<Array<{ t: string }>>(
          `SELECT "startLocalTime"::text AS t FROM "ScheduleTemplateRule" WHERE "id" = $1::uuid`,
          created.rules[2]!.id,
        );
        expect(raw!.t).toBe('22:00:00');
        expect(await auditActions(tx, created.id)).toEqual([
          'SCHEDULE_TEMPLATE_CREATED',
        ]);
      });
    });

    it('reads within the organization and hides templates elsewhere', async () => {
      await scenario(async ({ fx, templates, template }) => {
        const created = await template();
        for (const user of [
          fx.users.templateAdmin,
          fx.users.patternAdmin,
          fx.users.deptAReader,
          fx.users.deptAPatterns,
        ]) {
          await expect(
            templates.getTemplate(user, created.id),
          ).resolves.toMatchObject({ id: created.id });
        }
        for (const user of [fx.users.orgBAdmin, fx.users.nobody]) {
          await expect(
            templates.getTemplate(user, created.id),
          ).rejects.toBeInstanceOf(NotFoundException);
          await expect(
            templates.listTemplates(user, { organizationId: fx.orgA }),
          ).rejects.toBeInstanceOf(NotFoundException);
        }
        const list = await templates.listTemplates(fx.users.deptAReader, {
          organizationId: fx.orgA,
        });
        expect(list.items).toEqual([
          expect.objectContaining({ id: created.id, ruleCount: 1 }),
        ]);
      });
    });

    it('requires schedule.manage_templates on the organization', async () => {
      await scenario(async ({ tx, fx, templates, template }) => {
        const input = {
          organizationId: fx.orgA,
          name: 'Nope',
          rotationWeeks: 1,
        };
        for (const user of [
          fx.users.patternAdmin,
          fx.users.deptAReader,
          fx.users.orgBAdmin,
          fx.users.nobody,
        ]) {
          await expect(
            templates.createTemplate(input, ctx(user)),
          ).rejects.toBeInstanceOf(ForbiddenException);
        }
        const created = await template();
        await expect(
          templates.updateTemplate(
            created.id,
            { name: 'Renamed' },
            ctx(fx.users.patternAdmin),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          templates.updateTemplate(
            created.id,
            { name: 'Renamed' },
            ctx(fx.users.orgBAdmin),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await auditActions(tx, created.id)).toEqual([
          'SCHEDULE_TEMPLATE_CREATED',
        ]);
      });
    });

    it('rejects invalid rotations, rules, references, and archived organizations without auditing', async () => {
      await scenario(async ({ tx, fx, templates }) => {
        const admin = ctx(fx.users.templateAdmin);
        const base = { organizationId: fx.orgA, name: 'Bad', rotationWeeks: 1 };
        for (const [input, type] of [
          [{ ...base, rotationWeeks: 0 }, BadRequestException],
          [
            {
              ...base,
              rules: [rule('MONDAY', '09:00', '17:00', { weekIndex: 1 })],
            },
            BadRequestException,
          ],
          [
            { ...base, rules: [rule('MONDAY', '25:00', '17:00')] },
            BadRequestException,
          ],
          [
            {
              ...base,
              rules: [
                rule('MONDAY', '09:00', '13:00'),
                rule('MONDAY', '12:00', '17:00'),
              ],
            },
            BadRequestException,
          ],
          [
            {
              ...base,
              rules: [
                rule('MONDAY', '09:00', '17:00'),
                rule('MONDAY', '09:00', '17:00'),
              ],
            },
            BadRequestException,
          ],
          [
            {
              ...base,
              rules: [
                rule('MONDAY', '09:00', '17:00', {
                  workLocationId: fx.workLocationOrgB,
                }),
              ],
            },
            BadRequestException,
          ],
          [
            {
              ...base,
              rules: [
                {
                  ...rule('MONDAY', '09:00', '17:00'),
                  timezone: undefined,
                  workLocationId: fx.workLocationNoTimezone,
                },
              ],
            },
            BadRequestException,
          ],
          [
            {
              ...base,
              rules: [
                rule('MONDAY', '09:00', '17:00', { timezone: 'Mars/Base' }),
              ],
            },
            BadRequestException,
          ],
          [
            {
              ...base,
              rules: [
                rule('MONDAY', '09:00', '17:00', {
                  workLocationId: randomUUID(),
                }),
              ],
            },
            NotFoundException,
          ],
        ] as const) {
          await expect(
            templates.createTemplate(input as never, admin),
          ).rejects.toBeInstanceOf(type);
        }
        await tx.workLocation.update({
          where: { id: fx.workLocationToronto },
          data: { archivedAt: new Date() },
        });
        await expect(
          templates.createTemplate(
            {
              ...base,
              rules: [
                rule('MONDAY', '09:00', '17:00', {
                  workLocationId: fx.workLocationToronto,
                }),
              ],
            },
            admin,
          ),
        ).rejects.toThrow('archived WorkLocation');
        // A WorkLocation with no timezone works with an explicit fallback.
        await expect(
          templates.createTemplate(
            {
              ...base,
              rules: [
                rule('MONDAY', '09:00', '17:00', {
                  workLocationId: fx.workLocationNoTimezone,
                }),
              ],
            },
            admin,
          ),
        ).resolves.toBeDefined();
        await tx.organization.update({
          where: { id: fx.orgA },
          data: { archivedAt: new Date() },
        });
        // Batch 5B (K9): grants of an archived organization no longer authorize anything, so the
        // organization-scoped administrator is refused before the archived-organization check.
        await expect(
          templates.createTemplate({ ...base, name: 'Late' }, admin),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // A SYSTEM administrator is still authorized (K9 never touches SYSTEM grants), and the
        // archived-organization business rule still refuses them.
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
        const permission = await tx.permission.findUniqueOrThrow({
          where: { key: 'schedule.manage_templates' },
        });
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          create: { roleId: role.id, permissionId: permission.id },
          update: {},
        });
        const systemPerson = await tx.person.create({ data: {} });
        const systemUser = await tx.user.create({
          data: {
            personId: systemPerson.id,
            email: `b5b-sys-${randomUUID()}@example.com`,
            status: 'ACTIVE',
          },
        });
        await tx.roleAssignment.create({
          data: { userId: systemUser.id, roleId: role.id, scopeType: 'SYSTEM' },
        });
        const systemRefusal = templates.createTemplate(
          { ...base, name: 'Late (system)' },
          ctx(systemUser.id),
        );
        await expect(systemRefusal).rejects.toBeInstanceOf(BadRequestException);
        await expect(systemRefusal).rejects.toThrow('archived organization');
        expect(
          await tx.auditLog.count({
            where: {
              action: 'SCHEDULE_TEMPLATE_CREATED',
              actorUserId: fx.users.templateAdmin,
            },
          }),
        ).toBe(1);
      });
    });

    it('updates names and rotations safely and keeps active names unique', async () => {
      await scenario(async ({ tx, fx, templates, template }) => {
        const admin = ctx(fx.users.templateAdmin);
        const created = await template({
          rotationWeeks: 2,
          rules: [
            rule('MONDAY', '09:00', '17:00'),
            rule('MONDAY', '09:00', '17:00', { weekIndex: 1 }),
          ],
        });
        await template({ name: 'Nights' });
        await expect(
          templates.updateTemplate(created.id, { name: 'NIGHTS' }, admin),
        ).rejects.toBeInstanceOf(ConflictException);
        // Shrinking the rotation would orphan week 1's rule.
        await expect(
          templates.updateTemplate(created.id, { rotationWeeks: 1 }, admin),
        ).rejects.toBeInstanceOf(BadRequestException);
        const updated = await templates.updateTemplate(
          created.id,
          { name: 'Renamed', description: 'Desc', rotationWeeks: 3 },
          admin,
        );
        expect(updated).toMatchObject({
          name: 'Renamed',
          description: 'Desc',
          rotationWeeks: 3,
        });
        // A no-op update records nothing.
        await templates.updateTemplate(created.id, { name: 'Renamed' }, admin);
        const audit = await tx.auditLog.findMany({
          where: { entityId: created.id, action: 'SCHEDULE_TEMPLATE_UPDATED' },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]!.metadata).toMatchObject({
          changes: {
            name: { from: 'Weekday days', to: 'Renamed' },
            rotationWeeks: { from: 2, to: 3 },
          },
        });
      });
    });

    it('manages rules with full rule-set validation and audit', async () => {
      await scenario(async ({ tx, fx, templates, template }) => {
        const admin = ctx(fx.users.templateAdmin);
        const created = await template();
        const added = await templates.createRule(
          created.id,
          rule('MONDAY', '17:00', '21:00'),
          admin,
        );
        await expect(
          templates.createRule(
            created.id,
            rule('MONDAY', '20:00', '22:00'),
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          templates.updateRule(
            created.id,
            added.id,
            { startLocalTime: '16:00' },
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        const updated = await templates.updateRule(
          created.id,
          added.id,
          { startLocalTime: '18:00', endLocalTime: '02:00' },
          admin,
        );
        expect(updated).toMatchObject({
          startLocalTime: '18:00',
          endLocalTime: '02:00',
          overnight: true,
        });
        await templates.deleteRule(created.id, added.id, admin);
        await expect(
          templates.deleteRule(created.id, added.id, admin),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await auditActions(tx, created.id)).toEqual([
          'SCHEDULE_TEMPLATE_CREATED',
          'SCHEDULE_TEMPLATE_RULE_CREATED',
          'SCHEDULE_TEMPLATE_RULE_UPDATED',
          'SCHEDULE_TEMPLATE_RULE_DELETED',
        ]);
      });
    });

    it('deletes unreferenced templates, archives referenced ones, and freezes archived ones', async () => {
      await scenario(async ({ tx, fx, templates, patterns, template }) => {
        const admin = ctx(fx.users.templateAdmin);
        const unused = await template({ name: 'Unused' });
        await templates.deleteTemplate(unused.id, admin);
        expect(
          await tx.scheduleTemplate.count({ where: { id: unused.id } }),
        ).toBe(0);
        expect(
          await tx.scheduleTemplateRule.count({
            where: { scheduleTemplateId: unused.id },
          }),
        ).toBe(0);

        const used = await template({ name: 'Used' });
        await patterns.applyTemplate(
          fx.assignmentTeamA,
          { templateId: used.id, effectiveFrom: FUTURE, anchorDate: FUTURE },
          ctx(fx.users.patternAdmin),
        );
        await expect(templates.deleteTemplate(used.id, admin)).rejects.toThrow(
          'archive it instead',
        );
        const archived = await templates.archiveTemplate(used.id, admin);
        expect(archived.archivedAt).toEqual(expect.any(String));
        await expect(
          templates.archiveTemplate(used.id, admin),
        ).resolves.toEqual(archived);
        for (const attempt of [
          () => templates.updateTemplate(used.id, { name: 'X' }, admin),
          () =>
            templates.createRule(
              used.id,
              rule('TUESDAY', '09:00', '17:00'),
              admin,
            ),
          () =>
            templates.updateRule(
              used.id,
              used.rules[0]!.id,
              { endLocalTime: '18:00' },
              admin,
            ),
          () => templates.deleteRule(used.id, used.rules[0]!.id, admin),
        ]) {
          await expect(attempt()).rejects.toBeInstanceOf(ConflictException);
        }
        // Archived names are history; the name is free for a new active template.
        await expect(template({ name: 'Used' })).resolves.toBeDefined();
        const list = await templates.listTemplates(fx.users.templateAdmin, {
          organizationId: fx.orgA,
        });
        expect(list.items.map((row) => row.archivedAt)).toEqual([null]);
        expect(
          (
            await templates.listTemplates(fx.users.templateAdmin, {
              organizationId: fx.orgA,
              includeArchived: true,
            })
          ).items,
        ).toHaveLength(2);
        expect(await auditActions(tx, unused.id)).toEqual([
          'SCHEDULE_TEMPLATE_CREATED',
          'SCHEDULE_TEMPLATE_DELETED',
        ]);
        expect(await auditActions(tx, used.id)).toEqual([
          'SCHEDULE_TEMPLATE_CREATED',
          'SCHEDULE_TEMPLATE_ARCHIVED',
        ]);
      });
    });
  });

  // ─── Patterns ───────────────────────────────────────────────────────────────

  describe('patterns', () => {
    const pattern = (
      effectiveFrom: string,
      effectiveTo?: string,
      rules = [rule('MONDAY', '09:00', '17:00')],
      rotationWeeks = 1,
    ) => ({
      effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}),
      anchorDate: effectiveFrom,
      rotationWeeks,
      rules,
    });

    it('creates a manual pattern for one assignment, readable within its scope', async () => {
      await scenario(async ({ tx, fx, patterns }) => {
        const created = await patterns.createPattern(
          fx.assignmentTeamA,
          {
            ...pattern(
              FUTURE,
              undefined,
              [
                rule('MONDAY', '09:00', '12:00'),
                rule('MONDAY', '13:00', '17:00'),
                rule('WEDNESDAY', '12:00', '20:00', { weekIndex: 1 }),
                rule('FRIDAY', '22:00', '06:00', {
                  workLocationId: fx.workLocationToronto,
                }),
              ],
              2,
            ),
            name: 'Rotating',
          },
          ctx(fx.users.deptAPatterns),
        );
        expect(created).toMatchObject({
          employmentAssignmentId: fx.assignmentTeamA,
          name: 'Rotating',
          effectiveFrom: FUTURE,
          effectiveTo: null,
          rotationWeeks: 2,
          anchorDate: FUTURE,
          sourceTemplateId: null,
        });
        expect(created.rules).toHaveLength(4);
        for (const user of [fx.users.deptAReader, fx.users.patternAdmin]) {
          await expect(
            patterns.getPattern(user, fx.assignmentTeamA, created.id),
          ).resolves.toEqual(created);
        }
        expect(
          (
            await patterns.listPatterns(
              fx.users.deptAReader,
              fx.assignmentTeamA,
            )
          ).items,
        ).toEqual([created]);
        // The pattern is reachable only through its own assignment.
        await expect(
          patterns.getPattern(
            fx.users.patternAdmin,
            fx.assignmentDeptB,
            created.id,
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await auditActions(tx, created.id)).toEqual([
          'EMPLOYEE_SCHEDULE_PATTERN_CREATED',
        ]);
      });
    });

    it('authorizes against the assignment position scope', async () => {
      await scenario(async ({ fx, patterns }) => {
        const input = pattern(FUTURE);
        // Dept A pattern managers cannot see Dept B's assignment.
        await expect(
          patterns.createPattern(
            fx.assignmentDeptB,
            input,
            ctx(fx.users.deptAPatterns),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          patterns.createPattern(
            fx.assignmentTeamA,
            input,
            ctx(fx.users.deptAReader),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        for (const user of [
          fx.users.orgBAdmin,
          fx.users.nobody,
          fx.users.templateAdmin,
        ]) {
          await expect(
            patterns.listPatterns(user, fx.assignmentTeamA),
          ).rejects.toBeInstanceOf(NotFoundException);
        }
        await expect(
          patterns.createPattern(
            fx.assignmentDeptB,
            input,
            ctx(fx.users.patternAdmin),
          ),
        ).resolves.toBeDefined();
      });
    });

    it('validates the period against itself, the anchor, and the assignment', async () => {
      await scenario(async ({ tx, fx, patterns }) => {
        const admin = ctx(fx.users.patternAdmin);
        for (const [assignment, input, message] of [
          [
            fx.assignmentTeamA,
            { ...pattern('2030-02-04', '2030-02-03') },
            'effectiveTo must be on or after effectiveFrom',
          ],
          [
            fx.assignmentTeamA,
            { ...pattern(FUTURE), anchorDate: '2030-01-08' },
            'anchorDate must be a Monday',
          ],
          [
            fx.assignmentTeamA,
            pattern('2025-12-29'),
            'cannot start before the EmploymentAssignment starts',
          ],
          [
            fx.endingAssignment,
            pattern(FUTURE),
            'must end on or before the EmploymentAssignment end date',
          ],
          [
            fx.endingAssignment,
            pattern(FUTURE, '2030-07-01'),
            'must end on or before the EmploymentAssignment end date',
          ],
          [
            fx.cancelledAssignment,
            pattern(FUTURE),
            'cancelled EmploymentAssignment',
          ],
        ] as const) {
          await expect(
            patterns.createPattern(assignment, input, admin),
          ).rejects.toThrow(message);
        }
        await expect(
          patterns.createPattern(
            fx.endingAssignment,
            pattern(FUTURE, '2030-06-30'),
            admin,
          ),
        ).resolves.toBeDefined();
        // A one-day pattern is valid; the anchor may differ from the start.
        await expect(
          patterns.createPattern(
            fx.assignmentTeamA,
            { ...pattern('2030-01-09', '2030-01-09'), anchorDate: FUTURE },
            admin,
          ),
        ).resolves.toBeDefined();
        expect(
          await tx.auditLog.count({
            where: {
              action: 'EMPLOYEE_SCHEDULE_PATTERN_CREATED',
              actorUserId: fx.users.patternAdmin,
            },
          }),
        ).toBe(2);
      });
    });

    it('rejects overlapping effective periods and allows touching or open-ended ones', async () => {
      await scenario(async ({ fx, patterns }) => {
        const admin = ctx(fx.users.patternAdmin);
        await patterns.createPattern(
          fx.assignmentTeamA,
          pattern('2030-01-07', '2030-03-31'),
          admin,
        );
        const error = await rejection(
          patterns.createPattern(
            fx.assignmentTeamA,
            pattern('2030-03-04', '2030-04-30'),
            admin,
          ),
        );
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'SCHEDULE_PATTERN_PERIOD_OVERLAP',
          overlappingPattern: {
            effectiveFrom: '2030-01-07',
            effectiveTo: '2030-03-31',
          },
        });
        await expect(
          patterns.createPattern(
            fx.assignmentTeamA,
            { ...pattern('2030-04-01'), anchorDate: '2030-04-01' },
            admin,
          ),
        ).resolves.toBeDefined();
        // Overlapping the open-ended pattern, before or after its start.
        for (const input of [
          pattern('2031-01-06'),
          pattern('2030-03-25', '2030-04-07'),
          { ...pattern('2029-12-31'), anchorDate: '2029-12-31' },
        ]) {
          await expect(
            patterns.createPattern(fx.assignmentTeamA, input, admin),
          ).rejects.toBeInstanceOf(ConflictException);
        }
        // Other assignments of the same Employee are independent.
        await expect(
          patterns.createPattern(fx.assignmentDeptB, pattern(FUTURE), admin),
        ).resolves.toBeDefined();
      });
    });

    it('validates pattern rules: rotation week, overlap, overnight, references', async () => {
      await scenario(async ({ fx, patterns }) => {
        const admin = ctx(fx.users.patternAdmin);
        const create = (rules: unknown[], rotationWeeks = 1) =>
          patterns.createPattern(
            fx.assignmentTeamA,
            pattern(FUTURE, undefined, rules as never, rotationWeeks),
            admin,
          );
        for (const rules of [
          [rule('MONDAY', '09:00', '13:00'), rule('MONDAY', '12:00', '17:00')],
          [rule('MONDAY', '22:00', '06:00'), rule('TUESDAY', '05:00', '10:00')],
          [rule('SUNDAY', '22:00', '06:00'), rule('MONDAY', '05:00', '07:00')],
          [rule('MONDAY', '09:00', '17:00', { weekIndex: 1 })],
          [
            rule('MONDAY', '09:00', '17:00', {
              workLocationId: fx.workLocationOrgB,
            }),
          ],
          [rule('MONDAY', '09:00', '17:00', { timezone: 'Not/AZone' })],
        ]) {
          await expect(create(rules)).rejects.toBeInstanceOf(
            BadRequestException,
          );
        }
        await expect(
          create([
            rule('MONDAY', '22:00', '06:00'),
            rule('TUESDAY', '06:00', '10:00'),
            rule('TUESDAY', '12:00', '14:00'),
            rule('TUESDAY', '15:00', '17:00'),
          ]),
        ).resolves.toBeDefined();
      });
    });

    it('edits not-yet-started patterns only, re-validating dates and rules', async () => {
      await scenario(async ({ tx, fx, patterns }) => {
        const admin = ctx(fx.users.patternAdmin);
        const future = await patterns.createPattern(
          fx.assignmentTeamA,
          pattern('2030-02-04', '2030-02-28'),
          admin,
        );
        await patterns.createPattern(
          fx.assignmentTeamA,
          pattern('2030-03-04', '2030-03-31'),
          admin,
        );
        await expect(
          patterns.updatePattern(
            fx.assignmentTeamA,
            future.id,
            { effectiveTo: '2030-03-10' },
            admin,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          patterns.updatePattern(
            fx.assignmentTeamA,
            future.id,
            { effectiveFrom: STARTED, anchorDate: STARTED },
            admin,
          ),
        ).rejects.toThrow('has started');
        const updated = await patterns.updatePattern(
          fx.assignmentTeamA,
          future.id,
          { effectiveTo: '2030-03-03', name: 'February', rotationWeeks: 2 },
          admin,
        );
        expect(updated).toMatchObject({
          effectiveTo: '2030-03-03',
          name: 'February',
          rotationWeeks: 2,
        });
        const added = await patterns.createRule(
          fx.assignmentTeamA,
          future.id,
          rule('MONDAY', '09:00', '17:00', { weekIndex: 1 }),
          admin,
        );
        await expect(
          patterns.updatePattern(
            fx.assignmentTeamA,
            future.id,
            { rotationWeeks: 1 },
            admin,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await patterns.updateRule(
          fx.assignmentTeamA,
          future.id,
          added.id,
          { endLocalTime: '18:00' },
          admin,
        );
        await patterns.deleteRule(
          fx.assignmentTeamA,
          future.id,
          added.id,
          admin,
        );
        await expect(
          patterns.deleteRule(
            fx.assignmentTeamA,
            future.id,
            future.rules[0]!.id,
            admin,
          ),
        ).rejects.toThrow('at least one rule');
        await patterns.deletePattern(fx.assignmentTeamA, future.id, admin);
        expect(
          await tx.employeeSchedulePattern.count({ where: { id: future.id } }),
        ).toBe(0);
        expect(await auditActions(tx, future.id)).toEqual([
          'EMPLOYEE_SCHEDULE_PATTERN_CREATED',
          'EMPLOYEE_SCHEDULE_PATTERN_UPDATED',
          'EMPLOYEE_SCHEDULE_PATTERN_RULE_CREATED',
          'EMPLOYEE_SCHEDULE_PATTERN_RULE_UPDATED',
          'EMPLOYEE_SCHEDULE_PATTERN_RULE_DELETED',
          'EMPLOYEE_SCHEDULE_PATTERN_DELETED',
        ]);
      });
    });

    it('keeps started patterns as history: they can only be ended, never rewritten', async () => {
      await scenario(async ({ tx, fx, patterns }) => {
        const admin = ctx(fx.users.patternAdmin);
        const started = await patterns.createPattern(
          fx.assignmentTeamA,
          pattern(STARTED),
          admin,
        );
        for (const attempt of [
          () =>
            patterns.updatePattern(
              fx.assignmentTeamA,
              started.id,
              { name: 'Changed' },
              admin,
            ),
          () =>
            patterns.createRule(
              fx.assignmentTeamA,
              started.id,
              rule('TUESDAY', '09:00', '17:00'),
              admin,
            ),
          () =>
            patterns.updateRule(
              fx.assignmentTeamA,
              started.id,
              started.rules[0]!.id,
              { endLocalTime: '18:00' },
              admin,
            ),
          () =>
            patterns.deleteRule(
              fx.assignmentTeamA,
              started.id,
              started.rules[0]!.id,
              admin,
            ),
          () => patterns.deletePattern(fx.assignmentTeamA, started.id, admin),
        ]) {
          await expect(attempt()).rejects.toThrow('has started');
        }
        // Ending cannot reach back into days that are already past.
        await expect(
          patterns.endPattern(
            fx.assignmentTeamA,
            started.id,
            { effectiveTo: '2026-02-01' },
            admin,
          ),
        ).rejects.toThrow('before yesterday');
        const ended = await patterns.endPattern(
          fx.assignmentTeamA,
          started.id,
          { effectiveTo: '2029-12-31' },
          admin,
        );
        expect(ended).toMatchObject({
          effectiveFrom: STARTED,
          effectiveTo: '2029-12-31',
        });
        expect(ended.rules).toEqual(started.rules);
        await expect(
          patterns.endPattern(
            fx.assignmentTeamA,
            started.id,
            { effectiveTo: '2029-12-31' },
            admin,
          ),
        ).resolves.toEqual(ended);
        await expect(
          patterns.endPattern(
            fx.assignmentTeamA,
            started.id,
            { effectiveTo: '2030-06-30' },
            admin,
          ),
        ).rejects.toThrow('only shorten');
        // The replacement starts the day after; the old row stays as history.
        await patterns.createPattern(
          fx.assignmentTeamA,
          { ...pattern('2030-01-01'), anchorDate: '2029-12-31' },
          admin,
        );
        expect(
          (
            await patterns.listPatterns(
              fx.users.patternAdmin,
              fx.assignmentTeamA,
            )
          ).items.map((row) => [row.effectiveFrom, row.effectiveTo]),
        ).toEqual([
          [STARTED, '2029-12-31'],
          ['2030-01-01', null],
        ]);
        const audit = await tx.auditLog.findMany({
          where: {
            entityId: started.id,
            action: 'EMPLOYEE_SCHEDULE_PATTERN_ENDED',
          },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]!.metadata).toMatchObject({
          previousEffectiveTo: null,
          effectiveTo: '2029-12-31',
        });
      });
    });
  });

  // ─── Template application ───────────────────────────────────────────────────

  describe('template application', () => {
    it('copies rotation and rules with provenance and never inherits later edits', async () => {
      await scenario(async ({ tx, fx, templates, patterns, template }) => {
        const admin = ctx(fx.users.templateAdmin);
        const source = await template({
          name: 'Two-week',
          rotationWeeks: 2,
          rules: [
            rule('MONDAY', '09:00', '17:00', {
              workLocationId: fx.workLocationToronto,
            }),
            rule('TUESDAY', '09:00', '17:00'),
            rule('WEDNESDAY', '12:00', '20:00', { weekIndex: 1, sortOrder: 2 }),
            rule('FRIDAY', '22:00', '06:00', { weekIndex: 1 }),
          ],
        });
        const applied = await patterns.applyTemplate(
          fx.assignmentTeamA,
          {
            templateId: source.id,
            effectiveFrom: FUTURE,
            anchorDate: FUTURE,
          },
          ctx(fx.users.deptAPatterns),
        );
        expect(applied).toMatchObject({
          name: 'Two-week',
          rotationWeeks: 2,
          sourceTemplateId: source.id,
          effectiveFrom: FUTURE,
          anchorDate: FUTURE,
        });
        const strip = (rows: Array<Record<string, unknown>>) =>
          rows.map(
            ({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest,
          );
        const templateRules = (
          await templates.getTemplate(fx.users.templateAdmin, source.id)
        ).rules;
        expect(strip(applied.rules)).toEqual(strip(templateRules));
        expect(applied.rules.map((row) => row.id)).not.toContain(
          templateRules[0]!.id,
        );

        // Later template edits do not reach the pattern.
        await templates.updateRule(
          source.id,
          templateRules[0]!.id,
          { startLocalTime: '07:00' },
          admin,
        );
        await templates.createRule(
          source.id,
          rule('SATURDAY', '10:00', '14:00'),
          admin,
        );
        await templates.updateTemplate(
          source.id,
          { name: 'Renamed', rotationWeeks: 3 },
          admin,
        );
        await templates.archiveTemplate(source.id, admin);
        await expect(
          patterns.getPattern(
            fx.users.patternAdmin,
            fx.assignmentTeamA,
            applied.id,
          ),
        ).resolves.toEqual(applied);

        const audit = await tx.auditLog.findMany({
          where: { entityId: applied.id },
        });
        expect(audit.map((row) => row.action)).toEqual([
          'SCHEDULE_TEMPLATE_APPLIED',
        ]);
        expect(audit[0]!.metadata).toMatchObject({
          templateId: source.id,
          templateName: 'Two-week',
          pattern: expect.objectContaining({ id: applied.id }),
        });
      });
    });

    it('enforces organization, template state, authorization, and the period rules', async () => {
      await scenario(async ({ tx, fx, templates, patterns, template }) => {
        const apply = (templateId: string, user = fx.users.patternAdmin) =>
          patterns.applyTemplate(
            fx.assignmentTeamA,
            { templateId, effectiveFrom: FUTURE, anchorDate: FUTURE },
            ctx(user),
          );
        const orgBTemplate = await templates.createTemplate(
          {
            organizationId: fx.orgB,
            name: 'Org B',
            rotationWeeks: 1,
            rules: [rule('MONDAY', '09:00', '17:00')],
          },
          ctx(fx.users.orgBAdmin),
        );
        await expect(apply(orgBTemplate.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(apply(randomUUID())).rejects.toBeInstanceOf(
          NotFoundException,
        );
        const empty = await template({ name: 'Empty', rules: [] });
        await expect(apply(empty.id)).rejects.toThrow('no rules');
        const good = await template({
          name: 'Good',
          rules: [
            rule('MONDAY', '09:00', '17:00', {
              workLocationId: fx.workLocationToronto,
            }),
          ],
        });
        await expect(
          apply(good.id, fx.users.deptAReader),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          apply(good.id, fx.users.templateAdmin),
        ).rejects.toBeInstanceOf(NotFoundException);
        // A WorkLocation archived since the template was built cannot be copied into new rules.
        await tx.workLocation.update({
          where: { id: fx.workLocationToronto },
          data: { archivedAt: new Date() },
        });
        await expect(apply(good.id)).rejects.toThrow('archived WorkLocation');
        await tx.workLocation.update({
          where: { id: fx.workLocationToronto },
          data: { archivedAt: null },
        });
        await apply(good.id);
        await expect(apply(good.id)).rejects.toBeInstanceOf(ConflictException);
        await templates.archiveTemplate(good.id, ctx(fx.users.templateAdmin));
        await expect(
          patterns.applyTemplate(
            fx.assignmentDeptB,
            { templateId: good.id, effectiveFrom: FUTURE, anchorDate: FUTURE },
            ctx(fx.users.patternAdmin),
          ),
        ).rejects.toThrow('Archived templates cannot be applied');
        expect(
          await tx.auditLog.count({
            where: {
              action: 'SCHEDULE_TEMPLATE_APPLIED',
              actorUserId: {
                in: [
                  fx.users.patternAdmin,
                  fx.users.deptAReader,
                  fx.users.templateAdmin,
                ],
              },
            },
          }),
        ).toBe(1);
      });
    });
  });

  // ─── Database integrity ─────────────────────────────────────────────────────

  describe('constraints', () => {
    it('enforces rotation, week index, timezone source, period, anchor, and names', async () => {
      await scenario(async ({ tx, fx, template }) => {
        const created = await template();
        const time = (h: number) => new Date(Date.UTC(1970, 0, 1, h));
        const ruleData = {
          scheduleTemplateId: created.id,
          weekIndex: 0,
          dayOfWeek: 'MONDAY' as const,
          startLocalTime: time(9),
          endLocalTime: time(17),
          timezone: 'UTC',
        };
        const patternData = {
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: new Date('2030-01-07T00:00:00Z'),
          anchorDate: new Date('2030-01-07T00:00:00Z'),
          rotationWeeks: 1,
        };
        for (const run of [
          () =>
            tx.scheduleTemplate.create({
              data: { organizationId: fx.orgA, name: 'Zero', rotationWeeks: 0 },
            }),
          () =>
            tx.scheduleTemplate.create({
              data: { organizationId: fx.orgA, name: ' ', rotationWeeks: 1 },
            }),
          () =>
            tx.scheduleTemplateRule.create({
              data: { ...ruleData, weekIndex: -1 },
            }),
          () =>
            tx.scheduleTemplateRule.create({
              data: { ...ruleData, timezone: null },
            }),
          () =>
            tx.scheduleTemplateRule.create({
              data: { ...ruleData, timezone: '  ' },
            }),
          () =>
            tx.employeeSchedulePattern.create({
              data: { ...patternData, rotationWeeks: 53 },
            }),
          () =>
            tx.employeeSchedulePattern.create({
              data: {
                ...patternData,
                effectiveTo: new Date('2030-01-06T00:00:00Z'),
              },
            }),
          () =>
            tx.employeeSchedulePattern.create({
              data: {
                ...patternData,
                anchorDate: new Date('2030-01-08T00:00:00Z'),
              },
            }),
        ]) {
          expect(await violation(tx, run)).toMatchObject({
            code: expect.stringMatching(/^P(2004|2010|2039)$/),
          });
        }
        expect(
          await violation(tx, () =>
            tx.scheduleTemplate.create({
              data: {
                organizationId: fx.orgA,
                name: 'WEEKDAY DAYS',
                rotationWeeks: 1,
              },
            }),
          ),
        ).toMatchObject({ code: 'P2002' });
      });
    });
  });

  // ─── Regression ─────────────────────────────────────────────────────────────

  describe('no generation', () => {
    it('never creates shifts, schedules, or revisions from templates or patterns', async () => {
      await scenario(async ({ tx, fx, patterns, template }) => {
        // Counted within this scenario's organization: other spec files commit their own
        // fixtures concurrently, so global counts are not stable.
        const counts = () =>
          Promise.all([
            tx.schedule.count({ where: { organizationId: fx.orgA } }),
            tx.scheduledShift.count({
              where: { schedule: { organizationId: fx.orgA } },
            }),
            tx.scheduledShiftRevision.count({
              where: {
                scheduledShift: { schedule: { organizationId: fx.orgA } },
              },
            }),
          ]);
        const before = await counts();
        const source = await template();
        await patterns.applyTemplate(
          fx.assignmentTeamA,
          {
            templateId: source.id,
            effectiveFrom: STARTED,
            anchorDate: STARTED,
          },
          ctx(fx.users.patternAdmin),
        );
        await patterns.createPattern(
          fx.assignmentDeptB,
          {
            effectiveFrom: STARTED,
            anchorDate: STARTED,
            rotationWeeks: 1,
            rules: [rule('TUESDAY', '09:00', '17:00')],
          },
          ctx(fx.users.patternAdmin),
        );
        expect(await counts()).toEqual(before);
      });
    });
  });

  // ─── Concurrency (committed data, real concurrent transactions) ─────────────

  describe('concurrency', () => {
    let fx: Fixtures;

    beforeAll(async () => {
      fx = await prisma.$transaction((tx) => createFixtures(tx), {
        timeout: 30_000,
      });
    });

    afterAll(async () => {
      if (fx) await cleanupFixtures(prisma, fx);
    });

    /** Each request pauses after its overlap query, widening the race window. */
    function racing(pauseMs = 250) {
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
      return services(client);
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

    async function overlappingPairs(assignmentId: string) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM "EmployeeSchedulePattern" a
           JOIN "EmployeeSchedulePattern" b ON a."id" < b."id"
          WHERE a."employmentAssignmentId" = $1::uuid
            AND b."employmentAssignmentId" = $1::uuid
            AND daterange(a."effectiveFrom", a."effectiveTo", '[]')
             && daterange(b."effectiveFrom", b."effectiveTo", '[]')`,
        assignmentId,
      );
      return Number(rows[0]!.count);
    }

    it('never creates overlapping periods from concurrent creates and applications', async () => {
      const admin = ctx(fx.users.patternAdmin);
      const source = await services(prisma).templates.createTemplate(
        {
          organizationId: fx.orgA,
          name: 'Concurrent',
          rotationWeeks: 1,
          rules: [rule('MONDAY', '09:00', '17:00')],
        },
        ctx(fx.users.templateAdmin),
      );
      const svc = racing();
      const input = (from: string, to?: string) => ({
        effectiveFrom: from,
        ...(to ? { effectiveTo: to } : {}),
        anchorDate: from,
        rotationWeeks: 1,
        rules: [rule('MONDAY', '09:00', '17:00')],
      });
      const { fulfilled, rejected } = await settle(
        svc.patterns.createPattern(fx.assignmentTeamA, input(FUTURE), admin),
        svc.patterns.createPattern(
          fx.assignmentTeamA,
          input('2030-02-04', '2030-03-31'),
          admin,
        ),
        svc.patterns.applyTemplate(
          fx.assignmentTeamA,
          {
            templateId: source.id,
            effectiveFrom: '2030-01-14',
            anchorDate: '2030-01-14',
          },
          admin,
        ),
      );
      expect(fulfilled).toBe(1);
      expect(rejected).toHaveLength(2);
      for (const error of rejected) {
        expect(error).toBeInstanceOf(ConflictException);
      }
      expect(await overlappingPairs(fx.assignmentTeamA)).toBe(0);
    });

    it('serializes an effective-date edit against a create', async () => {
      const admin = ctx(fx.users.patternAdmin);
      const existing = await services(prisma).patterns.createPattern(
        fx.assignmentDeptB,
        {
          effectiveFrom: '2031-01-06',
          effectiveTo: '2031-01-31',
          anchorDate: '2031-01-06',
          rotationWeeks: 1,
          rules: [rule('MONDAY', '09:00', '17:00')],
        },
        admin,
      );
      const svc = racing();
      const { fulfilled, rejected } = await settle(
        svc.patterns.updatePattern(
          fx.assignmentDeptB,
          existing.id,
          { effectiveTo: '2031-03-31' },
          admin,
        ),
        svc.patterns.createPattern(
          fx.assignmentDeptB,
          {
            effectiveFrom: '2031-03-03',
            anchorDate: '2031-03-03',
            rotationWeeks: 1,
            rules: [rule('MONDAY', '09:00', '17:00')],
          },
          admin,
        ),
      );
      expect(fulfilled).toBe(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toBeInstanceOf(ConflictException);
      expect(await overlappingPairs(fx.assignmentDeptB)).toBe(0);
    });

    it('serializes template rule changes so concurrent rules cannot overlap', async () => {
      const admin = ctx(fx.users.templateAdmin);
      const created = await services(prisma).templates.createTemplate(
        { organizationId: fx.orgA, name: 'Rule race', rotationWeeks: 1 },
        admin,
      );
      const svc = racing();
      const { fulfilled, rejected } = await settle(
        svc.templates.createRule(
          created.id,
          rule('MONDAY', '09:00', '13:00'),
          admin,
        ),
        svc.templates.createRule(
          created.id,
          rule('MONDAY', '12:00', '17:00'),
          admin,
        ),
      );
      expect(fulfilled).toBe(1);
      expect(rejected[0]).toBeInstanceOf(BadRequestException);
      expect(
        await prisma.scheduleTemplateRule.count({
          where: { scheduleTemplateId: created.id },
        }),
      ).toBe(1);
    });

    it('rolls a template application back completely when a later step fails', async () => {
      const source = await services(prisma).templates.createTemplate(
        {
          organizationId: fx.orgA,
          name: 'Atomic',
          rotationWeeks: 1,
          rules: [
            rule('MONDAY', '09:00', '17:00'),
            rule('TUESDAY', '09:00', '17:00'),
          ],
        },
        ctx(fx.users.templateAdmin),
      );
      class FailingAudit extends AuditService {
        override write(): never {
          throw new Error('audit unavailable');
        }
      }
      const before = await prisma.employeeSchedulePattern.count({
        where: { sourceTemplateId: source.id },
      });
      await expect(
        services(prisma, new FailingAudit(prisma)).patterns.applyTemplate(
          fx.endingAssignment,
          {
            templateId: source.id,
            effectiveFrom: FUTURE,
            effectiveTo: '2030-06-30',
            anchorDate: FUTURE,
          },
          ctx(fx.users.patternAdmin),
        ),
      ).rejects.toThrow('audit unavailable');
      expect(
        await prisma.employeeSchedulePattern.count({
          where: { sourceTemplateId: source.id },
        }),
      ).toBe(before);
      expect(
        await prisma.employeeSchedulePatternRule.count({
          where: {
            employeeSchedulePattern: {
              employmentAssignmentId: fx.endingAssignment,
            },
          },
        }),
      ).toBe(0);
    });
  });
});

/** Each violation runs in a savepoint so the scenario transaction stays usable. */
async function violation(tx: Tx, run: () => Promise<unknown>) {
  await tx.$executeRawUnsafe('SAVEPOINT recurrence_check');
  const error = await rejection(run());
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT recurrence_check');
  return error;
}

/** Routes the services' own $transaction calls into the test transaction so it rolls back. */
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

/** Delays overlap-check and template reads so concurrent requests overlap in the race window. */
function pausingTx(tx: Tx, pauseMs: number): Tx {
  const delayed = <T extends object>(delegate: T, methods: string[]) =>
    new Proxy(delegate, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (
          typeof property !== 'string' ||
          !methods.includes(property) ||
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
  const patterns = delayed(tx.employeeSchedulePattern, ['findFirst']);
  const templates = delayed(tx.scheduleTemplate, ['findUnique']);
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'employeeSchedulePattern') return patterns;
      if (property === 'scheduleTemplate') return templates;
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
    data: { name: 'Recurrence Org A', code: code('RA') },
  });
  const orgB = await tx.organization.create({
    data: { name: 'Recurrence Org B', code: code('RB') },
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
  const position = (name: string, data: Record<string, string>) =>
    tx.position.create({
      data: {
        organizationId: orgA.id,
        jobTitleId: jobTitle.id,
        name,
        code: code(name.replaceAll(' ', '').toUpperCase().slice(0, 6)),
        ...data,
      },
    });
  const positionTeamA = await position('Team A', {
    organizationalUnitId: unitA.id,
    departmentId: deptA.id,
    teamId: teamA.id,
  });
  const positionDeptB = await position('Dept B', { departmentId: deptB.id });
  const location = (
    organizationId: string,
    name: string,
    timezone: string | null,
  ) =>
    tx.workLocation.create({
      data: { organizationId, name, code: code(name.slice(0, 4)), timezone },
    });
  const toronto = await location(orgA.id, 'Toronto', 'America/Toronto');
  const noTimezone = await location(orgA.id, 'Nowhere', null);
  const orgBLocation = await location(orgB.id, 'Bravo', 'UTC');

  const person = await tx.person.create({ data: {} });
  const employee = await tx.employee.create({
    data: {
      personId: person.id,
      employeeNumber: code('RE'),
      hireDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  const assignment = async (
    positionId: string,
    data: Partial<{
      status: 'ACTIVE' | 'CANCELLED';
      endDate: Date;
      isPrimary: boolean;
    }> = {},
  ) =>
    (
      await tx.employmentAssignment.create({
        data: {
          employeeId: employee.id,
          positionId,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          ...data,
        },
      })
    ).id;

  const role = async (
    organizationId: string,
    keys: readonly (typeof PERMISSIONS)[number][],
  ) => {
    const created = await tx.role.create({
      data: {
        organizationId,
        code: code(`R${randomUUID().slice(0, 6)}`),
        name: 'Recurrence role',
      },
    });
    for (const key of keys) {
      await tx.rolePermission.create({
        data: { roleId: created.id, permissionId: permissions[key] },
      });
    }
    return created.id;
  };
  const templateRole = await role(orgA.id, ['schedule.manage_templates']);
  const patternRole = await role(orgA.id, [
    'schedule.read',
    'schedule.manage_patterns',
  ]);
  const patternsOnly = await role(orgA.id, ['schedule.manage_patterns']);
  const readRole = await role(orgA.id, ['schedule.read']);
  const allB = await role(orgB.id, PERMISSIONS);

  type Grant = {
    roleId: string;
    organizationId: string;
    scopeType: 'ORGANIZATION' | 'DEPARTMENT';
    departmentId?: string;
  };
  const user = async (label: string, grants: Grant[]) => {
    const userPerson = await tx.person.create({ data: {} });
    const created = await tx.user.create({
      data: {
        personId: userPerson.id,
        email: `recurrence-${label}-${suffix.toLowerCase()}@example.com`,
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
    assignmentTeamA: await assignment(positionTeamA.id, { isPrimary: true }),
    assignmentDeptB: await assignment(positionDeptB.id),
    endingAssignment: await assignment(positionDeptB.id, {
      endDate: new Date('2030-06-30T00:00:00.000Z'),
    }),
    cancelledAssignment: await assignment(positionDeptB.id, {
      status: 'CANCELLED',
    }),
    workLocationToronto: toronto.id,
    workLocationNoTimezone: noTimezone.id,
    workLocationOrgB: orgBLocation.id,
    users: {
      templateAdmin: await user('templates', [org(templateRole)]),
      patternAdmin: await user('patterns', [org(patternRole)]),
      deptAPatterns: await user('dept-a-patterns', [dept(patternsOnly)]),
      deptAReader: await user('dept-a-reader', [dept(readRole)]),
      orgBAdmin: await user('org-b', [org(allB, orgB.id)]),
      nobody: await user('nobody', []),
    },
  };
}

/** Removes committed concurrency fixtures in foreign-key order. */
async function cleanupFixtures(prisma: PrismaService, fx: Fixtures) {
  const userIds = Object.values(fx.users);
  const organizationIds = [fx.orgA, fx.orgB];
  await prisma.$transaction(async (tx) => {
    const patterns = await tx.employeeSchedulePattern.findMany({
      where: {
        employmentAssignment: { position: { organizationId: fx.orgA } },
      },
      select: { id: true },
    });
    const templates = await tx.scheduleTemplate.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { id: true },
    });
    const patternIds = patterns.map((row) => row.id);
    const templateIds = templates.map((row) => row.id);
    // Batch R2: audit entries are append-only; test clean-up bypasses the guard (superuser only).
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    // Entries by the fixture users go too: deleting those users would otherwise rewrite the
    // entries' actor (ON DELETE SET NULL), which the guard refuses.
    await tx.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: [...patternIds, ...templateIds] } },
          { actorUserId: { in: userIds } },
        ],
      },
    });
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
    await tx.employeeSchedulePatternRule.deleteMany({
      where: { employeeSchedulePatternId: { in: patternIds } },
    });
    await tx.employeeSchedulePattern.deleteMany({
      where: { id: { in: patternIds } },
    });
    await tx.scheduleTemplateRule.deleteMany({
      where: { scheduleTemplateId: { in: templateIds } },
    });
    await tx.scheduleTemplate.deleteMany({
      where: { id: { in: templateIds } },
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
    await tx.workLocation.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
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
