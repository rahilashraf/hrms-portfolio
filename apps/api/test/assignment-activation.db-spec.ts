import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { localDateOf } from '../src/common/domain-support.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import {
  activateDueAssignments,
  runActivateDueAssignmentsJob,
} from '../src/employee/employee-jobs.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
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

const PERMISSIONS = ['employee.manage', 'employee.read', ...TIME_PERMISSIONS];
const USERS = {
  hrA: [
    {
      permissions: ['employee.manage', 'employee.read'],
      scope: 'org' as const,
    },
  ],
  hrB: [
    {
      permissions: ['employee.manage', 'employee.read'],
      scope: 'orgB' as const,
    },
  ],
  // Manages Team A only; Dept B and organization-level positions are out of scope.
  teamAHr: [
    {
      permissions: ['employee.manage', 'employee.read'],
      scope: 'teamA' as const,
    },
  ],
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
};
const TIMEZONE = 'America/Toronto';

const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();

/** A date-only value `days` from the business date of `now` in Toronto. */
const businessDay = (days: number, now = new Date()) => {
  const today = localDateOf(now, TIMEZONE);
  return new Date(today.getTime() + days * 86_400_000);
};
const iso = (value: Date) => value.toISOString().slice(0, 10);

function services(client: PrismaService) {
  const authorization = new AuthorizationService(client);
  const audit = new AuditService(client);
  const targets = new PositionAuthorizationTargetResolver(client);
  const domain = new EmployeeDomainService(client, audit);
  return {
    domain,
    employees: new EmployeeService(
      client,
      domain,
      new EmployeeAccessService(client, authorization, targets),
      authorization,
      targets,
      audit,
      new EmployeeLifecycleService(
        client,
        domain,
        new EmployeeAccessService(client, authorization, targets, audit),
        authorization,
        audit,
      ),
    ),
  };
}

/** A PLANNED assignment of employee 1 on its own new position (as left by an earlier hire). */
async function plannedAssignment(
  tx: Tx,
  fx: SchedulingFixtures,
  label: string,
  dates: { startDate: Date; endDate?: Date | null },
  position: {
    teamId?: string;
    departmentId?: string;
    workLocationId?: string;
  } = {
    departmentId: fx.deptB,
  },
  extra: { isPrimary?: boolean; managerAssignmentId?: string | null } = {},
) {
  const template = await tx.position.findUniqueOrThrow({
    where: { id: fx.positionDeptB },
  });
  const created = await tx.position.create({
    data: {
      organizationId: fx.orgA,
      jobTitleId: template.jobTitleId,
      name: `Planned ${label}`,
      code: `PL-${label}-${fx.suffix}`,
      ...position,
    },
  });
  return tx.employmentAssignment.create({
    data: {
      employeeId: fx.employee1,
      positionId: created.id,
      employmentType: 'PART_TIME',
      status: 'PLANNED',
      startDate: dates.startDate,
      endDate: dates.endDate ?? null,
      isPrimary: extra.isPrimary ?? false,
      managerAssignmentId: extra.managerAssignmentId ?? null,
    },
  });
}

const activationAudits = (tx: Tx | PrismaService, assignmentId: string) =>
  tx.auditLog.findMany({
    where: {
      action: 'EMPLOYMENT_ASSIGNMENT_ACTIVATED',
      entityId: assignmentId,
    },
  });

