import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeAssignmentOperationsService } from '../src/employee/employee-assignment-operations.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import {
  EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED,
  runApplyDueTerminationsJob,
} from '../src/employee/employee-jobs.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import {
  activeTemplate,
  FixedOnboardingClock,
  ONBOARDING_PERMISSION_KEYS,
  onboardingServices,
} from './support/onboarding-fixtures.js';
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

/**
 * Batch 5D — employee and organization lifecycle integration (database). Each scenario chains the
 * Batch 5A/5B operations across modules the way an organization uses them, on deterministic
 * dates (a fixed NOW passed to every lifecycle call, grants effective from GRANTS_FROM) and
 * inside a transaction that is rolled back.
 */

class RollbackFixtures extends Error {}

const NOW = new Date('2026-11-04T17:00:00.000Z'); // Toronto 12:00, Kolkata 22:30
const GRANTS_FROM = new Date('2026-01-01T00:00:00.000Z');
const TORONTO = 'America/Toronto';
const KOLKATA = 'Asia/Kolkata';
const MANAGE = ['employee.manage', 'employee.read'];
const ROLES = ['role.read', 'role.assign'];
const PERMISSIONS = [
  ...MANAGE,
  ...ROLES,
  ...ONBOARDING_PERMISSION_KEYS,
  'time.clock',
];
const USERS = {
  // Organization A's HR: employment, roles, onboarding and offboarding.
  hr: [
    {
      permissions: [
        ...MANAGE,
        ...ROLES,
        'onboarding.read',
        'onboarding.manage',
        'offboarding.read',
        'offboarding.manage',
      ],
      scope: 'org' as const,
    },
  ],
  // An administrator of both organizations.
  hrBoth: [
    { permissions: [...MANAGE, ...ROLES], scope: 'org' as const },
    { permissions: [...MANAGE, ...ROLES], scope: 'orgB' as const },
  ],
  hrB: [{ permissions: [...MANAGE, ...ROLES], scope: 'orgB' as const }],
  templateAdmin: [
    { permissions: ['onboarding.template.manage'], scope: 'org' as const },
  ],
  // Employee 2's own login: self-service in Organization A.
  self2: [{ permissions: ['time.clock'], scope: 'org' as const }],
};

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();
const automation = { [EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED]: 'true' };

function services(client: PrismaService) {
  const authorization = new AuthorizationService(client);
  const audit = new AuditService(client);
  const targets = new PositionAuthorizationTargetResolver(client);
  const domain = new EmployeeDomainService(client, audit);
  const access = new EmployeeAccessService(
    client,
    authorization,
    targets,
    audit,
  );
  const lifecycle = new EmployeeLifecycleService(
    client,
    domain,
    access,
    authorization,
    audit,
    new RoleManagementService(client, authorization, audit),
  );
  return {
    lifecycle,
    employees: new EmployeeService(
      client,
      domain,
      access,
      authorization,
      targets,
      audit,
      lifecycle,
    ),
    operations: new EmployeeAssignmentOperationsService(
      client,
      domain,
      access,
      lifecycle,
      authorization,
      audit,
    ),
  };
}

