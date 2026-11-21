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
import { lockEmployeeLifecycle } from '../src/employee/employee-lifecycle-support.js';
import {
  acceptedOffer,
  FixedRecruitmentClock,
  openOpening,
  RECRUITMENT_PERMISSION_KEYS,
  RECRUITMENT_USERS,
  recruitmentServices,
  vacantPosition,
  type RecruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  ...RECRUITMENT_USERS,
  // Recruits and manages employment for Team A only.
  teamHirer: [
    { permissions: RECRUITMENT_PERMISSION_KEYS, scope: 'teamA' as const },
    {
      permissions: ['employee.read', 'employee.manage'],
      scope: 'teamA' as const,
    },
  ],
};

function lifecycleServices(client: PrismaService) {
  const audit = new AuditService(client);
  const authorization = new AuthorizationService(client);
  return new EmployeeLifecycleService(
    client,
    new EmployeeDomainService(client, audit),
    new EmployeeAccessService(
      client,
      authorization,
      new PositionAuthorizationTargetResolver(client),
      audit,
    ),
    authorization,
    audit,
  );
}

const response = (error: unknown) =>
  (error as HttpException).getResponse() as Record<string, unknown>;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();

/** An employee of another organization (Org B), with a login, the hiring admin cannot see. */
async function otherOrganizationEmployee(tx: Tx, fx: SchedulingFixtures) {
  const title = await tx.jobTitle.create({
    data: {
      organizationId: fx.orgB,
      name: 'B title',
      code: `B5A-JT-${fx.suffix}`,
    },
  });
  const position = await tx.position.create({
    data: {
      organizationId: fx.orgB,
      jobTitleId: title.id,
      name: 'Org B role',
      code: `B5A-OB-${fx.suffix}`,
    },
  });
  const person = await tx.person.create({
    data: { firstName: 'Other', lastName: 'Org' },
  });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `b5a-orgb-${fx.suffix.toLowerCase()}@example.com`,
      status: 'ACTIVE',
    },
  });
  const employee = await tx.employee.create({
    data: {
      personId: person.id,
      employeeNumber: `B5A-OB-${fx.suffix}`,
      hireDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await tx.employmentAssignment.create({
    data: {
      employeeId: employee.id,
      positionId: position.id,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  return { employee, email: user.email };
}

/** An Org A employee working only in Dept B (outside Team A). */
async function deptBOnlyEmployee(tx: Tx, fx: SchedulingFixtures) {
  const template = await tx.position.findUniqueOrThrow({
    where: { id: fx.positionDeptB },
  });
  const position = await tx.position.create({
    data: {
      organizationId: fx.orgA,
      jobTitleId: template.jobTitleId,
      name: 'Dept B only',
      code: `B5A-DB-${fx.suffix}`,
      departmentId: fx.deptB,
    },
  });
  const person = await tx.person.create({
    data: { firstName: 'Dept', lastName: 'Bee' },
  });
  const employee = await tx.employee.create({
    data: {
      personId: person.id,
      employeeNumber: `B5A-DB-${fx.suffix}`,
      hireDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await tx.employmentAssignment.create({
    data: {
      employeeId: employee.id,
      positionId: position.id,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  return employee;
}

/**
 * Batch 5A — recruitment conversion into an existing employee goes through the same lifecycle
 * rules as Core HR: the employee's lifecycle lock, an ACTIVE employee without a scheduled
 * termination, and K5 attach authority (the recruiter must already see the employee, or be a
 * System administrator; internal candidates convert into their own record). The duplicate-person
 * check discloses only employees the recruiter may see.
 */
describe('Recruitment conversion and the employee lifecycle (Batch 5A, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: RecruitmentServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const svc = recruitmentServices(
            rollbackClient(tx),
            new FixedRecruitmentClock(),
          );
          await run(tx, fx, svc).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** An accepted offer on a fresh Team A position (visible to the Team A hirer). */
  async function teamOffer(
    tx: Tx,
    fx: SchedulingFixtures,
    svc: RecruitmentServices,
    openingId: string,
    email: string,
  ) {
    const positionId = await vacantPosition(tx, fx, { team: true });
    const offer = await acceptedOffer(svc, fx, {
      positionId,
      openingId,
      candidate: { email },
    });
    return { ...offer, positionId };
  }

  const assignmentsOn = (tx: Tx, positionId: string) =>
    tx.employmentAssignment.count({ where: { positionId } });

  it('refuses conversion into an INACTIVE employee or one with a scheduled termination', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const opening = await openOpening(svc, fx, {
        positionId: await vacantPosition(tx, fx, { team: true }),
        openingCount: 5,
      });
      await tx.employee.update({
        where: { id: fx.employee2 },
        data: { status: 'INACTIVE' },
      });
      const inactiveOffer = await teamOffer(
        tx,
        fx,
        svc,
        opening.id,
        'inactive@example.com',
      );
      const inactive = await rejection(
        svc.hires.convert(
          inactiveOffer.applicationId,
          { existingEmployeeId: fx.employee2, isPrimary: false },
          admin,
        ),
      );
      expect(statusOf(inactive)).toBe(409);
      expect(response(inactive).code).toBe('EMPLOYEE_NOT_ACTIVE');
      expect(await assignmentsOn(tx, inactiveOffer.positionId)).toBe(0);

      await tx.employee.update({
        where: { id: fx.employee2 },
        data: { status: 'ACTIVE' },
      });
      const termination = await tx.employeeTermination.create({
        data: {
          employeeId: fx.employee2,
          terminationDate: new Date('2026-11-20T00:00:00.000Z'),
          recordedByUserId: fx.users.hiringAdmin!,
        },
      });
      const scheduledOffer = await teamOffer(
        tx,
        fx,
        svc,
        opening.id,
        'scheduled@example.com',
      );
      const scheduled = await rejection(
        svc.hires.convert(
          scheduledOffer.applicationId,
          { existingEmployeeId: fx.employee2, isPrimary: false },
          admin,
        ),
      );
      expect(statusOf(scheduled)).toBe(409);
      expect(response(scheduled)).toMatchObject({
        code: 'TERMINATION_SCHEDULED',
        terminationId: termination.id,
      });
      expect(await assignmentsOn(tx, scheduledOffer.positionId)).toBe(0);
      expect(
        await tx.recruitmentHire.count({
          where: { applicationId: scheduledOffer.applicationId },
        }),
      ).toBe(0);
    });
  });

  it('K5: never attaches an employee the recruiter cannot see, and answers as for a missing id', async () => {
    await scenario(async (tx, fx, svc) => {
      const other = await otherOrganizationEmployee(tx, fx);
      const deptB = await deptBOnlyEmployee(tx, fx);
      const opening = await openOpening(svc, fx, {
        positionId: await vacantPosition(tx, fx, { team: true }),
        openingCount: 5,
      });
      // An organization-wide hiring administrator of Org A, attaching Org B's employee.
      const crossOrg = await teamOffer(
        tx,
        fx,
        svc,
        opening.id,
        'cross@example.com',
      );
      const hidden = await rejection(
        svc.hires.convert(
          crossOrg.applicationId,
          { existingEmployeeId: other.employee.id, isPrimary: false },
          ctx(fx.users.hiringAdmin!),
        ),
      );
      const missing = await rejection(
        svc.hires.convert(
          crossOrg.applicationId,
          {
            existingEmployeeId: '00000000-0000-4000-8000-000000000000',
            isPrimary: false,
          },
          ctx(fx.users.hiringAdmin!),
        ),
      );
      expect(statusOf(hidden)).toBe(404);
      expect(response(hidden)).toEqual(response(missing));
      expect(JSON.stringify(response(hidden))).not.toContain(
        other.employee.employeeNumber,
      );
      // A Team A hirer, attaching an Org A employee who works only outside Team A.
      const lower = await teamOffer(
        tx,
        fx,
        svc,
        opening.id,
        'lower@example.com',
      );
      const outside = await rejection(
        svc.hires.convert(
          lower.applicationId,
          { existingEmployeeId: deptB.id, isPrimary: false },
          ctx(fx.users.teamHirer!),
        ),
      );
      expect(statusOf(outside)).toBe(404);
      expect(await assignmentsOn(tx, crossOrg.positionId)).toBe(0);
      expect(await assignmentsOn(tx, lower.positionId)).toBe(0);
      expect(
        await tx.employmentAssignment.count({
          where: { employeeId: { in: [other.employee.id, deptB.id] } },
        }),
      ).toBe(2);

      // Authorized: the Team A hirer can see Employee 2 (Team A) and attaches them.
      const allowed = await teamOffer(
        tx,
        fx,
        svc,
        opening.id,
        'allowed@example.com',
      );
      const hire = await svc.hires.convert(
        allowed.applicationId,
        { existingEmployeeId: fx.employee2, isPrimary: false },
        ctx(fx.users.teamHirer!),
      );
      expect(hire).toMatchObject({
        employeeId: fx.employee2,
        createdEmployee: false,
      });
      expect(await assignmentsOn(tx, allowed.positionId)).toBe(1);

      // An internal candidate converts into their own record even when the hirer could not
      // otherwise see them.
      const internal = await teamOffer(
        tx,
        fx,
        svc,
        opening.id,
        'internal@example.com',
      );
      await tx.recruitmentCandidate.update({
        where: { id: internal.candidateId },
        data: { internalEmployeeId: deptB.id },
      });
      const internalHire = await svc.hires.convert(
        internal.applicationId,
        { isPrimary: false },
        ctx(fx.users.teamHirer!),
      );
      expect(internalHire).toMatchObject({
        employeeId: deptB.id,
        createdEmployee: false,
      });
    });
  });

  it('the duplicate-person check discloses only employees the recruiter may see', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.hiringAdmin!);
      const other = await otherOrganizationEmployee(tx, fx);
      const opening = await openOpening(svc, fx, {
        positionId: await vacantPosition(tx, fx, { team: true }),
        openingCount: 5,
      });
      // A visible employee's match is offered to choose.
      const self1 = await tx.user.findUniqueOrThrow({
        where: { id: fx.selfUser1 },
      });
      const known = await teamOffer(tx, fx, svc, opening.id, self1.email);
      const visible = await rejection(
        svc.hires.convert(known.applicationId, {}, admin),
      );
      expect(statusOf(visible)).toBe(409);
      expect(response(visible).matches).toEqual([
        expect.objectContaining({ employeeId: fx.employee1 }),
      ]);
      // Batch 5E (R1): Org B's employee, invisible to the recruiter, has the candidate's email.
      // It no longer causes a conflict at all (5A refused with an empty list, which still
      // revealed that the email exists elsewhere): a separate person is created in Org A.
      const foreign = await teamOffer(tx, fx, svc, opening.id, other.email);
      const created = await svc.hires.convert(foreign.applicationId, {}, admin);
      expect(created).toMatchObject({ createdEmployee: true });
      expect(created.employeeId).not.toBe(other.employee.id);
    });
  });
});

/**
 * Committed data: a recruitment conversion and a termination of the same employee race. Both
 * take the employee's lifecycle lock, so either the conversion comes first (and the termination
 * then covers the new assignment too) or the termination comes first (and the conversion is
 * refused): never an open assignment outside the termination.
 */
describe('Recruitment conversion racing a termination (Batch 5A, committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures | undefined;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  beforeEach(async () => {
    fx = await prisma.$transaction(
      async (tx) => {
        const created = await createSchedulingFixtures(tx, USERS);
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
          where: { entityId: { in: [fx!.employee1, fx!.employee2] } },
        });
      });
      await cleanupSchedulingFixtures(prisma, fx);
      fx = undefined;
    }
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('a conversion waits for a termination in progress and is then refused (deterministic order)', async () => {
    const f = fx!;
    const svc = recruitmentServices(prisma, new FixedRecruitmentClock());
    const positionId = await prisma.$transaction((tx) =>
      vacantPosition(tx, f, { team: true }),
    );
    const offer = await acceptedOffer(svc, f, {
      positionId,
      candidate: { email: 'race-held@example.com' },
    });
    let conversion: Promise<unknown> | undefined;
    let settled = false;
    await prisma.$transaction(
      async (tx) => {
        // A termination in progress: it holds the employee's lifecycle lock.
        await lockEmployeeLifecycle(tx, f.employee2);
        conversion = svc.hires
          .convert(
            offer.applicationId,
            { existingEmployeeId: f.employee2, isPrimary: false },
            ctx(f.users.hiringAdmin!),
          )
          .finally(() => {
            settled = true;
          });
        conversion.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        // The conversion is blocked on the lock, not racing ahead.
        expect(settled).toBe(false);
        await lifecycleServices(rollbackClient(tx)).terminate(
          f.employee2,
          { terminationDate: '2026-11-20' },
          ctx(f.users.hr!),
          new Date('2026-11-04T17:00:00.000Z'),
        );
      },
      { timeout: 60_000 },
    );
    const error = await rejection(conversion!);
    expect(response(error).code).toBe('TERMINATION_SCHEDULED');
    expect(
      await prisma.employmentAssignment.count({ where: { positionId } }),
    ).toBe(0);
  });

  it('never leaves a converted assignment outside a termination recorded at the same time', async () => {
    const f = fx!;
    const svc = recruitmentServices(prisma, new FixedRecruitmentClock());
    const lifecycle = lifecycleServices(prisma);
    const positionId = await prisma.$transaction((tx) =>
      vacantPosition(tx, f, { team: true }),
    );
    const offer = await acceptedOffer(svc, f, {
      positionId,
      candidate: { email: 'race@example.com' },
    });
    const outcomes = await Promise.allSettled([
      svc.hires.convert(
        offer.applicationId,
        { existingEmployeeId: f.employee2, isPrimary: false },
        ctx(f.users.hiringAdmin!),
      ),
      lifecycle.terminate(
        f.employee2,
        { terminationDate: '2026-11-20' },
        ctx(f.users.hr!),
        new Date('2026-11-04T17:00:00.000Z'),
      ),
    ]);
    const [conversion, termination] = outcomes;
    expect(termination.status).toBe('fulfilled');
    if (conversion.status === 'rejected')
      expect(response(conversion.reason).code).toBe('TERMINATION_SCHEDULED');
    const open = await prisma.employmentAssignment.findMany({
      where: { employeeId: f.employee2, status: { in: ['ACTIVE', 'PLANNED'] } },
      select: { id: true, endDate: true },
    });
    const effects = await prisma.employeeTerminationAssignment.findMany({
      where: { termination: { employeeId: f.employee2, status: 'SCHEDULED' } },
      select: { employmentAssignmentId: true },
    });
    // Every open assignment — including a converted one — belongs to the termination and ends
    // by its date.
    expect(effects.map((e) => e.employmentAssignmentId).sort()).toEqual(
      open.map((a) => a.id).sort(),
    );
    for (const a of open)
      expect(a.endDate?.toISOString().slice(0, 10)).toBe('2026-11-20');
    expect(
      await prisma.employmentAssignment.count({ where: { positionId } }),
    ).toBe(conversion.status === 'fulfilled' ? 1 : 0);
  });
});