describe('Employment assignment activation (database)', () => {
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
          const fx = await createSchedulingFixtures(tx, USERS, PERMISSIONS);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: TIMEZONE },
          });
          await run({ tx, fx, client: rollbackClient(tx) }).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('activates a due planned assignment in place, preserving it, its compensation and history, audited once', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      const planned = await plannedAssignment(
        tx,
        fx,
        'due',
        { startDate: businessDay(-36), endDate: businessDay(200) },
        { departmentId: fx.deptB },
        { managerAssignmentId: fx.otherTeamA },
      );
      const compensation = await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: planned.id,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '25',
          currency: 'CAD',
          effectiveFrom: planned.startDate,
        },
      });

      const result = await employees.activateAssignment(
        fx.employee1,
        planned.id,
        ctx(fx.users.hrA!),
      );
      expect(result).toMatchObject({
        outcome: 'ACTIVATED',
        timezone: TIMEZONE,
        activatedOn: iso(businessDay(0)),
        assignment: {
          id: planned.id,
          status: 'ACTIVE',
          startDate: iso(planned.startDate),
          endDate: iso(planned.endDate!),
        },
      });
      // Same row: only the status changed.
      const after = await tx.employmentAssignment.findUniqueOrThrow({
        where: { id: planned.id },
      });
      const { status: _before, updatedAt: _u1, ...unchangedBefore } = planned;
      const { status, updatedAt: _u2, ...unchangedAfter } = after;
      expect(status).toBe('ACTIVE');
      expect(unchangedAfter).toEqual(unchangedBefore);
      expect(
        await tx.employmentAssignment.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(3); // the two fixture assignments + this one: nothing duplicated
      expect(
        await tx.compensationRecord.findUniqueOrThrow({
          where: { id: compensation.id },
        }),
      ).toEqual(compensation);

      const audits = await activationAudits(tx, planned.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: fx.users.hrA,
        entityType: 'EmploymentAssignment',
      });
      expect(audits[0]!.metadata).toMatchObject({
        source: 'MANUAL',
        employeeId: fx.employee1,
        organizationId: fx.orgA,
        before: { status: 'PLANNED' },
        after: { status: 'ACTIVE' },
        timezone: TIMEZONE,
      });

      // Repeating is safe: no change, no second audit entry.
      expect(
        await employees.activateAssignment(
          fx.employee1,
          planned.id,
          ctx(fx.users.hrA!),
        ),
      ).toMatchObject({
        outcome: 'ALREADY_ACTIVE',
        assignment: { status: 'ACTIVE' },
      });
      expect(await activationAudits(tx, planned.id)).toHaveLength(1);
    });
  });

  it('refuses future, expired, ended, cancelled and inactive-employee activations, leaving them unchanged', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      const activate = (id: string) =>
        rejection(
          employees.activateAssignment(fx.employee1, id, ctx(fx.users.hrA!)),
        );

      const future = await plannedAssignment(tx, fx, 'future', {
        startDate: businessDay(10),
      });
      expect(codeOf(await activate(future.id))).toBe(
        'EMPLOYMENT_ASSIGNMENT_NOT_STARTED',
      );
      const expired = await plannedAssignment(tx, fx, 'expired', {
        startDate: businessDay(-60),
        endDate: businessDay(-5),
      });
      expect(codeOf(await activate(expired.id))).toBe(
        'EMPLOYMENT_ASSIGNMENT_EXPIRED',
      );
      const ended = await plannedAssignment(tx, fx, 'ended', {
        startDate: businessDay(-60),
        endDate: businessDay(-30),
      });
      await tx.employmentAssignment.update({
        where: { id: ended.id },
        data: { status: 'ENDED' },
      });
      expect(codeOf(await activate(ended.id))).toBe(
        'EMPLOYMENT_ASSIGNMENT_NOT_PLANNED',
      );
      const cancelled = await plannedAssignment(tx, fx, 'cancelled', {
        startDate: businessDay(-10),
      });
      await tx.employmentAssignment.update({
        where: { id: cancelled.id },
        data: { status: 'CANCELLED' },
      });
      expect(codeOf(await activate(cancelled.id))).toBe(
        'EMPLOYMENT_ASSIGNMENT_NOT_PLANNED',
      );

      // An existing ACTIVE assignment is untouched (no update, no audit).
      const activeBefore = await tx.employmentAssignment.findUniqueOrThrow({
        where: { id: fx.assignmentTeamA },
      });
      expect(
        await employees.activateAssignment(
          fx.employee1,
          fx.assignmentTeamA,
          ctx(fx.users.hrA!),
        ),
      ).toMatchObject({ outcome: 'ALREADY_ACTIVE' });
      expect(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: fx.assignmentTeamA },
        }),
      ).toEqual(activeBefore);
      expect(await activationAudits(tx, fx.assignmentTeamA)).toHaveLength(0);

      // An inactive employee's assignment stays planned.
      const due = await plannedAssignment(tx, fx, 'inactive', {
        startDate: businessDay(-3),
      });
      await tx.employee.update({
        where: { id: fx.employee1 },
        data: { status: 'INACTIVE' },
      });
      expect(codeOf(await activate(due.id))).toBe('EMPLOYEE_NOT_ACTIVE');

      for (const row of [future, expired, due]) {
        expect(
          (
            await tx.employmentAssignment.findUniqueOrThrow({
              where: { id: row.id },
            })
          ).status,
        ).toBe('PLANNED');
      }
      expect(
        await tx.auditLog.count({
          where: { action: 'EMPLOYMENT_ASSIGNMENT_ACTIVATED' },
        }),
      ).toBe(0);
    });
  });

  it('requires employee.manage in the assignment scope and never crosses organizations', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      const planned = await plannedAssignment(
        tx,
        fx,
        'scoped',
        { startDate: businessDay(-5) },
        { departmentId: fx.deptB },
      );
      // Another organization's manager.
      expect(
        statusOf(
          await rejection(
            employees.activateAssignment(
              fx.employee1,
              planned.id,
              ctx(fx.users.hrB!),
            ),
          ),
        ),
      ).toBe(403);
      // In the organization, but scoped to Team A while the assignment is in Dept B.
      expect(
        statusOf(
          await rejection(
            employees.activateAssignment(
              fx.employee1,
              planned.id,
              ctx(fx.users.teamAHr!),
            ),
          ),
        ),
      ).toBe(403);
      // The assignment must belong to the employee in the path.
      expect(
        statusOf(
          await rejection(
            employees.activateAssignment(
              fx.employee2,
              planned.id,
              ctx(fx.users.hrA!),
            ),
          ),
        ),
      ).toBe(404);
      // No actor, no activation.
      expect(
        statusOf(
          await rejection(
            employees.activateAssignment(fx.employee1, planned.id, {}),
          ),
        ),
      ).toBe(403);
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: planned.id },
          })
        ).status,
      ).toBe('PLANNED');

      // A Team A manager may activate Team A assignments.
      const teamA = await plannedAssignment(
        tx,
        fx,
        'teamA',
        { startDate: businessDay(-5) },
        { teamId: fx.teamA, departmentId: fx.deptA },
      );
      expect(
        await employees.activateAssignment(
          fx.employee1,
          teamA.id,
          ctx(fx.users.teamAHr!),
        ),
      ).toMatchObject({ outcome: 'ACTIVATED' });
    });
  });

  it('activates every due assignment automatically, in its own timezone, recovering missed runs and retrying failures', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { domain } = services(client);
      // A fixed instant: 2026-10-07 12:00 UTC is 08:00 in Toronto and already 2026-10-08 on
      // Kiritimati (UTC+14).
      const now = new Date('2026-10-07T12:00:00.000Z');
      const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
      const kiritimati = await tx.workLocation.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: `Line Islands ${fx.suffix}`,
          code: `LI-${fx.suffix}`,
          timezone: 'Pacific/Kiritimati',
        },
      });
      const overdue = await plannedAssignment(tx, fx, 'overdue', {
        startDate: d('2026-09-01'),
      });
      const today = await plannedAssignment(tx, fx, 'today', {
        startDate: d('2026-10-07'),
      });
      const aheadOfUtc = await plannedAssignment(
        tx,
        fx,
        'ahead',
        { startDate: d('2026-10-08') },
        { departmentId: fx.deptB, workLocationId: kiritimati.id },
      );
      const tomorrowHere = await plannedAssignment(tx, fx, 'tomorrow', {
        startDate: d('2026-10-08'),
      });
      const future = await plannedAssignment(tx, fx, 'future', {
        startDate: d('2026-11-01'),
      });
      const expired = await plannedAssignment(tx, fx, 'expired', {
        startDate: d('2026-08-01'),
        endDate: d('2026-09-30'),
      });
      const flaky = await plannedAssignment(tx, fx, 'flaky', {
        startDate: d('2026-10-01'),
      });

      // First run (after a long outage): one transient failure; everything else committed.
      let failOnce = true;
      const flakyDomain = {
        activateAssignment: (
          ...args: Parameters<EmployeeDomainService['activateAssignment']>
        ) => {
          if (args[0] === flaky.id && failOnce) {
            failOnce = false;
            return Promise.reject(new Error('connection reset'));
          }
          return domain.activateAssignment(...args);
        },
      } as EmployeeDomainService;
      const first = await activateDueAssignments(client, flakyDomain, now);
      expect(first.activated).toEqual(
        expect.arrayContaining([overdue.id, today.id, aheadOfUtc.id]),
      );
      expect(first.activated).not.toContain(flaky.id);
      expect(first.failed).toEqual([
        { employmentAssignmentId: flaky.id, message: 'connection reset' },
      ]);
      expect(first.skipped).toEqual(
        expect.arrayContaining([
          {
            employmentAssignmentId: tomorrowHere.id,
            code: 'EMPLOYMENT_ASSIGNMENT_NOT_STARTED',
          },
          {
            employmentAssignmentId: expired.id,
            code: 'EMPLOYMENT_ASSIGNMENT_EXPIRED',
          },
        ]),
      );
      // A future assignment is not even a candidate.
      expect([
        ...first.activated,
        ...first.skipped.map((s) => s.employmentAssignmentId),
      ]).not.toContain(future.id);

      // The retry activates what failed; nothing is activated or audited twice.
      const retry = await runActivateDueAssignmentsJob(
        {},
        { prisma: client, now },
      );
      expect(retry.activated).toContain(flaky.id);
      expect(retry.activated).not.toEqual(expect.arrayContaining([overdue.id]));
      expect(retry.failed).toEqual([]);
      const third = await runActivateDueAssignmentsJob(
        {},
        { prisma: client, now },
      );
      expect(
        third.activated.filter((id) =>
          [overdue.id, today.id, aheadOfUtc.id, flaky.id].includes(id),
        ),
      ).toEqual([]);

      const statusOf = async (id: string) =>
        (await tx.employmentAssignment.findUniqueOrThrow({ where: { id } }))
          .status;
      expect(
        await Promise.all(
          [
            overdue,
            today,
            aheadOfUtc,
            flaky,
            tomorrowHere,
            future,
            expired,
          ].map((a) => statusOf(a.id)),
        ),
      ).toEqual([
        'ACTIVE',
        'ACTIVE',
        'ACTIVE',
        'ACTIVE',
        'PLANNED',
        'PLANNED',
        'PLANNED',
      ]);
      for (const assignment of [overdue, today, aheadOfUtc, flaky]) {
        const audits = await activationAudits(tx, assignment.id);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          actorUserId: null,
          userAgent: 'hrms-worker',
        });
        expect(audits[0]!.metadata).toMatchObject({ source: 'AUTOMATIC' });
      }
      expect(
        (await activationAudits(tx, aheadOfUtc.id))[0]!.metadata,
      ).toMatchObject({
        activatedOn: '2026-10-08',
        timezone: 'Pacific/Kiritimati',
      });

      // The next day the Toronto assignment's start has arrived.
      const nextDay = await activateDueAssignments(
        client,
        domain,
        new Date('2026-10-08T12:00:00.000Z'),
      );
      expect(nextDay.activated).toContain(tomorrowHere.id);
    });
  });

  it('makes the employee clockable at the kiosk and self-service once activated', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      await seedTimePolicy(tx, fx.orgA);
      const planned = await plannedAssignment(tx, fx, 'clock', {
        startDate: businessDay(-30),
      });
      const clock = new FixedClock();
      clock.value = new Date();
      const time = timeServices(client, clock).time;
      // While PLANNED it is neither offered nor capturable.
      const before = await time.status(fx.selfUser1);
      expect(before.eligibleAssignments.map((a) => a.id)).not.toContain(
        planned.id,
      );
      expect(
        await rejection(
          time.clockIn(fx.selfUser1, planned.id, ctx(fx.selfUser1)),
        ),
      ).toBeInstanceOf(HttpException);

      await employees.activateAssignment(
        fx.employee1,
        planned.id,
        ctx(fx.users.hrA!),
      );
      const after = await time.status(fx.selfUser1);
      expect(after.eligibleAssignments.map((a) => a.id)).toContain(planned.id);
      const status = await time.clockIn(
        fx.selfUser1,
        planned.id,
        ctx(fx.selfUser1),
      );
      expect(status).toMatchObject({
        state: 'CLOCKED_IN',
        currentTimeEntry: { employmentAssignmentId: planned.id },
      });
    });
  });
});