/** A role in an organization (or SYSTEM with `systemOwner`) granted to a user from GRANTS_FROM. */
async function grant(
  tx: Tx,
  userId: string,
  organizationId: string | null,
  keys: string[],
  options: { systemOwner?: boolean; code: string },
) {
  const role = options.systemOwner
    ? ((await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
      (await tx.role.create({
        data: {
          code: 'SYSTEM_OWNER',
          name: 'System Owner',
          isSystemOwner: true,
        },
      })))
    : await tx.role.create({
        data: { organizationId, code: options.code, name: options.code },
      });
  for (const key of keys) {
    const permission = await tx.permission.upsert({
      where: { key },
      create: { key, name: key, isActive: true },
      update: {},
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      create: { roleId: role.id, permissionId: permission.id },
      update: {},
    });
  }
  return tx.roleAssignment.create({
    data: options.systemOwner
      ? { userId, roleId: role.id, scopeType: 'SYSTEM', startsAt: GRANTS_FROM }
      : {
          userId,
          roleId: role.id,
          roleOrganizationId: organizationId,
          scopeType: 'ORGANIZATION',
          organizationId,
          startsAt: GRANTS_FROM,
        },
  });
}

async function position(
  tx: Tx,
  fx: SchedulingFixtures,
  label: string,
  organizationId = fx.orgA,
) {
  const jobTitle =
    organizationId === fx.orgA
      ? (await tx.position.findUniqueOrThrow({ where: { id: fx.positionOrg } }))
          .jobTitleId
      : (
          await tx.jobTitle.create({
            data: {
              organizationId,
              name: `5D ${label}`,
              code: `5D-JT-${label}-${fx.suffix}`,
            },
          })
        ).id;
  return tx.position.create({
    data: {
      organizationId,
      jobTitleId: jobTitle,
      name: `5D ${label}`,
      code: `5D-${label}-${fx.suffix}`,
    },
  });
}

const actions = async (tx: Tx, entityId: string) =>
  (
    await tx.auditLog.findMany({
      where: { entityId },
      select: { action: true, metadata: true },
    })
  ).map((row) => row.action);

describe('Batch 5D lifecycle integration (database)', () => {
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
      client: PrismaService;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, PERMISSIONS, {
            grantsStartAt: GRANTS_FROM,
          });
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: TORONTO },
          });
          await tx.organization.update({
            where: { id: fx.orgB },
            data: { timezone: KOLKATA },
          });
          await run({ tx, fx, client: rollbackClient(tx) }).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('journey: hire → onboarding → schedule → reschedule → cancel → schedule → offboarding → automatic apply → access review → revoke → rehire', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle, employees, operations } = services(client);
      const clock = new FixedOnboardingClock();
      clock.value = NOW;
      const onboarding = onboardingServices(client, clock);
      const hr = ctx(fx.users.hr!);

      // Hire with an initial primary assignment, and a second one planned for December.
      const hired = await employees.create(
        {
          person: {
            firstName: 'Riley',
            lastName: `Journey${fx.suffix}`,
            personalEmail: `riley-${fx.suffix.toLowerCase()}@example.com`,
          },
          hireDate: '2026-01-05',
          initialPositionId: (await position(tx, fx, 'hire')).id,
          initialEmploymentType: 'FULL_TIME',
          initialStartDate: '2026-01-05',
          initialPrimary: true,
        },
        hr,
      );
      const employeeId = hired.id;
      const primary = await tx.employmentAssignment.findFirstOrThrow({
        where: { employeeId },
      });
      expect(primary).toMatchObject({ status: 'ACTIVE', isPrimary: true });
      const december = await employees.createAssignment(
        employeeId,
        {
          positionId: (await position(tx, fx, 'dec')).id,
          employmentType: 'PART_TIME',
          startDate: '2026-12-01',
        },
        hr,
        NOW,
      );
      expect(december.status).toBe('PLANNED');

      // The employee's login with a self-service grant and a live session.
      const person = await tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
      });
      const user = await tx.user.create({
        data: {
          personId: person.personId,
          email: `riley-login-${fx.suffix.toLowerCase()}@example.com`,
          status: 'ACTIVE',
        },
      });
      const selfGrant = await grant(tx, user.id, fx.orgA, ['time.clock'], {
        code: `5D-SELF-${fx.suffix}`,
      });
      const session = await tx.authSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: `5d-${fx.suffix}`,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      });

      // Onboarding runs on Core HR's assignment and changes nothing there.
      await activeTemplate(onboarding, fx, {
        code: 'journey-on',
        tasks: [
          {
            title: 'Welcome meeting',
            category: 'MEETING',
            ownerType: 'HR',
            dueOffsetDays: 0,
          },
        ] as never,
      });
      const onboarded = await onboarding.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: primary.id },
        hr,
      );
      await onboarding.tasks.complete(
        onboarded.tasks[0]!.id,
        { note: 'Done' },
        hr,
      );
      // The last required task completes the workflow.
      expect(
        (await onboarding.workflows.detail(fx.users.hr!, onboarded.id)).status,
      ).toBe('COMPLETED');

      // Schedule, reschedule later, cancel: each restores the assignments exactly.
      const first = await lifecycle.terminate(
        employeeId,
        { terminationDate: '2026-11-20', reason: 'Moving away' },
        hr,
        NOW,
      );
      expect(first.termination.status).toBe('SCHEDULED');
      const moved = await lifecycle.rescheduleTermination(
        employeeId,
        first.termination.id,
        { terminationDate: '2026-11-27' },
        hr,
        NOW,
      );
      expect(
        iso(
          (
            await tx.employmentAssignment.findUniqueOrThrow({
              where: { id: primary.id },
            })
          ).endDate,
        ),
      ).toBe('2026-11-27');
      await lifecycle.cancelTermination(
        employeeId,
        moved.termination.id,
        {},
        hr,
        NOW,
      );
      for (const id of [primary.id, december.id]) {
        expect(
          await tx.employmentAssignment.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          endDate: null,
        });
      }
      expect(
        await tx.employee.findUniqueOrThrow({ where: { id: employeeId } }),
      ).toMatchObject({
        status: 'ACTIVE',
        terminationDate: null,
      });

      // Scheduled again; offboarding is prepared from the impact preview's prefill.
      const final = await lifecycle.terminate(
        employeeId,
        { terminationDate: '2026-11-20', reason: 'Moving away' },
        hr,
        NOW,
      );
      await activeTemplate(onboarding, fx, {
        kind: 'OFFBOARDING',
        code: 'journey-off',
        tasks: [
          {
            title: 'Exit interview',
            category: 'MEETING',
            ownerType: 'HR',
            dueOffsetDays: 0,
          },
        ] as never,
      });
      const before = await operations.impact(
        employeeId,
        primary.id,
        fx.users.hr!,
        {
          endDate: '2026-11-20',
        },
      );
      expect(before.offboarding).toMatchObject({
        employmentAssignmentId: primary.id,
        plannedEndDate: '2026-11-20',
        openWorkflowId: null,
        defaultTemplate: expect.objectContaining({ name: 'Staff offboarding' }),
      });
      const offboarding = await onboarding.workflows.start(
        'OFFBOARDING',
        {
          employmentAssignmentId: before.offboarding!.employmentAssignmentId,
          plannedEndDate: before.offboarding!.plannedEndDate,
          templateId: before.offboarding!.defaultTemplate!.id,
        },
        hr,
      );
      expect(
        (
          await operations.impact(employeeId, primary.id, fx.users.hr!, {
            endDate: '2026-11-20',
          })
        ).offboarding?.openWorkflowId,
      ).toBe(offboarding.id);

      // The worker applies it once due (automation switched on for this run only).
      const notDue = await runApplyDueTerminationsJob(
        {},
        {
          prisma: client,
          env: automation,
          now: new Date('2026-11-21T03:00:00.000Z'),
        },
      );
      expect(notDue.completed).not.toContain(final.termination.id);
      const applied = await runApplyDueTerminationsJob(
        {},
        {
          prisma: client,
          env: automation,
          now: new Date('2026-11-21T06:00:00.000Z'),
        },
      );
      expect(applied.completed).toContain(final.termination.id);
      expect(
        await tx.employee.findUniqueOrThrow({ where: { id: employeeId } }),
      ).toMatchObject({
        status: 'TERMINATED',
      });
      expect(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: primary.id },
        }),
      ).toMatchObject({
        status: 'ENDED',
      });
      expect(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: december.id },
        }),
      ).toMatchObject({ status: 'CANCELLED' });
      // Sessions end with the employment. Security remediation M3 (was R2: the login stayed while
      // a grant remained): the worker revoked the organization grant and disabled the login.
      expect(
        (await tx.authSession.findUniqueOrThrow({ where: { id: session.id } }))
          .revokedAt,
      ).not.toBeNull();
      expect(
        await tx.roleAssignment.findUniqueOrThrow({
          where: { id: selfGrant.id },
        }),
      ).toMatchObject({
        revokedByUserId: null,
        revocationReason: 'employment_terminated',
      });
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).status,
      ).toBe('DISABLED');
      // Offboarding is never completed by Core HR; HR completes it, employment unchanged.
      const open = await onboarding.workflows.detail(
        fx.users.hr!,
        offboarding.id,
      );
      expect(open.status).toBe('ACTIVE');
      await onboarding.tasks.complete(
        offboarding.tasks[0]!.id,
        { note: 'Held' },
        hr,
      );
      expect(
        (await onboarding.workflows.detail(fx.users.hr!, offboarding.id))
          .status,
      ).toBe('COMPLETED');

      // Access review: nothing left to revoke by hand (M3 revoked it at the termination).
      const review = await lifecycle.accessReview(
        employeeId,
        fx.users.hr!,
        NOW,
      );
      expect(review.access).toMatchObject({
        grants: [],
        loginStatus: 'DISABLED',
        hasEffectiveAuthorization: false,
      });

      // Rehire: a new assignment, the history kept, access not restored.
      const rehired = await lifecycle.rehire(
        employeeId,
        {
          assignment: {
            positionId: (await position(tx, fx, 'back')).id,
            employmentType: 'FULL_TIME',
            startDate: '2026-12-07',
            isPrimary: true,
          },
        },
        hr,
      );
      expect(rehired.employee).toMatchObject({
        status: 'ACTIVE',
        terminationDate: null,
      });
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).status,
      ).toBe('DISABLED');
      const history = await lifecycle.terminations(employeeId, fx.users.hr!);
      expect(history.items.map((t) => t.status)).toEqual([
        'APPLIED',
        'CANCELLED',
        'SUPERSEDED',
      ]);
      expect(history.items[0]).toMatchObject({
        reason: 'Moving away',
        appliedSource: 'AUTOMATIC',
        rehireAssignmentId: rehired.assignment.id,
      });

      // One audit trail (rows of one transaction share their timestamp: compared as a multiset),
      // never carrying the reason.
      const trail = await actions(tx, employeeId);
      const lifecycleTrail = trail.filter((a) => a.startsWith('EMPLOYEE_'));
      expect([...lifecycleTrail].sort()).toEqual(
        [
          'EMPLOYEE_CREATED',
          'EMPLOYEE_TERMINATION_SCHEDULED',
          'EMPLOYEE_TERMINATION_RESCHEDULED',
          'EMPLOYEE_TERMINATION_CANCELLED',
          'EMPLOYEE_TERMINATION_SCHEDULED',
          'EMPLOYEE_TERMINATED',
          'EMPLOYEE_REHIRED',
          // The termination's revocation left no authorization: the login was disabled.
          'EMPLOYEE_ACCOUNT_DISABLED',
        ].sort(),
      );
      const everything = await tx.auditLog.findMany({
        where: { OR: [{ entityId: employeeId }, { entityId: selfGrant.id }] },
      });
      expect(
        everything.some((row) => row.action === 'ROLE_ASSIGNMENT_REVOKED'),
      ).toBe(true);
      expect(
        JSON.stringify(everything.map((row) => row.metadata)),
      ).not.toContain('Moving away');
    });
  });

  it('Toronto/Kolkata: one employee in two organizations ends assignment by assignment, with authority over both', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const kolkataPosition = await position(tx, fx, 'mum', fx.orgB);
      const kolkata = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: kolkataPosition.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          startDate: d('2026-01-01'),
        },
      });
      const orgBGrant = await grant(tx, fx.selfUser2, fx.orgB, ['time.clock'], {
        code: `5D-B-${fx.suffix}`,
      });
      const session = await tx.authSession.create({
        data: {
          userId: fx.selfUser2,
          refreshTokenHash: `5d-k-${fx.suffix}`,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      });
      // 20:00 UTC on Nov 4: 15:00 in Toronto, 01:30 on Nov 5 in Kolkata.
      const evening = new Date('2026-11-04T20:00:00.000Z');

      // Organization A's HR does not cover the Kolkata assignment: refused, nothing written.
      const partial = await violation(tx, () =>
        lifecycle.terminate(
          fx.employee2,
          { terminationDate: '2026-11-04' },
          ctx(fx.users.hr!),
          evening,
        ),
      );
      expect(statusOf(partial)).toBe(403);
      expect(codeOf(partial)).toBe('LIFECYCLE_SCOPE_INCOMPLETE');
      expect(
        await tx.employeeTermination.count({
          where: { employeeId: fx.employee2 },
        }),
      ).toBe(0);

      const both = ctx(fx.users.hrBoth!);
      const preview = await lifecycle.terminationPreview(
        fx.employee2,
        '2026-11-04',
        fx.users.hrBoth!,
        evening,
      );
      expect(preview.scheduled).toBe(true);
      expect(
        Object.fromEntries(
          preview.assignments.map((a) => [a.timezone, a.action]),
        ),
      ).toEqual({ [TORONTO]: 'END', [KOLKATA]: 'END' });

      const recorded = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-11-04' },
        both,
        evening,
      );
      // The last day has passed in Kolkata only: that assignment ends now, Toronto's does not.
      expect(recorded.termination.status).toBe('SCHEDULED');
      expect(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: kolkata.id },
        }),
      ).toMatchObject({
        status: 'ENDED',
      });
      expect(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: fx.otherTeamA },
        }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(
        await tx.employee.findUniqueOrThrow({ where: { id: fx.employee2 } }),
      ).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        (await tx.authSession.findUniqueOrThrow({ where: { id: session.id } }))
          .revokedAt,
      ).toBeNull();
      // Cancelling is refused once part of it has taken effect.
      const late = await violation(tx, () =>
        lifecycle.cancelTermination(
          fx.employee2,
          recorded.termination.id,
          {},
          both,
          evening,
        ),
      );
      expect(codeOf(late)).toBe('TERMINATION_ALREADY_EFFECTIVE');

      // Each organization's administrator sees only their organization's grant.
      const all = await lifecycle.accessReview(
        fx.employee2,
        fx.users.hrBoth!,
        evening,
      );
      expect(
        Object.fromEntries(
          all.access!.grants.map((g) => [g.organizationId, g.relation]),
        ),
      ).toEqual({
        [fx.orgA]: 'CURRENT_EMPLOYMENT',
        [fx.orgB]: 'ENDED_EMPLOYMENT',
      });
      const onlyB = await lifecycle.accessReview(
        fx.employee2,
        fx.users.hrB!,
        evening,
      );
      expect(onlyB.access!.grants.map((g) => g.roleAssignmentId)).toEqual([
        orgBGrant.id,
      ]);
      expect(onlyB.access!.hiddenGrants).toBe(1);

      // 01:00 on Nov 5 in Toronto: the rest applies and the employee is terminated.
      const done = await lifecycle.applyTermination(
        fx.employee2,
        recorded.termination.id,
        both,
        new Date('2026-11-05T06:00:00.000Z'),
      );
      expect(done.termination.status).toBe('APPLIED');
      expect(done.employee.status).toBe('TERMINATED');
      expect(
        (await tx.authSession.findUniqueOrThrow({ where: { id: session.id } }))
          .revokedAt,
      ).not.toBeNull();
      const effects = await tx.employeeTerminationAssignment.findMany({
        where: { terminationId: recorded.termination.id },
      });
      expect(effects.map((e) => e.employmentAssignmentId)).toEqual(
        expect.arrayContaining([kolkata.id, fx.otherTeamA]),
      );
      expect(effects.every((e) => e.appliedAt !== null)).toBe(true);
    });
  });

  it('revoking grants checks every grant before revocation begins: a grant the caller may not revoke leaves every grant in place', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const hr = ctx(fx.users.hr!);
      const own = await tx.roleAssignment.findFirstOrThrow({
        where: { userId: fx.selfUser2, revokedAt: null },
      });
      const elsewhere = await grant(tx, fx.selfUser2, fx.orgB, ['time.clock'], {
        code: `5D-X-${fx.suffix}`,
      });
      const owner = await grant(tx, fx.selfUser2, null, ['employee.read'], {
        systemOwner: true,
        code: 'unused',
      });
      const stillActive = async () =>
        (
          await tx.roleAssignment.findMany({
            where: {
              id: { in: [own.id, elsewhere.id, owner.id] },
              revokedAt: null,
            },
          })
        ).length;

      // Outside Organization A: the caller cannot see it (404) — and nothing was revoked.
      const hidden = await rejection(
        lifecycle.revokeGrants(
          fx.employee2,
          { roleAssignmentIds: [own.id, elsewhere.id] },
          hr,
        ),
      );
      expect(statusOf(hidden)).toBe(404);
      expect(await stillActive()).toBe(3);
      // A System Owner assignment is never revoked here (403) — and nothing was revoked.
      const system = await rejection(
        lifecycle.revokeGrants(
          fx.employee2,
          { roleAssignmentIds: [own.id, owner.id] },
          hr,
        ),
      );
      expect(statusOf(system)).toBe(403);
      expect(await stillActive()).toBe(3);
      expect(
        await tx.auditLog.count({
          where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: own.id },
        }),
      ).toBe(0);
      // The revocable grant alone is revoked, once, audited.
      const ok = await lifecycle.revokeGrants(
        fx.employee2,
        { roleAssignmentIds: [own.id] },
        hr,
      );
      expect(ok.revoked).toEqual([own.id]);
      expect(await stillActive()).toBe(2);
      expect(
        await tx.auditLog.count({
          where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: own.id },
        }),
      ).toBe(1);
    });
  });

  it('a termination leaves schedules, leave, benefits and compensation to their modules: counted in the preview, untouched when applied', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const hr = ctx(fx.users.hr!);
      const creator = fx.users.hr!;
      // Two published shifts after the last day on the Team A assignment.
      const schedule = await tx.schedule.create({
        data: {
          scopeType: 'TEAM',
          organizationId: fx.orgA,
          teamId: fx.teamA,
          name: 'Late November',
          periodStart: d('2026-11-23'),
          periodEnd: d('2026-11-29'),
          type: 'STANDARD',
          status: 'PUBLISHED',
          publishedAt: new Date('2026-11-01T12:00:00.000Z'),
          publishedByUserId: creator,
        },
      });
      for (const day of ['2026-11-23', '2026-11-24']) {
        await tx.scheduledShift.create({
          data: {
            scheduleId: schedule.id,
            employmentAssignmentId: fx.assignmentTeamA,
            workDate: d(day),
            startsAt: new Date(`${day}T14:00:00.000Z`),
            endsAt: new Date(`${day}T22:00:00.000Z`),
            timezone: TORONTO,
          },
        });
      }
      // A pending leave request and approved leave after the last day.
      const leaveType = await tx.leaveType.create({
        data: {
          organizationId: fx.orgA,
          code: `VAC-${fx.suffix}`,
          name: 'Vacation',
          classification: 'PAID',
        },
      });
      const account = await tx.leaveAccount.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          leaveTypeId: leaveType.id,
        },
      });
      const leave = (
        status: 'PENDING' | 'APPROVED',
        start: string,
        end: string,
      ) =>
        tx.leaveRequest.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            leaveTypeId: leaveType.id,
            accountId: account.id,
            status,
            startDate: d(start),
            endDate: d(end),
            timezone: TORONTO,
            requestedMinutes: 480,
            requestedByUserId: creator,
            ...(status === 'APPROVED'
              ? {
                  approvedMinutes: 480,
                  decidedByUserId: creator,
                  decidedAt: NOW,
                }
              : {}),
          },
        });
      await leave('PENDING', '2026-11-18', '2026-11-18');
      await leave('APPROVED', '2026-11-26', '2026-11-26');
      // An open benefit enrollment and open compensation.
      const plan = await tx.benefitPlan.create({
        data: {
          organizationId: fx.orgA,
          code: `HEALTH-${fx.suffix}`,
          name: 'Health',
          benefitType: 'HEALTH',
          currency: 'CAD',
          status: 'ACTIVE',
          effectiveFrom: d('2026-01-01'),
        },
      });
      const option = await tx.benefitCoverageOption.create({
        data: {
          planId: plan.id,
          code: 'EE',
          name: 'Employee only',
          coverageLevel: 'EMPLOYEE_ONLY',
        },
      });
      const enrollment = await tx.benefitEnrollment.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          planId: plan.id,
          optionId: option.id,
          electionType: 'ENROLLED',
          recordType: 'INITIAL',
          coverageStart: d('2026-01-01'),
          electedOn: d('2025-12-15'),
        },
      });
      const compensation = await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentDeptB,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '30',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
        },
      });
      const snapshot = async () => ({
        shifts: await tx.scheduledShift.findMany({
          where: { employmentAssignmentId: fx.assignmentTeamA },
          select: { id: true, status: true, workDate: true },
          orderBy: { workDate: 'asc' },
        }),
        leave: await tx.leaveRequest.findMany({
          where: { employeeId: fx.employee1 },
          select: { id: true, status: true },
          orderBy: { startDate: 'asc' },
        }),
        enrollment: await tx.benefitEnrollment.findUniqueOrThrow({
          where: { id: enrollment.id },
          select: { coverageEnd: true, electionType: true },
        }),
        compensation: await tx.compensationRecord.findUniqueOrThrow({
          where: { id: compensation.id },
          select: { effectiveTo: true, supersededAt: true },
        }),
      });
      const before = await snapshot();

      const preview = await lifecycle.terminationPreview(
        fx.employee1,
        '2026-11-20',
        creator,
        NOW,
      );
      expect(preview.followUps).toMatchObject({
        futurePublishedShifts: 2,
        pendingLeaveRequests: 1,
        approvedLeaveAfterTermination: 1,
        // Batch 7C (B15): Core HR authority never implies benefits access — the count is
        // only for benefit.read holders (batch-7c-security covers one who has it).
        openBenefitEnrollments: null,
      });
      const recorded = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-11-20' },
        hr,
        NOW,
      );
      await lifecycle.applyTermination(
        fx.employee1,
        recorded.termination.id,
        hr,
        new Date('2026-11-21T06:00:00.000Z'),
      );
      expect(
        await tx.employee.findUniqueOrThrow({ where: { id: fx.employee1 } }),
      ).toMatchObject({
        status: 'TERMINATED',
      });
      // Nothing in the other modules changed automatically.
      expect(await snapshot()).toEqual(before);
    });
  });

  it('a termination that would cancel a planned assignment holding compensation is refused before anything is written', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle, employees } = services(client);
      const hr = ctx(fx.users.hr!);
      const planned = await employees.createAssignment(
        fx.employee2,
        {
          positionId: (await position(tx, fx, 'jan')).id,
          employmentType: 'PART_TIME',
          startDate: '2027-01-04',
        },
        hr,
        NOW,
      );
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: planned.id,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '25',
          currency: 'CAD',
          effectiveFrom: d('2027-01-04'),
        },
      });
      const refused = await violation(tx, () =>
        lifecycle.terminate(
          fx.employee2,
          { terminationDate: '2026-12-31' },
          hr,
          NOW,
        ),
      );
      expect(statusOf(refused)).toBe(409);
      expect(codeOf(refused)).toBe('COMPENSATION_OUTSIDE_ASSIGNMENT');
      expect(
        await tx.employeeTermination.count({
          where: { employeeId: fx.employee2 },
        }),
      ).toBe(0);
      for (const a of await tx.employmentAssignment.findMany({
        where: { employeeId: fx.employee2 },
      })) {
        expect(a.endDate === null || iso(a.endDate) !== '2026-12-31').toBe(
          true,
        );
      }
      expect(
        await tx.employee.findUniqueOrThrow({ where: { id: fx.employee2 } }),
      ).toMatchObject({
        status: 'ACTIVE',
        terminationDate: null,
      });
    });
  });

  it('finalized payroll: a reschedule into a finalized period is refused and the scheduled termination stays exactly as it was', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const hr = ctx(fx.users.hr!);
      const scheduled = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-11-27' },
        hr,
        NOW,
      );
      const endDates = async () =>
        (
          await tx.employmentAssignment.findMany({
            where: { employeeId: fx.employee1 },
            orderBy: { id: 'asc' },
          })
        ).map((a) => [a.id, a.status, iso(a.endDate)]);
      const before = await endDates();

      // A finalized payroll run for 9–22 November that includes the employee.
      const payGroup = await tx.payGroup.create({
        data: { organizationId: fx.orgA, code: `PG-${fx.suffix}`, name: 'PG' },
      });
      const calendar = await tx.payrollCalendar.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          cadence: 'BIWEEKLY',
          timezone: TORONTO,
          anchorDate: d('2026-11-09'),
          payDateOffsetDays: 6,
          processingCutoffOffsetDays: 3,
          effectiveFrom: d('2026-11-09'),
        },
      });
      const timePeriod = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: d('2026-11-09'),
          endDate: d('2026-11-22'),
          status: 'OPEN',
          openedAt: NOW,
        },
      });
      const period = await tx.payrollPeriod.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          payrollCalendarId: calendar.id,
          periodStart: d('2026-11-09'),
          periodEnd: d('2026-11-22'),
          payDate: d('2026-11-28'),
          processingCutoffAt: new Date('2026-11-25T22:00:00.000Z'),
          timezone: TORONTO,
          timePeriodId: timePeriod.id,
        },
      });
      const run = await tx.payrollRun.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          payrollPeriodId: period.id,
          currency: 'CAD',
          createdByUserId: fx.users.hr!,
        },
      });
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: fx.employee1 },
      });
      await tx.payrollRunEmployee.create({
        data: {
          payrollRunId: run.id,
          employeeId: fx.employee1,
          employeeNumber: employee.employeeNumber,
          displayName: 'Employee 1',
        },
      });
      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'FINALIZED',
          calculatedAt: NOW,
          calculationVersion: 'v1',
          sourceFingerprint: 'sha256:5d',
          approvedAt: NOW,
          approvedByUserId: fx.selfUser1,
          finalizedAt: NOW,
          finalizedByUserId: fx.selfUser2,
          grossAmount: '0.00',
          deductionAmount: '0.00',
          employerContributionAmount: '0.00',
        },
      });

      // Each refused request runs in a savepoint, as its own transaction would roll back.
      const refused = await violation(tx, () =>
        lifecycle.rescheduleTermination(
          fx.employee1,
          scheduled.termination.id,
          { terminationDate: '2026-11-15' },
          hr,
          NOW,
        ),
      );
      expect(codeOf(refused)).toBe('LIFECYCLE_FINALIZED_RECORDS');
      // Nothing moved: still the one scheduled termination on Nov 27, the same end dates.
      expect(
        (
          await tx.employeeTermination.findMany({
            where: { employeeId: fx.employee1 },
          })
        ).map((t) => [t.id, t.status, iso(t.terminationDate)]),
      ).toEqual([[scheduled.termination.id, 'SCHEDULED', '2026-11-27']]);
      expect(await endDates()).toEqual(before);
      // A later reschedule and a cancellation are not blocked by the finalized period.
      const later = await lifecycle.rescheduleTermination(
        fx.employee1,
        scheduled.termination.id,
        { terminationDate: '2026-12-04' },
        hr,
        NOW,
      );
      await lifecycle.cancelTermination(
        fx.employee1,
        later.termination.id,
        {},
        hr,
        NOW,
      );
      expect(
        (
          await tx.employmentAssignment.findMany({
            where: { employeeId: fx.employee1 },
          })
        ).every((a) => a.endDate === null),
      ).toBe(true);
      // The finalized run is untouched.
      expect(
        await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } }),
      ).toMatchObject({
        status: 'FINALIZED',
      });
      expect(
        await tx.payrollRunEmployee.count({ where: { payrollRunId: run.id } }),
      ).toBe(1);
    });
  });
});
