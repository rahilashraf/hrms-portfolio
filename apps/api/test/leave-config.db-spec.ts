import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  TIME_PERMISSIONS,
  type LeaveServices,
} from './support/leave-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const errorBody = (error: unknown) =>
  (error as { getResponse(): Record<string, unknown> }).getResponse();

describe('Leave configuration and calendar (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: {
      tx: Tx;
      fx: SchedulingFixtures;
      svc: LeaveServices;
      hr: ReturnType<typeof ctx>;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, LEAVE_USERS, [
            ...LEAVE_PERMISSIONS,
            ...TIME_PERMISSIONS,
          ]);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const svc = leaveServices(rollbackClient(tx));
          await (async () =>
            run({ tx, fx, svc, hr: ctx(fx.users.hr!) }))().catch(
            (error: unknown) => {
              console.error(
                'SCENARIO FAILURE:',
                error instanceof Error ? error.message.slice(-700) : error,
              );
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('manages scoped holidays with duplicate protection and audit', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const orgWide = await svc.holidays.create(
        {
          organizationId: fx.orgA,
          date: '2027-07-01',
          name: 'Canada Day',
          kind: 'STATUTORY_HOLIDAY',
        },
        hr,
      );
      await svc.holidays.create(
        {
          organizationId: fx.orgA,
          departmentId: fx.deptB,
          date: '2027-07-02',
          name: 'School closure',
          kind: 'CLOSURE',
        },
        hr,
      );
      // The unique index rejects the insert; a savepoint keeps the scenario transaction usable.
      const duplicate = await violation(tx, () =>
        svc.holidays.create(
          {
            organizationId: fx.orgA,
            date: '2027-07-01',
            name: 'Again',
            kind: 'CLOSURE',
          },
          hr,
        ),
      );
      expect(errorBody(duplicate)).toMatchObject({ code: 'HOLIDAY_DUPLICATE' });
      // Scope applicability: Dept B's closure does not apply to Team A positions.
      const teamATarget = await svc.targets.resolvePosition(fx.positionTeamA);
      const deptBTarget = await svc.targets.resolvePosition(fx.positionDeptB);
      const range = [
        new Date('2027-07-01T00:00:00Z'),
        new Date('2027-07-31T00:00:00Z'),
      ] as const;
      expect(
        (await svc.holidays.applicableHolidays(tx, teamATarget, ...range)).map(
          (h) => h.name,
        ),
      ).toEqual(['Canada Day']);
      expect(
        (await svc.holidays.applicableHolidays(tx, deptBTarget, ...range)).map(
          (h) => h.name,
        ),
      ).toEqual(['Canada Day', 'School closure']);
      // Team-scoped approvers cannot manage organization holidays; outsiders cannot read them.
      await expect(
        svc.holidays.create(
          {
            organizationId: fx.orgA,
            date: '2027-08-01',
            name: 'x',
            kind: 'CLOSURE',
          },
          ctx(fx.users.teamApprover!),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.holidays.list(fx.users.outsider!, {
          organizationId: fx.orgA,
          from: '2027-01-01',
          to: '2027-12-31',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // A unit holiday must name a unit of its own organization.
      await expect(
        svc.holidays.create(
          {
            organizationId: fx.orgB,
            organizationalUnitId: fx.unitChild,
            date: '2027-08-02',
            name: 'x',
            kind: 'CLOSURE',
          },
          ctx(fx.users.outsider!),
        ),
      ).rejects.toThrow();
      // Row actions mirror update/archive: holiday.manage on each holiday's own scope.
      const scoped = await svc.holidays.list(fx.users.deptBHolidays!, {
        organizationId: fx.orgA,
        from: '2027-01-01',
        to: '2027-12-31',
      });
      expect(
        scoped.items.map((h) => [
          h.name,
          h.actions.canEdit,
          h.actions.canArchive,
        ]),
      ).toEqual([
        ['Canada Day', false, false],
        ['School closure', true, true],
      ]);
      await svc.holidays.update(
        orgWide.id,
        { name: 'Canada Day (observed)' },
        hr,
      );
      await svc.holidays.archive(orgWide.id, hr);
      const listed = await svc.holidays.list(fx.users.hr!, {
        organizationId: fx.orgA,
        from: '2027-01-01',
        to: '2027-12-31',
      });
      expect(listed.items.map((h) => h.name)).toEqual(['School closure']);
      // Archived: a new one may take its date.
      await svc.holidays.create(
        {
          organizationId: fx.orgA,
          date: '2027-07-01',
          name: 'Canada Day',
          kind: 'STATUTORY_HOLIDAY',
        },
        hr,
      );
      expect(
        await tx.auditLog.count({
          where: {
            entityId: orgWide.id,
            action: {
              in: ['HOLIDAY_CREATED', 'HOLIDAY_UPDATED', 'HOLIDAY_ARCHIVED'],
            },
          },
        }),
      ).toBe(3);
      expect(
        await violation(tx, () =>
          tx.organizationHoliday.create({
            data: {
              organizationId: fx.orgA,
              departmentId: fx.deptA,
              teamId: fx.teamA,
              date: new Date('2027-09-01T00:00:00Z'),
              name: 'x',
              kind: 'CLOSURE',
            },
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining('scope_shape') });
    });
  });

  it('scopes holiday listing and management the same way for every kind of holder', async () => {
    await scenario(async ({ fx, svc, hr }) => {
      const create = (
        date: string,
        name: string,
        scope: Record<string, string> = {},
      ) =>
        svc.holidays.create(
          { organizationId: fx.orgA, date, name, kind: 'CLOSURE', ...scope },
          hr,
        );
      const orgWide = await create('2027-07-01', 'Canada Day');
      const deptB = await create('2027-07-02', 'School closure', {
        departmentId: fx.deptB,
      });
      await create('2027-07-03', 'Team outing', { teamId: fx.teamA });
      await create('2027-07-05', 'Unit day', {
        organizationalUnitId: fx.unitRoot,
      });
      const list = async (user: string) =>
        (
          await svc.holidays.list(user, {
            organizationId: fx.orgA,
            from: '2027-01-01',
            to: '2027-12-31',
          })
        ).items.map((h) => [h.name, h.actions.canEdit]);
      // Organization-level manager: everything, all manageable.
      expect(await list(fx.users.hr!)).toEqual([
        ['Canada Day', true],
        ['School closure', true],
        ['Team outing', true],
        ['Unit day', true],
      ]);
      // Department-scoped manager: its own holidays plus those that apply to it.
      expect(await list(fx.users.deptBHolidays!)).toEqual([
        ['Canada Day', false],
        ['School closure', true],
      ]);
      // Team-scoped manager: the enclosing unit's holiday applies to it, Dept B's does not.
      expect(await list(fx.users.teamAHolidays!)).toEqual([
        ['Canada Day', false],
        ['Team outing', true],
        ['Unit day', false],
      ]);
      // A scoped approver reads the same area and manages nothing.
      expect(await list(fx.users.teamApprover!)).toEqual([
        ['Canada Day', false],
        ['Team outing', false],
        ['Unit day', false],
      ]);
      for (const user of [fx.users.outsider!, fx.selfUser1]) {
        await expect(
          svc.holidays.list(user, {
            organizationId: fx.orgA,
            from: '2027-01-01',
            to: '2027-12-31',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      // The endpoints agree with the row actions.
      const deptBManager = ctx(fx.users.deptBHolidays!);
      await svc.holidays.update(
        deptB.id,
        { name: 'School closure (staff)' },
        deptBManager,
      );
      await expect(
        svc.holidays.update(orgWide.id, { name: 'x' }, deptBManager),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.holidays.create(
          {
            organizationId: fx.orgA,
            date: '2027-08-01',
            name: 'x',
            kind: 'CLOSURE',
          },
          deptBManager,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await svc.holidays.create(
        {
          organizationId: fx.orgA,
          departmentId: fx.deptB,
          date: '2027-08-02',
          name: 'Dept B day',
          kind: 'CLOSURE',
        },
        deptBManager,
      );
      await expect(
        svc.holidays.create(
          {
            organizationId: fx.orgA,
            teamId: fx.teamA,
            date: '2027-08-03',
            name: 'x',
            kind: 'CLOSURE',
          },
          deptBManager,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // And the organization read model advertises exactly that.
      const scopedOrg = (await svc.views.organizations(fx.users.deptBHolidays!))
        .items[0]!;
      expect(scopedOrg.actions).toMatchObject({
        canReadHolidays: true,
        canManageHolidays: true,
        canManageOrganizationHolidays: false,
      });
      expect(scopedOrg.holidayScopes).toEqual([
        { type: 'DEPARTMENT', id: fx.deptB, name: 'Dept B' },
      ]);
      const hrOrg = (await svc.views.organizations(fx.users.hr!)).items[0]!;
      expect(hrOrg.actions).toMatchObject({
        canManageHolidays: true,
        canManageOrganizationHolidays: true,
      });
      expect(hrOrg.holidayScopes).toEqual([]);
    });
  });

  it('keeps leave types organization-scoped with immutable classification', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const type = await svc.config.createType(
        {
          organizationId: fx.orgA,
          code: 'sick leave',
          name: 'Sick',
          classification: 'PAID',
        },
        hr,
      );
      expect(type).toMatchObject({
        code: 'SICK-LEAVE',
        tracksBalance: true,
        displayUnit: 'DAYS',
      });
      const duplicate = await violation(tx, () =>
        svc.config.createType(
          {
            organizationId: fx.orgA,
            code: 'SICK-LEAVE',
            name: 'Again',
            classification: 'UNPAID',
          },
          hr,
        ),
      );
      expect(errorBody(duplicate)).toMatchObject({
        code: 'LEAVE_TYPE_CODE_TAKEN',
      });
      const updated = await svc.config.updateType(
        type.id,
        { name: 'Sick days', displayUnit: 'HOURS' },
        hr,
      );
      expect(updated).toMatchObject({
        name: 'Sick days',
        displayUnit: 'HOURS',
        classification: 'PAID',
      });
      await expect(
        svc.config.createType(
          {
            organizationId: fx.orgA,
            code: 'XX',
            name: 'x',
            classification: 'PAID',
          },
          ctx(fx.users.teamApprover!),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Team-scoped approvers may list the catalog; outsiders may not.
      expect(
        (
          await svc.config.listTypes(fx.users.teamApprover!, {
            organizationId: fx.orgA,
          })
        ).items,
      ).toHaveLength(1);
      await expect(
        svc.config.listTypes(fx.users.outsider!, { organizationId: fx.orgA }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await svc.config.archiveType(type.id, hr);
      await expect(
        svc.config.updateType(type.id, { name: 'x' }, hr),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        svc.config.createPolicy(
          {
            leaveTypeId: type.id,
            organizationId: fx.orgA,
            scopeType: 'ORGANIZATION',
            effectiveFrom: '2030-01-01',
          } as never,
          hr,
        ),
      ).rejects.toThrow('archived');
    });
  });

  it('rejects ambiguous policies but lets a type-specific one coexist with an all-types one', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const type = await svc.config.createType(
        {
          organizationId: fx.orgA,
          code: 'VAC',
          name: 'Vacation',
          classification: 'PAID',
        },
        hr,
      );
      const base = {
        leaveTypeId: type.id,
        organizationId: fx.orgA,
        scopeType: 'ORGANIZATION',
        effectiveFrom: '2030-01-01',
      };
      await svc.config.createPolicy(base as never, hr);
      const same = await rejection(
        svc.config.createPolicy(
          { ...base, effectiveFrom: '2030-06-01' } as never,
          hr,
        ),
      );
      expect(errorBody(same)).toMatchObject({ code: 'LEAVE_POLICY_AMBIGUOUS' });
      const partTime = await svc.config.createPolicy(
        { ...base, employmentTypes: ['PART_TIME', 'CASUAL'] } as never,
        hr,
      );
      const intersecting = await rejection(
        svc.config.createPolicy(
          { ...base, employmentTypes: ['CASUAL', 'CONTRACT'] } as never,
          hr,
        ),
      );
      expect(errorBody(intersecting)).toMatchObject({
        code: 'LEAVE_POLICY_AMBIGUOUS',
        conflictingPolicyId: partTime.id,
      });
      await svc.config.createPolicy(
        { ...base, employmentTypes: ['CONTRACT'] } as never,
        hr,
      );
      // Different scope targets never conflict.
      await svc.config.createPolicy(
        { ...base, scopeType: 'TEAM', teamId: fx.teamA } as never,
        hr,
      );
      // Settings mirror the database shape checks with readable errors.
      const invalid = await rejection(
        svc.config.createPolicy(
          {
            ...base,
            scopeType: 'TEAM',
            teamId: fx.teamA,
            effectiveFrom: '2031-01-01',
            accrualMethod: 'PERIODIC',
          } as never,
          hr,
        ),
      );
      expect(errorBody(invalid)).toMatchObject({
        code: 'LEAVE_POLICY_INVALID',
      });
      const scopeMismatch = await rejection(
        svc.config.createPolicy(
          { ...base, scopeType: 'TEAM', departmentId: fx.deptA } as never,
          hr,
        ),
      );
      expect(scopeMismatch).toBeTruthy();
      // An assignment-scoped policy needs an assignment of the same organization.
      await expect(
        svc.config.createPolicy(
          {
            ...base,
            organizationId: fx.orgB,
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignmentId: fx.assignmentTeamA,
          } as never,
          ctx(fx.users.outsider!),
        ),
      ).rejects.toThrow();
      expect(
        await violation(tx, () =>
          tx.leavePolicy.create({
            data: {
              leaveTypeId: type.id,
              organizationId: fx.orgA,
              scopeType: 'ORGANIZATION',
              effectiveFrom: new Date('2032-01-01T00:00:00Z'),
              carryoverMode: 'CAPPED',
            },
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining('carryover_shape') });
    });
  });

  it('edits only unstarted policies, ends started ones and resolves by specificity', async () => {
    await scenario(async ({ fx, svc, hr }) => {
      const type = await svc.config.createType(
        {
          organizationId: fx.orgA,
          code: 'VAC',
          name: 'Vacation',
          classification: 'PAID',
        },
        hr,
      );
      const started = await svc.config.createPolicy(
        {
          leaveTypeId: type.id,
          organizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          effectiveFrom: '2026-01-01',
          standardWorkdayMinutes: 450,
        } as never,
        hr,
      );
      const inEffect = await rejection(
        svc.config.updatePolicy(
          started.id,
          { standardWorkdayMinutes: 400 },
          hr,
        ),
      );
      expect(errorBody(inEffect)).toMatchObject({
        code: 'LEAVE_POLICY_IN_EFFECT',
      });
      await expect(
        svc.config.deletePolicy(started.id, hr),
      ).rejects.toBeInstanceOf(ConflictException);
      const ended = await svc.config.endPolicy(
        started.id,
        { effectiveTo: '2029-12-31' },
        hr,
      );
      expect(ended.effectiveTo).toBe('2029-12-31');
      await expect(
        svc.config.endPolicy(started.id, { effectiveTo: '2030-06-30' }, hr),
      ).rejects.toThrow('earlier');
      const future = await svc.config.createPolicy(
        {
          leaveTypeId: type.id,
          organizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          effectiveFrom: '2030-01-01',
          standardWorkdayMinutes: 420,
        } as never,
        hr,
      );
      const edited = await svc.config.updatePolicy(
        future.id,
        {
          standardWorkdayMinutes: 435,
          accrualMethod: 'ANNUAL_GRANT',
          annualGrantMinutes: 9600,
        },
        hr,
      );
      expect(edited).toMatchObject({
        standardWorkdayMinutes: 435,
        accrualMethod: 'ANNUAL_GRANT',
        annualGrantMinutes: 9600,
      });
      // Team A's own policy wins over the organization's for Team A assignments.
      await svc.config.createPolicy(
        {
          leaveTypeId: type.id,
          organizationId: fx.orgA,
          scopeType: 'TEAM',
          teamId: fx.teamA,
          effectiveFrom: '2026-01-01',
          standardWorkdayMinutes: 360,
        } as never,
        hr,
      );
      const resolved = (assignment: string, date: string) =>
        svc.config.resolvePolicy(fx.users.hr!, {
          employmentAssignmentId: assignment,
          leaveTypeId: type.id,
          date,
        });
      expect(
        (await resolved(fx.assignmentTeamA, '2027-03-01')).policy
          ?.standardWorkdayMinutes,
      ).toBe(360);
      expect(
        (await resolved(fx.assignmentDeptB, '2027-03-01')).policy
          ?.standardWorkdayMinutes,
      ).toBe(450);
      expect(
        (await resolved(fx.assignmentDeptB, '2030-03-01')).policy
          ?.standardWorkdayMinutes,
      ).toBe(435);
      // Effective-date boundaries are inclusive.
      expect(
        (await resolved(fx.assignmentDeptB, '2029-12-31')).policy?.id,
      ).toBe(started.id);
      expect(
        (await resolved(fx.assignmentDeptB, '2030-01-01')).policy?.id,
      ).toBe(future.id);
      await svc.config.deletePolicy(future.id, hr);
      expect(
        (await resolved(fx.assignmentDeptB, '2030-03-01')).policy,
      ).toBeNull();
      // Scope: a Dept B reader sees Dept B and organization policies but cannot manage them.
      await expect(
        svc.config.getPolicy(fx.users.outsider!, started.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      // An organization policy is invisible (404) to a Team A approver, so it cannot be ended.
      await expect(
        svc.config.endPolicy(
          started.id,
          { effectiveTo: '2029-06-30' },
          ctx(fx.users.teamApprover!),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('stores the organization timezone and refuses invalid ones', async () => {
    await scenario(async ({ tx, fx }) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: fx.orgA },
      });
      expect(org.timezone).toBe('America/Toronto');
      expect(
        await violation(tx, () =>
          tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: '  ' },
          }),
        ),
      ).toMatchObject({
        message: expect.stringContaining('timezone_not_blank'),
      });
    });
  });
});