/**
 * Real concurrent transactions on committed data: several API calls and two worker runs race to
 * activate the same assignments. Each is activated and audited exactly once.
 */
describe('Employment assignment activation concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  const created: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      async (tx) => {
        const fixtures = await createSchedulingFixtures(tx, USERS, PERMISSIONS);
        await tx.organization.update({
          where: { id: fixtures.orgA },
          data: { timezone: TIMEZONE },
        });
        return fixtures;
      },
      { timeout: 30_000 },
    );
  });

  afterAll(async () => {
    if (fx) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.auditLog.deleteMany({ where: { entityId: { in: created } } });
      });
      await cleanupSchedulingFixtures(prisma, fx);
    }
    await prisma?.$disconnect();
  });

  it('activates once under concurrent API requests and concurrent workers', async () => {
    const { employees, domain } = services(prisma);
    const viaApi = await prisma.$transaction((tx) =>
      plannedAssignment(tx, fx, 'race-api', { startDate: businessDay(-2) }),
    );
    const viaWorkers = await prisma.$transaction((tx) =>
      plannedAssignment(tx, fx, 'race-job', { startDate: businessDay(-2) }),
    );
    created.push(viaApi.id, viaWorkers.id);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        employees.activateAssignment(
          fx.employee1,
          viaApi.id,
          ctx(fx.users.hrA!),
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === 'ACTIVATED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'ALREADY_ACTIVE')).toHaveLength(
      4,
    );
    expect(await activationAudits(prisma, viaApi.id)).toHaveLength(1);

    const runs = await Promise.all([
      activateDueAssignments(prisma, domain),
      activateDueAssignments(prisma, domain),
    ]);
    expect(
      runs.filter((run) => run.activated.includes(viaWorkers.id)),
    ).toHaveLength(1);
    expect(runs.every((run) => run.failed.length === 0)).toBe(true);
    expect(await activationAudits(prisma, viaWorkers.id)).toHaveLength(1);
    expect(
      (
        await prisma.employmentAssignment.findUniqueOrThrow({
          where: { id: viaWorkers.id },
        })
      ).status,
    ).toBe('ACTIVE');
  });
});
