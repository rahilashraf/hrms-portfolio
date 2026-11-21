import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import {
  runApplyDueTerminationsJob,
  runEndDueAssignmentsJob,
} from '../src/employee/employee-jobs.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
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
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const MANAGE = ['employee.manage', 'employee.read'];
const PERMISSIONS = [
  ...MANAGE,
  'role.read',
  'role.assign',
  ...TIME_PERMISSIONS,
];
const USERS = {
  hrA: [
    {
      permissions: [...MANAGE, 'role.read', 'role.assign'],
      scope: 'org' as const,
    },
  ],
  hrB: [{ permissions: MANAGE, scope: 'orgB' as const }],
  // Manages Team A only: employee 1 also works in Dept B.
  teamAHr: [{ permissions: MANAGE, scope: 'teamA' as const }],
  timeManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  // Employee 1's own login, an organization-wide HR administrator.
  self1: [{ permissions: MANAGE, scope: 'org' as const }],
};
const TORONTO = 'America/Toronto';
const NOW = new Date('2026-11-04T17:00:00.000Z'); // Toronto 12:00, Kolkata 22:30
/**
 * Role grants start here, before NOW and every scenario date. The database default would be the
 * real time of the run, which is after NOW on any run later than NOW, so grants evaluated at NOW
 * would not yet be effective.
 */
const GRANTS_FROM = new Date('2026-01-01T00:00:00.000Z');

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();

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
  const employees = new EmployeeService(
    client,
    domain,
    access,
    authorization,
    targets,
    audit,
    lifecycle,
  );
  return { lifecycle, employees };
}

async function session(tx: Tx, userId: string) {
  return tx.authSession.create({
    data: {
      userId,
      refreshTokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

/** A SYSTEM-scope grant (global roles are reserved for the System Owner role). */
async function systemGrant(tx: Tx, userId: string, permissions: string[]) {
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
  for (const key of permissions) {
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
  return tx.roleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      scopeType: 'SYSTEM',
      startsAt: GRANTS_FROM,
    },
  });
}

async function systemUser(tx: Tx, label: string) {
  const person = await tx.person.create({ data: {} });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `b5a-${label}-${randomUUID().slice(0, 8)}@example.com`,
      status: 'ACTIVE',
    },
  });
  await systemGrant(tx, user.id, MANAGE);
  return user.id;
}

/** A new position in Org A (Dept B unless placed otherwise). */
async function newPosition(
  tx: Tx,
  fx: SchedulingFixtures,
  label: string,
  data: Record<string, string> = {},
) {
  const template = await tx.position.findUniqueOrThrow({
    where: { id: fx.positionDeptB },
  });
  return tx.position.create({
    data: {
      organizationId: fx.orgA,
      jobTitleId: template.jobTitleId,
      name: `B5A ${label}`,
      code: `B5A-${label}-${fx.suffix}`,
      departmentId: fx.deptB,
      ...data,
    },
  });
}

async function assignmentOn(
  tx: Tx,
  employeeId: string,
  positionId: string,
  data: {
    status?: 'PLANNED' | 'ACTIVE' | 'ENDED';
    startDate?: Date;
    endDate?: Date | null;
  } = {},
) {
  return tx.employmentAssignment.create({
    data: {
      employeeId,
      positionId,
      employmentType: 'PART_TIME',
      status: data.status ?? 'ACTIVE',
      startDate: data.startDate ?? d('2026-01-01'),
      endDate: data.endDate ?? null,
    },
  });
}

const audits = (tx: Tx, action: string, entityId: string) =>
  tx.auditLog.findMany({ where: { action, entityId } });

