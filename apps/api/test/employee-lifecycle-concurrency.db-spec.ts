import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

const MANAGE = ['employee.manage', 'employee.read'];
const USERS = {
  hrA: [{ permissions: MANAGE, scope: 'org' as const }],
  hrA2: [{ permissions: MANAGE, scope: 'org' as const }],
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
};
const NOW = new Date('2026-11-04T17:00:00.000Z');

const codeOf = (reason: unknown) =>
  ((reason as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;

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
  };
}

/**
 * Batch 5A — lifecycle races on committed data (separate connections, like production). Every
 * lifecycle operation takes the employee's lifecycle lock first, then positions, then the
 * employee's time lock (the one time capture takes), so competing requests serialize and the
 * outcome is always one of the serial orders. Fresh fixtures per test, removed afterwards.
 */
describe('Employee lifecycle concurrency (Batch 5A, committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures | undefined;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  beforeEach(async () => {
    fx = await prisma.$transaction(
      async (tx) => {
        const created = await createSchedulingFixtures(tx, USERS, [
          ...MANAGE,
          ...TIME_PERMISSIONS,
        ]);
        await tx.organization.update({
          where: { id: created.orgA },
          data: { timezone: 'America/Toronto' },
        });
        return created;
      },
      { timeout: 60_000 },
    );
  });
  afterEach(async () => {
    if (fx) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.auditLog.deleteMany({
          where: {
            OR: [
              { entityId: { in: [fx!.employee1, fx!.employee2] } },
              {
                entityType: 'EmploymentAssignment',
                metadata: {
                  path: ['employeeId'],
                  equals: fx!.employee1,
                },
              },
            ],
          },
        });
        await tx.timePunch.deleteMany({
          where: { timeEntry: { employeeId: fx!.employee1 } },
        });
        await tx.timeEntryAssignmentCoverage.deleteMany({
          where: { timeEntry: { employeeId: fx!.employee1 } },
        });
      });
      await cleanupSchedulingFixtures(prisma, fx);
      fx = undefined;
    }
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('records one termination when the same request arrives twice, and refuses a competing date', async () => {
    const f = fx!;
    const { lifecycle } = services(prisma);
    const same = await Promise.allSettled([
      lifecycle.terminate(
        f.employee2,
        { terminationDate: '2026-11-20' },
        ctx(f.users.hrA!),
        NOW,
      ),
      lifecycle.terminate(
        f.employee2,
        { terminationDate: '2026-11-20' },
        ctx(f.users.hrA2!),
        NOW,
      ),
    ]);
    expect(same.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const ids = same.map(
      (o) =>
        (o as PromiseFulfilledResult<{ termination: { id: string } }>).value
          .termination.id,
    );
    expect(ids[0]).toBe(ids[1]);
    const competing = await Promise.allSettled([
      lifecycle.terminate(
        f.employee1,
        { terminationDate: '2026-11-20' },
        ctx(f.users.hrA!),
        NOW,
      ),
      lifecycle.terminate(
        f.employee1,
        { terminationDate: '2026-11-25' },
        ctx(f.users.hrA2!),
        NOW,
      ),
    ]);
    const rejected = competing.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(codeOf((rejected[0] as PromiseRejectedResult).reason)).toBe(
      'TERMINATION_ALREADY_SCHEDULED',
    );
    expect(
      await prisma.employeeTermination.count({
        where: { employeeId: { in: [f.employee1, f.employee2] } },
      }),
    ).toBe(2);
  });

  it('applies a due termination exactly once when the worker and a person race', async () => {
    const f = fx!;
    const { lifecycle } = services(prisma);
    const scheduled = await lifecycle.terminate(
      f.employee2,
      { terminationDate: '2026-11-20' },
      ctx(f.users.hrA!),
      NOW,
    );
    const later = new Date('2026-11-21T06:00:00.000Z');
    const outcomes = await Promise.allSettled([
      lifecycle.processDueTerminations(later),
      lifecycle.processDueTerminations(later),
      lifecycle.applyTermination(
        f.employee2,
        scheduled.termination.id,
        ctx(f.users.hrA!),
        later,
      ),
    ]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    expect(
      await prisma.auditLog.count({
        where: { action: 'EMPLOYEE_TERMINATED', entityId: f.employee2 },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'EMPLOYMENT_ASSIGNMENT_ENDED',
          entityId: { in: [f.otherTeamA, f.orgLevel] },
        },
      }),
    ).toBe(2);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: f.employee2 } }))
        .status,
    ).toBe('TERMINATED');
  });

  it('Batch 5D: a cancellation and an application at the same time end in exactly one consistent outcome', async () => {
    const f = fx!;
    const { lifecycle } = services(prisma);
    const scheduled = await lifecycle.terminate(
      f.employee2,
      { terminationDate: '2026-11-20' },
      ctx(f.users.hrA!),
      NOW,
    );
    const later = new Date('2026-11-21T06:00:00.000Z');
    const [cancel, apply] = await Promise.allSettled([
      lifecycle.cancelTermination(
        f.employee2,
        scheduled.termination.id,
        {},
        ctx(f.users.hrA!),
        later,
      ),
      lifecycle.applyTermination(
        f.employee2,
        scheduled.termination.id,
        ctx(f.users.hrA2!),
        later,
      ),
    ]);
    // Serialized by the lifecycle lock: one wins, the other is refused with a stable code.
    expect([cancel.status, apply.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const termination = await prisma.employeeTermination.findUniqueOrThrow({
      where: { id: scheduled.termination.id },
    });
    const employee = await prisma.employee.findUniqueOrThrow({
      where: { id: f.employee2 },
    });
    const assignments = await prisma.employmentAssignment.findMany({
      where: { id: { in: [f.otherTeamA, f.orgLevel] } },
    });
    if (cancel.status === 'fulfilled') {
      expect(codeOf((apply as PromiseRejectedResult).reason)).toBe(
        'TERMINATION_NOT_SCHEDULED',
      );
      expect(termination.status).toBe('CANCELLED');
      expect(employee).toMatchObject({
        status: 'ACTIVE',
        terminationDate: null,
      });
      expect(
        assignments.every((a) => a.status === 'ACTIVE' && a.endDate === null),
      ).toBe(true);
    } else {
      expect([
        'TERMINATION_NOT_SCHEDULED',
        'TERMINATION_ALREADY_EFFECTIVE',
      ]).toContain(codeOf((cancel as PromiseRejectedResult).reason));
      expect(termination.status).toBe('APPLIED');
      expect(employee.status).toBe('TERMINATED');
      expect(assignments.every((a) => a.status === 'ENDED')).toBe(true);
    }
    // Never both: one terminal audit entry, not the other.
    const audits = await prisma.auditLog.findMany({
      where: {
        entityId: f.employee2,
        action: {
          in: ['EMPLOYEE_TERMINATED', 'EMPLOYEE_TERMINATION_CANCELLED'],
        },
      },
    });
    expect(audits).toHaveLength(1);
  });

  it('Batch 5D: the same rehire sent twice at once creates one assignment', async () => {
    const f = fx!;
    const { lifecycle } = services(prisma);
    await lifecycle.terminate(
      f.employee2,
      { terminationDate: '2026-10-31' },
      ctx(f.users.hrA!),
      NOW,
    );
    const body = {
      assignment: {
        positionId: f.positionOrg,
        employmentType: 'FULL_TIME' as const,
        startDate: '2026-11-02',
        isPrimary: true,
      },
    };
    const outcomes = await Promise.allSettled([
      lifecycle.rehire(f.employee2, body, ctx(f.users.hrA!)),
      lifecycle.rehire(f.employee2, body, ctx(f.users.hrA2!)),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const refused = outcomes.find(
      (o) => o.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(codeOf(refused.reason)).toBe('EMPLOYEE_NOT_TERMINATED');
    expect(
      await prisma.employmentAssignment.count({
        where: {
          employeeId: f.employee2,
          startDate: new Date('2026-11-02T00:00:00.000Z'),
        },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'EMPLOYEE_REHIRED', entityId: f.employee2 },
      }),
    ).toBe(1);
  });

  it('never leaves a new assignment outside a termination scheduled at the same time', async () => {
    const f = fx!;
    const { lifecycle, employees } = services(prisma);
    const template = await prisma.position.findUniqueOrThrow({
      where: { id: f.positionDeptB },
    });
    const position = await prisma.position.create({
      data: {
        organizationId: f.orgA,
        jobTitleId: template.jobTitleId,
        name: 'Race role',
        code: `B5A-RACE-${f.suffix}`,
        departmentId: f.deptB,
      },
    });
    const outcomes = await Promise.allSettled([
      lifecycle.terminate(
        f.employee2,
        { terminationDate: '2026-11-20' },
        ctx(f.users.hrA!),
        NOW,
      ),
      employees.createAssignment(
        f.employee2,
        {
          positionId: position.id,
          employmentType: 'PART_TIME',
          startDate: '2026-11-10',
        },
        ctx(f.users.hrA2!),
        NOW,
      ),
    ]);
    expect(outcomes[0].status).toBe('fulfilled');
    if (outcomes[1].status === 'rejected')
      expect(codeOf(outcomes[1].reason)).toBe('TERMINATION_SCHEDULED');
    // Whichever ran first, every open assignment ends by the termination date.
    const open = await prisma.employmentAssignment.findMany({
      where: { employeeId: f.employee2, status: { in: ['ACTIVE', 'PLANNED'] } },
    });
    for (const a of open)
      expect(a.endDate?.toISOString().slice(0, 10)).toBe('2026-11-20');
    const effects = await prisma.employeeTerminationAssignment.count({
      where: { termination: { employeeId: f.employee2 } },
    });
    expect(effects).toBe(open.length);
  });

  it('serializes an immediate termination with a clock-in: never time after the last day on an ended assignment', async () => {
    const f = fx!;
    await seedTimePolicy(prisma as never, f.orgA);
    const clock = new FixedClock();
    clock.value = new Date();
    const { time } = timeServices(prisma, clock);
    const { lifecycle } = services(prisma);
    const yesterday = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const outcomes = await Promise.allSettled([
      time.clockIn(f.selfUser1, f.assignmentTeamA, ctx(f.selfUser1)),
      lifecycle.terminate(
        f.employee1,
        { terminationDate: yesterday },
        ctx(f.users.hrA!),
      ),
    ]);
    const [clockIn, termination] = outcomes;
    // Exactly one serial order happened.
    expect([clockIn.status, termination.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const entries = await prisma.timeEntry.count({
      where: { employeeId: f.employee1 },
    });
    const employee = await prisma.employee.findUniqueOrThrow({
      where: { id: f.employee1 },
    });
    if (termination.status === 'fulfilled') {
      expect(entries).toBe(0);
      expect(employee.status).toBe('TERMINATED');
    } else {
      expect(codeOf(termination.reason)).toBe('LIFECYCLE_FINALIZED_RECORDS');
      expect(entries).toBe(1);
      expect(employee.status).toBe('ACTIVE');
    }
  });

  it('a cancel racing an apply ends either cancelled with dates restored, or applied — never half of each', async () => {
    const f = fx!;
    const { lifecycle } = services(prisma);
    const scheduled = await lifecycle.terminate(
      f.employee2,
      { terminationDate: '2026-11-20' },
      ctx(f.users.hrA!),
      NOW,
    );
    const later = new Date('2026-11-21T06:00:00.000Z');
    await Promise.allSettled([
      lifecycle.cancelTermination(
        f.employee2,
        scheduled.termination.id,
        {},
        ctx(f.users.hrA2!),
        NOW,
      ),
      lifecycle.processDueTerminations(later),
    ]);
    const row = await prisma.employeeTermination.findUniqueOrThrow({
      where: { id: scheduled.termination.id },
    });
    const assignments = await prisma.employmentAssignment.findMany({
      where: { employeeId: f.employee2 },
    });
    if (row.status === 'CANCELLED') {
      for (const a of assignments) {
        expect(a.status).toBe('ACTIVE');
        expect(a.endDate).toBeNull();
      }
    } else {
      expect(row.status).toBe('APPLIED');
      for (const a of assignments) expect(a.status).toBe('ENDED');
    }
  });
});