describe('Batch 5A employee lifecycle (database)', () => {
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

  it('schedules a future termination without ending anything, then applies it once its date has passed', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const hr = fx.users.hrA!;
      const login = await session(tx, fx.selfUser2);
      const result = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-11-20', reason: 'Confidential detail' },
        ctx(hr),
        NOW,
      );
      expect(result.termination).toMatchObject({
        status: 'SCHEDULED',
        terminationDate: '2026-11-20',
        reason: 'Confidential detail',
      });
      expect(result.employee).toMatchObject({
        status: 'ACTIVE',
        terminationDate: '2026-11-20',
      });
      const assignments = await tx.employmentAssignment.findMany({
        where: { employeeId: fx.employee2 },
      });
      for (const a of assignments) {
        expect(a.status).toBe('ACTIVE');
        expect(iso(a.endDate)).toBe('2026-11-20');
      }
      expect(result.termination.assignments).toHaveLength(2);
      // Access is untouched until the date has passed.
      expect(
        (await tx.authSession.findUniqueOrThrow({ where: { id: login.id } }))
          .revokedAt,
      ).toBeNull();
      // R7: the reason is not in audit metadata.
      const [scheduled] = await audits(
        tx,
        'EMPLOYEE_TERMINATION_SCHEDULED',
        fx.employee2,
      );
      expect(scheduled!.metadata).toMatchObject({ withReason: true });
      expect(JSON.stringify(scheduled!.metadata)).not.toContain('Confidential');
      // Batch 5C: the directory shows the scheduled date (never the reason).
      const { employees } = services(client);
      // Narrowed to this employee: an unfiltered directory scans every employee in the
      // database, including other test files' committed fixtures while they are being deleted.
      const { employeeNumber } = await tx.employee.findUniqueOrThrow({
        where: { id: fx.employee2 },
      });
      const listed = (
        await employees.directory({ limit: 100, search: employeeNumber }, hr)
      ).items.find((item) => item.id === fx.employee2);
      expect(listed).toMatchObject({
        status: 'ACTIVE',
        terminationDate: '2026-11-20',
      });
      expect(JSON.stringify(listed)).not.toContain('Confidential');

      // 22:00 on the last day in Toronto: nothing is due.
      const early = await rejection(
        lifecycle.applyTermination(
          fx.employee2,
          result.termination.id,
          ctx(hr),
          new Date('2026-11-21T03:00:00.000Z'),
        ),
      );
      expect(codeOf(early)).toBe('TERMINATION_NOT_DUE');

      // 01:00 the next day in Toronto: applied by hand (R1).
      const applied = await lifecycle.applyTermination(
        fx.employee2,
        result.termination.id,
        ctx(hr),
        new Date('2026-11-21T06:00:00.000Z'),
      );
      expect(applied.termination).toMatchObject({
        status: 'APPLIED',
        appliedSource: 'MANUAL',
      });
      expect(applied.employee.status).toBe('TERMINATED');
      for (const a of await tx.employmentAssignment.findMany({
        where: { employeeId: fx.employee2 },
      })) {
        expect(a.status).toBe('ENDED');
        expect(iso(a.endDate)).toBe('2026-11-20');
      }
      const revoked = await tx.authSession.findUniqueOrThrow({
        where: { id: login.id },
      });
      expect(revoked.revokedReason).toBe('employment_terminated');
      // No authorization remains for employee 2's login: disabled (R2).
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser2 } }))
          .status,
      ).toBe('DISABLED');
      // Idempotent: a second apply replays without a second audit entry.
      await lifecycle.applyTermination(
        fx.employee2,
        result.termination.id,
        ctx(hr),
        new Date('2026-11-22T06:00:00.000Z'),
      );
      expect(
        await audits(tx, 'EMPLOYEE_TERMINATED', fx.employee2),
      ).toHaveLength(1);
    });
  });

  it('applies a past termination immediately, cancels assignments that start later and keeps a login that still has grants', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const planned = await assignmentOn(
        tx,
        fx.employee1,
        (await newPosition(tx, fx, 'planned')).id,
        { status: 'PLANNED', startDate: d('2026-12-01') },
      );
      const login = await session(tx, fx.selfUser1);
      const result = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-10-31' },
        ctx(fx.users.hrA!),
        NOW,
      );
      expect(result.termination).toMatchObject({
        status: 'APPLIED',
        appliedSource: 'IMMEDIATE',
      });
      expect(result.employee.status).toBe('TERMINATED');
      const rows = await tx.employmentAssignment.findMany({
        where: { employeeId: fx.employee1 },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(fx.assignmentTeamA)).toMatchObject({ status: 'ENDED' });
      expect(iso(byId.get(fx.assignmentDeptB)!.endDate)).toBe('2026-10-31');
      expect(byId.get(planned.id)).toMatchObject({
        status: 'CANCELLED',
        endDate: null,
      });
      expect(
        result.termination.assignments.find(
          (a) => a.employmentAssignmentId === planned.id,
        ),
      ).toMatchObject({ action: 'CANCEL' });
      // Sessions end. Security remediation M3 (was R2: the login stayed while a grant remained):
      // the organization grant is revoked with the termination, and the login is disabled.
      expect(
        (await tx.authSession.findUniqueOrThrow({ where: { id: login.id } }))
          .revokedAt,
      ).not.toBeNull();
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser1 } }))
          .status,
      ).toBe('DISABLED');
      expect(
        await tx.roleAssignment.count({
          where: { userId: fx.selfUser1, revokedAt: null },
        }),
      ).toBe(0);
      expect(
        await tx.roleAssignment.count({
          where: {
            userId: fx.selfUser1,
            revocationReason: 'employment_terminated',
          },
        }),
      ).toBe(1);
    });
  });

  it('ends each assignment as its own time zone passes the date, and the employee once all have', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const kolkata = await tx.workLocation.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: 'Kolkata',
          code: `B5A-KOL-${fx.suffix}`,
          timezone: 'Asia/Kolkata',
        },
      });
      const india = await assignmentOn(
        tx,
        fx.employee1,
        (await newPosition(tx, fx, 'kol', { workLocationId: kolkata.id })).id,
      );
      const hr = fx.users.hrA!;
      const scheduled = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-11-10' },
        ctx(hr),
        NOW,
      );
      expect(scheduled.termination.status).toBe('SCHEDULED');
      // 00:30 on 11 Nov in Kolkata, 14:00 on 10 Nov in Toronto.
      const partial = new Date('2026-11-10T19:00:00.000Z');
      const due = await lifecycle.due(hr, fx.orgA, partial);
      expect(due.terminations.map((t) => t.terminationId)).toContain(
        scheduled.termination.id,
      );
      const run = await lifecycle.processDueTerminations(partial);
      expect(run.partiallyApplied).toContain(scheduled.termination.id);
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: india.id },
          })
        ).status,
      ).toBe('ENDED');
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: fx.assignmentTeamA },
          })
        ).status,
      ).toBe('ACTIVE');
      expect(
        (await tx.employee.findUniqueOrThrow({ where: { id: fx.employee1 } }))
          .status,
      ).toBe('ACTIVE');
      // Partly effective: no longer cancellable or movable.
      const cancel = await rejection(
        lifecycle.cancelTermination(
          fx.employee1,
          scheduled.termination.id,
          {},
          ctx(hr),
          partial,
        ),
      );
      expect(codeOf(cancel)).toBe('TERMINATION_ALREADY_EFFECTIVE');
      const done = await lifecycle.processDueTerminations(
        new Date('2026-11-11T06:00:00.000Z'),
      );
      expect(done.completed).toContain(scheduled.termination.id);
      expect(
        (await tx.employee.findUniqueOrThrow({ where: { id: fx.employee1 } }))
          .status,
      ).toBe('TERMINATED');
      const ended = await audits(tx, 'EMPLOYMENT_ASSIGNMENT_ENDED', india.id);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.metadata).toMatchObject({
        source: 'AUTOMATIC',
        timezone: 'Asia/Kolkata',
      });
    });
  });

  it('cancels a scheduled termination exactly, and refuses once its assignments were changed', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle, employees } = services(client);
      const hr = fx.users.hrA!;
      await tx.employmentAssignment.update({
        where: { id: fx.orgLevel },
        data: { endDate: d('2026-12-31') },
      });
      const first = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-11-20' },
        ctx(hr),
        NOW,
      );
      // While scheduled: no new assignment, no end after the date.
      const create = await rejection(
        employees.createAssignment(
          fx.employee2,
          {
            positionId: (await newPosition(tx, fx, 'blocked')).id,
            employmentType: 'PART_TIME',
            startDate: '2026-11-10',
          },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(create)).toBe('TERMINATION_SCHEDULED');
      const late = await rejection(
        employees.endAssignment(
          fx.employee2,
          fx.otherTeamA,
          { endDate: '2026-11-25' },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(late)).toBe('TERMINATION_SCHEDULED');

      const cancelled = await lifecycle.cancelTermination(
        fx.employee2,
        first.termination.id,
        { reason: 'Withdrawn' },
        ctx(hr),
        NOW,
      );
      expect(cancelled.termination.status).toBe('CANCELLED');
      expect(cancelled.employee.terminationDate).toBeNull();
      expect(
        iso(
          (
            await tx.employmentAssignment.findUniqueOrThrow({
              where: { id: fx.orgLevel },
            })
          ).endDate,
        ),
      ).toBe('2026-12-31');
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: fx.otherTeamA },
          })
        ).endDate,
      ).toBeNull();

      const second = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-11-20' },
        ctx(hr),
        NOW,
      );
      await employees.endAssignment(
        fx.employee2,
        fx.otherTeamA,
        { endDate: '2026-11-15' },
        ctx(hr),
        NOW,
      );
      const changed = await rejection(
        lifecycle.cancelTermination(
          fx.employee2,
          second.termination.id,
          {},
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(changed)).toBe('TERMINATION_ASSIGNMENT_CHANGED');
      expect(statusOf(changed)).toBe(409);
    });
  });

  it('reschedules atomically and replays a repeated request instead of recording a second termination', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const hr = fx.users.hrA!;
      const first = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-11-20' },
        ctx(hr),
        NOW,
      );
      const moved = await lifecycle.rescheduleTermination(
        fx.employee2,
        first.termination.id,
        { terminationDate: '2026-11-25' },
        ctx(hr),
        NOW,
      );
      expect(moved.termination).toMatchObject({
        status: 'SCHEDULED',
        terminationDate: '2026-11-25',
      });
      const old = await tx.employeeTermination.findUniqueOrThrow({
        where: { id: first.termination.id },
      });
      expect(old).toMatchObject({
        status: 'SUPERSEDED',
        supersededById: moved.termination.id,
      });
      // The new effects remember the original (open) end, not the first termination's.
      for (const effect of moved.termination.assignments)
        expect(effect.previousEndDate).toBeNull();
      expect(
        iso(
          (
            await tx.employmentAssignment.findUniqueOrThrow({
              where: { id: fx.otherTeamA },
            })
          ).endDate,
        ),
      ).toBe('2026-11-25');
      const replay = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-11-25' },
        ctx(hr),
        NOW,
      );
      expect(replay.termination.id).toBe(moved.termination.id);
      const other = await rejection(
        lifecycle.terminate(
          fx.employee2,
          { terminationDate: '2026-11-28' },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(other)).toBe('TERMINATION_ALREADY_SCHEDULED');
      expect(
        await tx.employeeTermination.count({
          where: { employeeId: fx.employee2 },
        }),
      ).toBe(2);
    });
  });

  it('refuses a termination or end that would leave recorded time outside the employment, writing nothing', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle, employees } = services(client);
      const hr = fx.users.hrA!;
      await tx.timeEntry.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentDeptB,
          clockInAt: new Date('2026-11-03T13:00:00.000Z'),
          timezone: TORONTO,
          workDate: d('2026-11-03'),
        },
      });
      const error = await rejection(
        lifecycle.terminate(
          fx.employee1,
          { terminationDate: '2026-11-01' },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(error)).toBe('LIFECYCLE_FINALIZED_RECORDS');
      expect(
        ((error as HttpException).getResponse() as Record<string, unknown>)
          .blockers,
      ).toEqual([
        expect.objectContaining({
          kind: 'TIME_RECORDED',
          employmentAssignmentId: fx.assignmentDeptB,
        }),
      ]);
      expect(
        await tx.employeeTermination.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(0);
      const end = await rejection(
        employees.endAssignment(
          fx.employee1,
          fx.assignmentDeptB,
          { endDate: '2026-11-01' },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(end)).toBe('LIFECYCLE_FINALIZED_RECORDS');
      // The day of the recorded time itself is fine.
      await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-11-03' },
        ctx(hr),
        NOW,
      );
    });
  });

  it('K10/K12: employee-wide authority over every affected assignment, never one’s own record', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const partial = await rejection(
        lifecycle.terminate(
          fx.employee1,
          { terminationDate: '2026-11-20' },
          ctx(fx.users.teamAHr!),
          NOW,
        ),
      );
      expect(statusOf(partial)).toBe(403);
      expect(codeOf(partial)).toBe('LIFECYCLE_SCOPE_INCOMPLETE');
      const outsider = await rejection(
        lifecycle.terminate(
          fx.employee1,
          { terminationDate: '2026-11-20' },
          ctx(fx.users.hrB!),
          NOW,
        ),
      );
      expect(statusOf(outsider)).toBe(404);
      const self = await rejection(
        lifecycle.terminate(
          fx.employee1,
          { terminationDate: '2026-11-20' },
          ctx(fx.selfUser1),
          NOW,
        ),
      );
      expect(statusOf(self)).toBe(403);
      expect(codeOf(self)).toBe('LIFECYCLE_SELF_TARGET');
      const selfInactive = await rejection(
        lifecycle.inactivate(
          fx.employee1,
          { reason: 'Leave' },
          ctx(fx.selfUser1),
        ),
      );
      expect(codeOf(selfInactive)).toBe('LIFECYCLE_SELF_TARGET');
      // A SYSTEM administrator may act beyond assignment scopes; the authority is recorded.
      const system = await systemUser(tx, 'sys');
      await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-11-20' },
        ctx(system),
        NOW,
      );
      const [audit] = await audits(
        tx,
        'EMPLOYEE_TERMINATION_SCHEDULED',
        fx.employee1,
      );
      expect(audit!.metadata).toMatchObject({ authority: 'ASSIGNMENTS' });
      expect(
        await tx.auditLog.count({
          where: {
            action: 'EMPLOYEE_TERMINATION_SCHEDULED',
            actorUserId: { in: [fx.users.teamAHr!, fx.selfUser1] },
          },
        }),
      ).toBe(0);
    });
  });

  it('R6 + M3: System-level grants need a System actor and an explicit decision each; the acknowledgement alone keeps nothing', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const grant = await systemGrant(tx, fx.selfUser2, ['employee.read']);
      const organizationActor = await violation(tx, () =>
        lifecycle.terminate(
          fx.employee2,
          { terminationDate: '2026-10-31' },
          ctx(fx.users.hrA!),
          NOW,
        ),
      );
      expect(codeOf(organizationActor)).toBe(
        'TERMINATION_SYSTEM_ACTOR_REQUIRED',
      );
      const system = await systemUser(tx, 'sys');
      // Security remediation M3: neither nothing nor the legacy acknowledgement is a decision.
      for (const input of [
        { terminationDate: '2026-10-31' },
        { terminationDate: '2026-10-31', acknowledgeSystemGrants: true },
      ]) {
        const undecided = await violation(tx, () =>
          lifecycle.terminate(fx.employee2, input, ctx(system), NOW),
        );
        expect(codeOf(undecided)).toBe('TERMINATION_GRANT_DECISION_REQUIRED');
      }
      const done = await lifecycle.terminate(
        fx.employee2,
        {
          terminationDate: '2026-10-31',
          acknowledgeSystemGrants: true,
          grantDecisions: [{ roleAssignmentId: grant.id, decision: 'REVOKE' }],
        },
        ctx(system),
        NOW,
      );
      expect(done.termination).toMatchObject({
        status: 'APPLIED',
        systemGrantsAcknowledged: true,
      });
      expect(
        await tx.roleAssignment.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ revocationReason: 'employment_terminated' });
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser2 } }))
          .status,
      ).toBe('DISABLED');
    });
  });

  it('rehires into a new assignment after the last day, keeping the hire date and history, restoring no access', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle, employees } = services(client);
      const hr = fx.users.hrA!;
      const terminated = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-10-31' },
        ctx(hr),
        NOW,
      );
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser2 } }))
          .status,
      ).toBe('DISABLED');
      const blocked = await rejection(
        employees.createAssignment(
          fx.employee2,
          {
            positionId: fx.positionOrg,
            employmentType: 'FULL_TIME',
            startDate: '2026-11-02',
          },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(blocked)).toBe('EMPLOYEE_NOT_ACTIVE');
      const missing = await rejection(
        lifecycle.rehire(fx.employee2, {} as never, ctx(hr)),
      );
      expect(codeOf(missing)).toBe('REHIRE_ASSIGNMENT_REQUIRED');
      const early = await rejection(
        lifecycle.rehire(
          fx.employee2,
          {
            assignment: {
              positionId: fx.positionOrg,
              employmentType: 'FULL_TIME',
              startDate: '2026-10-31',
            },
          },
          ctx(hr),
        ),
      );
      expect(codeOf(early)).toBe('REHIRE_BEFORE_TERMINATION');
      const rehired = await lifecycle.rehire(
        fx.employee2,
        {
          assignment: {
            positionId: fx.positionOrg,
            employmentType: 'FULL_TIME',
            startDate: '2026-11-02',
            isPrimary: true,
          },
          reason: 'Returned',
        },
        ctx(hr),
      );
      expect(rehired.employee).toMatchObject({
        status: 'ACTIVE',
        terminationDate: null,
      });
      expect(iso(rehired.employee.hireDate)).toBe('2026-01-01');
      expect(rehired.assignment).toMatchObject({
        status: 'ACTIVE',
        startDate: '2026-11-02',
      });
      expect(
        await tx.employeeTermination.findUniqueOrThrow({
          where: { id: terminated.termination.id },
        }),
      ).toMatchObject({
        status: 'APPLIED',
        rehireAssignmentId: rehired.assignment.id,
      });
      // History intact; the login is not restored automatically.
      expect(
        await tx.employmentAssignment.count({
          where: { employeeId: fx.employee2, status: 'ENDED' },
        }),
      ).toBe(2);
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser2 } }))
          .status,
      ).toBe('DISABLED');
      const notTerminated = await rejection(
        lifecycle.rehire(
          fx.employee2,
          {
            assignment: {
              positionId: (await newPosition(tx, fx, 'again')).id,
              employmentType: 'FULL_TIME',
              startDate: '2026-12-01',
            },
          },
          ctx(hr),
        ),
      );
      expect(codeOf(notTerminated)).toBe('EMPLOYEE_NOT_TERMINATED');
    });
  });

  it('K3: inactive employees take no new assignments until reactivated', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle, employees } = services(client);
      const hr = fx.users.hrA!;
      const noReason = await rejection(
        lifecycle.inactivate(fx.employee2, { reason: ' ' }, ctx(hr)),
      );
      expect(statusOf(noReason)).toBe(400);
      await lifecycle.inactivate(
        fx.employee2,
        { reason: 'Leave of absence' },
        ctx(hr),
      );
      expect(
        (await tx.employee.findUniqueOrThrow({ where: { id: fx.employee2 } }))
          .status,
      ).toBe('INACTIVE');
      const position = await newPosition(tx, fx, 'inactive');
      const blocked = await rejection(
        employees.createAssignment(
          fx.employee2,
          {
            positionId: position.id,
            employmentType: 'PART_TIME',
            startDate: '2026-12-01',
          },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(blocked)).toBe('EMPLOYEE_NOT_ACTIVE');
      // Idempotent; the assignments are untouched.
      await lifecycle.inactivate(fx.employee2, { reason: 'Again' }, ctx(hr));
      expect(
        await tx.employmentAssignment.count({
          where: { employeeId: fx.employee2, status: 'ACTIVE' },
        }),
      ).toBe(2);
      await lifecycle.reactivate(fx.employee2, {}, ctx(hr));
      await employees.createAssignment(
        fx.employee2,
        {
          positionId: position.id,
          employmentType: 'PART_TIME',
          startDate: '2026-12-01',
        },
        ctx(hr),
        NOW,
      );
      expect(
        await audits(tx, 'EMPLOYEE_INACTIVATED', fx.employee2),
      ).toHaveLength(1);
    });
  });

  it('R5 and the assignment state machine: derived status, open-only ends, compatible corrections, audited before/after', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      const hr = fx.users.hrA!;
      const position = await newPosition(tx, fx, 'derived');
      const mismatch = await rejection(
        employees.createAssignment(
          fx.employee1,
          {
            positionId: position.id,
            employmentType: 'PART_TIME',
            status: 'ACTIVE',
            startDate: '2027-01-04',
          },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(mismatch)).toBe('ASSIGNMENT_STATUS_DERIVED');
      const historical = await employees.createAssignment(
        fx.employee1,
        {
          positionId: position.id,
          employmentType: 'PART_TIME',
          startDate: '2026-02-01',
          endDate: '2026-03-01',
        },
        ctx(hr),
        NOW,
      );
      expect(historical.status).toBe('ENDED');
      const invalid = await rejection(
        employees.createAssignment(
          fx.employee1,
          {
            positionId: position.id,
            employmentType: 'PART_TIME',
            startDate: '2026-02-30',
          },
          ctx(hr),
          NOW,
        ),
      );
      expect(statusOf(invalid)).toBe(400);

      const future = await employees.endAssignment(
        fx.employee1,
        fx.assignmentDeptB,
        { endDate: '2026-12-15' },
        ctx(hr),
        NOW,
      );
      expect(future).toMatchObject({ status: 'ACTIVE' });
      const past = await employees.endAssignment(
        fx.employee1,
        fx.assignmentDeptB,
        { endDate: '2026-11-01' },
        ctx(hr),
        NOW,
      );
      expect(past).toMatchObject({ status: 'ENDED' });
      const [audit] = (
        await audits(tx, 'EMPLOYMENT_ASSIGNMENT_ENDED', fx.assignmentDeptB)
      ).slice(-1);
      expect(audit!.metadata).toMatchObject({
        after: { status: 'ENDED', endDate: '2026-11-01' },
      });
      const again = await rejection(
        employees.endAssignment(
          fx.employee1,
          fx.assignmentDeptB,
          { endDate: '2026-10-01' },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(again)).toBe('ASSIGNMENT_NOT_OPEN');
      const reopen = await rejection(
        employees.correctAssignment(
          fx.employee1,
          fx.assignmentDeptB,
          { employmentType: 'PART_TIME', startDate: '2026-01-01' },
          ctx(hr),
          NOW,
        ),
      );
      expect(codeOf(reopen)).toBe('ASSIGNMENT_STATUS_CONFLICT');
      // A correction of an ENDED assignment within its ended state is allowed.
      await employees.correctAssignment(
        fx.employee1,
        fx.assignmentDeptB,
        {
          employmentType: 'PART_TIME',
          startDate: '2026-01-01',
          endDate: '2026-10-15',
        },
        ctx(hr),
        NOW,
      );
    });
  });

  it('K5: attaching another organization’s employee needs organization-wide authority and the confirmed number', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      await tx.organization.update({
        where: { id: fx.orgB },
        data: { timezone: 'Asia/Kolkata' },
      });
      const title = await tx.jobTitle.create({
        data: {
          organizationId: fx.orgB,
          name: 'B',
          code: `B5A-JB-${fx.suffix}`,
        },
      });
      const positionB = await tx.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: title.id,
          name: 'Org B role',
          code: `B5A-PB-${fx.suffix}`,
        },
      });
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: fx.employee1 },
      });
      const input = {
        positionId: positionB.id,
        employmentType: 'PART_TIME' as const,
        startDate: '2026-12-01',
      };
      const hidden = await rejection(
        employees.createAssignment(
          fx.employee1,
          input,
          ctx(fx.users.hrB!),
          NOW,
        ),
      );
      expect(statusOf(hidden)).toBe(404);
      const wrong = await rejection(
        employees.createAssignment(
          fx.employee1,
          { ...input, attachEmployeeNumber: 'NOT-IT' },
          ctx(fx.users.hrB!),
          NOW,
        ),
      );
      expect(statusOf(wrong)).toBe(404);
      const lookupDenied = await rejection(
        employees.attachLookup(
          fx.orgB,
          employee.employeeNumber,
          ctx(fx.users.teamAHr!),
        ),
      );
      expect(statusOf(lookupDenied)).toBe(403);
      const found = await employees.attachLookup(
        fx.orgB,
        employee.employeeNumber,
        ctx(fx.users.hrB!),
      );
      expect(found).toMatchObject({ id: fx.employee1, status: 'ACTIVE' });
      expect(Object.keys(found).sort()).toEqual(
        ['displayName', 'employeeNumber', 'id', 'status'].sort(),
      );
      const attached = await employees.createAssignment(
        fx.employee1,
        { ...input, attachEmployeeNumber: employee.employeeNumber },
        ctx(fx.users.hrB!),
        NOW,
      );
      expect(attached.status).toBe('PLANNED');
      expect(await audits(tx, 'EMPLOYEE_ATTACHED', fx.employee1)).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ authority: 'ORGANIZATION' }),
        }),
      ]);
      expect(
        await tx.auditLog.count({
          where: { action: 'EMPLOYEE_ATTACH_LOOKUP', entityId: fx.orgB },
        }),
      ).toBe(1);
    });
  });

  it('K11: assignment ends wait for the switch or a person, and never pre-empt a scheduled termination', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const hr = fx.users.hrA!;
      await tx.employmentAssignment.update({
        where: { id: fx.orgLevel },
        data: { endDate: d('2026-11-01') },
      });
      const off = await runEndDueAssignmentsJob(
        {},
        { prisma: client, env: {}, now: NOW },
      );
      expect(off).toMatchObject({ disabled: true, scanned: 0 });
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: fx.orgLevel },
          })
        ).status,
      ).toBe('ACTIVE');
      const due = await lifecycle.due(hr, fx.orgA, NOW);
      expect(
        due.assignmentEnds.map((row) => row.employmentAssignmentId),
      ).toContain(fx.orgLevel);

      // Employee 1's assignments end through their scheduled termination only.
      const scheduled = await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-11-20' },
        ctx(hr),
        NOW,
      );
      const later = new Date('2026-11-21T06:00:00.000Z');
      const on = await runEndDueAssignmentsJob(
        {},
        {
          prisma: client,
          env: { EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'true' },
          now: later,
        },
      );
      expect(on.ended).toContain(fx.orgLevel);
      expect(on.ended).not.toContain(fx.assignmentTeamA);
      const manual = await rejection(
        lifecycle.applyAssignmentEnd(
          fx.employee1,
          fx.assignmentTeamA,
          ctx(hr),
          later,
        ),
      );
      expect(codeOf(manual)).toBe('ASSIGNMENT_IN_SCHEDULED_TERMINATION');
      const terminations = await runApplyDueTerminationsJob(
        {},
        {
          prisma: client,
          env: { EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'true' },
          now: later,
        },
      );
      expect(terminations.completed).toContain(scheduled.termination.id);
      const disabled = await runApplyDueTerminationsJob(
        {},
        { prisma: client, env: {}, now: later },
      );
      expect(disabled.disabled).toBe(true);
    });
  });

  it('R2/R3 + M3: the access review shows a retained grant by employment relation; explicit revocation disables a login left without authorization', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const hr = fx.users.hrA!;
      // Security remediation M3: a termination revokes the organization's grants unless a keep
      // was approved by someone else; the kept grant is an expiring replacement.
      const [grant] = await tx.roleAssignment.findMany({
        where: { userId: fx.selfUser1, revokedAt: null },
      });
      const scheduled = await lifecycle.terminate(
        fx.employee1,
        {
          terminationDate: '2026-11-20',
          grantDecisions: [
            {
              roleAssignmentId: grant!.id,
              decision: 'KEEP',
              reason: 'Handing over the open approvals',
              keepUntil: '2026-12-15T12:00:00.000Z',
            },
          ],
        },
        ctx(hr),
        NOW,
      );
      const approver = await systemUser(tx, 'approver');
      // The System Owner role also manages role assignments (the approver's authority).
      const ownerRole = await tx.role.findFirstOrThrow({
        where: { isSystemOwner: true },
      });
      const roleAssign = await tx.permission.findUniqueOrThrow({
        where: { key: 'role.assign' },
      });
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: ownerRole.id,
            permissionId: roleAssign.id,
          },
        },
        create: { roleId: ownerRole.id, permissionId: roleAssign.id },
        update: {},
      });
      const listed = await lifecycle.terminationGrants(
        fx.employee1,
        scheduled.termination.id,
        approver,
        NOW,
      );
      await lifecycle.approveGrantKeep(
        fx.employee1,
        scheduled.termination.id,
        listed.grants[0]!.decision!.id,
        {},
        ctx(approver),
        NOW,
      );
      const LATER = new Date('2026-11-23T17:00:00.000Z');
      await lifecycle.applyTermination(
        fx.employee1,
        scheduled.termination.id,
        ctx(hr),
        LATER,
      );
      const review = await lifecycle.accessReview(fx.employee1, hr, LATER);
      expect(review.access).toMatchObject({
        loginStatus: 'ACTIVE',
        hasEffectiveAuthorization: true,
        hiddenGrants: 0,
      });
      expect(review.access!.grants).toEqual([
        expect.objectContaining({
          relation: 'ENDED_EMPLOYMENT',
          revocable: true,
        }),
      ]);
      const limited = await lifecycle.accessReview(
        fx.employee1,
        fx.users.teamAHr!,
        LATER,
      );
      expect(limited.access).toMatchObject({ grants: [], hiddenGrants: 1 });
      const revoked = await lifecycle.revokeGrants(
        fx.employee1,
        {
          roleAssignmentIds: review.access!.grants.map(
            (g) => g.roleAssignmentId,
          ),
          reason: 'Employment ended',
        },
        ctx(hr),
      );
      expect(revoked.loginDisabled).toBe(true);
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser1 } }))
          .status,
      ).toBe('DISABLED');
      // Grants of another user cannot be revoked through this employee.
      const foreign = await tx.roleAssignment.findFirstOrThrow({
        where: { userId: fx.users.teamAHr! },
      });
      const notMine = await rejection(
        lifecycle.revokeGrants(
          fx.employee1,
          { roleAssignmentIds: [foreign.id] },
          ctx(hr),
        ),
      );
      expect(statusOf(notMine)).toBe(404);
    });
  });

  it('R7: termination reasons only for those who manage the employee; preview lists effects and follow-ups', async () => {
    await scenario(async ({ fx, client }) => {
      const { lifecycle } = services(client);
      const hr = fx.users.hrA!;
      const preview = await lifecycle.terminationPreview(
        fx.employee1,
        '2026-11-20',
        hr,
        NOW,
      );
      expect(preview.scheduled).toBe(true);
      expect(preview.assignments.map((a) => a.action)).toEqual(['END', 'END']);
      expect(preview.blockers).toEqual([]);
      expect(preview.access).toMatchObject({ hasEffectiveAuthorization: true });
      await lifecycle.terminate(
        fx.employee1,
        { terminationDate: '2026-11-20', reason: 'Private' },
        ctx(hr),
        NOW,
      );
      const full = await lifecycle.terminations(fx.employee1, hr);
      expect(full.items[0]).toMatchObject({ reason: 'Private' });
      const limited = await lifecycle.terminations(
        fx.employee1,
        fx.users.teamAHr!,
      );
      expect(limited.items[0]).not.toHaveProperty('reason');
      const outsider = await rejection(
        lifecycle.terminations(fx.employee1, fx.users.hrB!),
      );
      expect(statusOf(outsider)).toBe(404);
    });
  });

  it('D16: time can still be corrected on an ended assignment for the dates it covered, not after', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      await seedTimePolicy(tx, fx.orgA);
      await employees.endAssignment(
        fx.employee1,
        fx.assignmentDeptB,
        { endDate: '2026-10-31' },
        ctx(fx.users.hrA!),
        NOW,
      );
      const clock = new FixedClock();
      clock.value = NOW;
      const { time } = timeServices(client, clock);
      const manager = fx.users.timeManager!;
      const added = await time.addEntry(
        manager,
        fx.employee1,
        {
          employmentAssignmentId: fx.assignmentDeptB,
          startAt: '2026-10-20T09:00',
          endAt: '2026-10-20T10:00',
          reason: 'Missed punch before the end',
        },
        ctx(manager),
      );
      expect(added.timeEntryId).toBeTruthy();
      const after = await rejection(
        time.addEntry(
          manager,
          fx.employee1,
          {
            employmentAssignmentId: fx.assignmentDeptB,
            startAt: '2026-11-02T09:00',
            endAt: '2026-11-02T10:00',
            reason: 'After the end',
          },
          ctx(manager),
        ),
      );
      expect(after).toBeInstanceOf(HttpException);
    });
  });

  it('keeps termination history append-only in the database', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { lifecycle } = services(client);
      const done = await lifecycle.terminate(
        fx.employee2,
        { terminationDate: '2026-10-31' },
        ctx(fx.users.hrA!),
        NOW,
      );
      const id = done.termination.id;
      expect(
        String(
          await violation(tx, () =>
            tx.employeeTermination.delete({ where: { id } }),
          ),
        ),
      ).toMatch(/termination/i);
      expect(
        String(
          await violation(tx, () =>
            tx.employeeTermination.update({
              where: { id },
              data: { terminationDate: d('2026-10-30') },
            }),
          ),
        ),
      ).toMatch(/termination/i);
      expect(
        String(
          await violation(tx, () =>
            tx.employeeTerminationAssignment.create({
              data: {
                terminationId: id,
                employmentAssignmentId: fx.assignmentTeamA,
                action: 'END',
                previousStatus: 'ACTIVE',
              },
            }),
          ),
        ),
      ).toMatch(/employee/i);
      expect(
        String(
          await violation(tx, () =>
            tx.$executeRawUnsafe(
              `INSERT INTO "EmployeeTermination" ("id","employeeId","terminationDate","status","updatedAt") VALUES (gen_random_uuid(), '${fx.employee1}', DATE '2026-12-01', 'SCHEDULED', now()), (gen_random_uuid(), '${fx.employee1}', DATE '2026-12-02', 'SCHEDULED', now())`,
            ),
          ),
        ),
      ).toMatch(/unique|duplicate/i);
    });
  });
});
