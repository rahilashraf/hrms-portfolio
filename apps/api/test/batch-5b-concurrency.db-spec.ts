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
import { localDateOf } from '../src/common/domain-support.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeAssignmentOperationsService } from '../src/employee/employee-assignment-operations.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import { OrganizationArchivePolicyService } from '../src/organization/organization-archive-policy.service.js';
import { OrganizationIntegrityService } from '../src/organization/organization-integrity.service.js';
import { OrganizationService } from '../src/organization/organization.service.js';
import { PhysicalSiteService } from '../src/organization/physical-site.service.js';
import { AttendanceDeviceService } from '../src/kiosk/attendance-device.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

const HR = [
  'employee.manage',
  'employee.read',
  'organization.manage',
  'organization.read',
];
const USERS = {
  hrA: [{ permissions: HR, scope: 'org' as const }],
  hrA2: [{ permissions: HR, scope: 'org' as const }],
  deviceAdmin: [{ permissions: ['time.device.manage'], scope: 'org' as const }],
};
const TZ = 'America/Toronto';
const iso = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (value: Date, days: number) =>
  new Date(value.getTime() + days * 86_400_000);
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
    operations: new EmployeeAssignmentOperationsService(
      client,
      domain,
      access,
      lifecycle,
      authorization,
      audit,
    ),
    organization: new OrganizationService(
      client,
      audit,
      new OrganizationIntegrityService(client),
      new OrganizationArchivePolicyService(),
      authorization,
    ),
  };
}

/**
 * Batch 5B — committed data, separate connections. Transfers, terminations, assignment creation
 * and structure changes serialize on the employee lifecycle lock, the position locks and the
 * organization structure lock, so the result is always one of the serial orders.
 */
describe('Batch 5B concurrency (committed data)', () => {
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
          ...HR,
          'time.device.manage',
        ]);
        await tx.organization.update({
          where: { id: created.orgA },
          data: { timezone: TZ },
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
        await tx.employmentAssignment.updateMany({
          where: { employeeId: { in: [fx!.employee1, fx!.employee2] } },
          data: { managerAssignmentId: null },
        });
      });
      await cleanupSchedulingFixtures(prisma, fx);
      fx = undefined;
    }
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function freePosition(f: SchedulingFixtures, label: string) {
    const template = await prisma.position.findUniqueOrThrow({
      where: { id: f.positionDeptB },
    });
    return prisma.position.create({
      data: {
        organizationId: f.orgA,
        jobTitleId: template.jobTitleId,
        name: `Race ${label}`,
        code: `B5B-R-${label}-${f.suffix}`,
        departmentId: f.deptB,
      },
    });
  }

  it('the same transfer requested twice at once happens once (the other replays)', async () => {
    const f = fx!;
    const { operations } = services(prisma);
    const destination = await freePosition(f, 'dup');
    const input = {
      positionId: destination.id,
      effectiveDate: iso(addDays(localDateOf(new Date(), TZ), -3)),
    };
    const outcomes = await Promise.allSettled([
      operations.transfer(
        f.employee1,
        f.assignmentDeptB,
        input,
        ctx(f.users.hrA!),
      ),
      operations.transfer(
        f.employee1,
        f.assignmentDeptB,
        input,
        ctx(f.users.hrA2!),
      ),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const replays = outcomes.map(
      (o) =>
        (o as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed,
    );
    expect(replays.sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ]);
    expect(
      await prisma.employmentAssignment.count({
        where: { positionId: destination.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'EMPLOYMENT_ASSIGNMENT_TRANSFERRED',
          entityId: f.assignmentDeptB,
        },
      }),
    ).toBe(1);
  });

  it('a transfer and a termination of the same employee never leave the new assignment outside the termination', async () => {
    const f = fx!;
    const { operations, lifecycle } = services(prisma);
    const destination = await freePosition(f, 'term');
    const today = localDateOf(new Date(), TZ);
    const outcomes = await Promise.allSettled([
      operations.transfer(
        f.employee1,
        f.assignmentDeptB,
        { positionId: destination.id, effectiveDate: iso(addDays(today, 5)) },
        ctx(f.users.hrA!),
      ),
      lifecycle.terminate(
        f.employee1,
        { terminationDate: iso(addDays(today, 30)) },
        ctx(f.users.hrA2!),
      ),
    ]);
    const [transfer, termination] = outcomes;
    expect(termination.status).toBe('fulfilled');
    if (transfer.status === 'rejected')
      expect(codeOf(transfer.reason)).toBe('TERMINATION_SCHEDULED');
    const open = await prisma.employmentAssignment.findMany({
      where: { employeeId: f.employee1, status: { in: ['ACTIVE', 'PLANNED'] } },
      select: { id: true },
    });
    const effects = await prisma.employeeTerminationAssignment.findMany({
      where: { termination: { employeeId: f.employee1, status: 'SCHEDULED' } },
      select: { employmentAssignmentId: true },
    });
    expect(effects.map((e) => e.employmentAssignmentId).sort()).toEqual(
      open.map((a) => a.id).sort(),
    );
  });

  it('a transfer refused after the source was shortened rolls back completely', async () => {
    const f = fx!;
    const { operations } = services(prisma);
    // The destination is occupied by Employee 2 from the effective date on.
    const destination = await freePosition(f, 'busy');
    await prisma.employmentAssignment.create({
      data: {
        employeeId: f.employee2,
        positionId: destination.id,
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const outcome = await Promise.allSettled([
      operations.transfer(
        f.employee1,
        f.assignmentDeptB,
        { positionId: destination.id, effectiveDate: '2026-06-01' },
        ctx(f.users.hrA!),
      ),
    ]);
    expect(outcome[0]!.status).toBe('rejected');
    const source = await prisma.employmentAssignment.findUniqueOrThrow({
      where: { id: f.assignmentDeptB },
    });
    expect(source).toMatchObject({ status: 'ACTIVE', endDate: null });
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'EMPLOYMENT_ASSIGNMENT_TRANSFERRED',
          entityId: f.assignmentDeptB,
        },
      }),
    ).toBe(0);
  });

  it('archiving a unit and creating a department under it never leave an active child of an archived unit', async () => {
    const f = fx!;
    const { organization } = services(prisma);
    const unit = await prisma.organizationalUnit.create({
      data: {
        organizationId: f.orgA,
        name: 'Race unit',
        code: `B5B-U-${f.suffix}`,
      },
    });
    await Promise.allSettled([
      organization.archiveOrganizationalUnit(
        f.orgA,
        unit.id,
        ctx(f.users.hrA!),
      ),
      organization.createDepartment(
        f.orgA,
        {
          name: 'Race department',
          code: `B5B-D-${f.suffix}`,
          organizationalUnitId: unit.id,
        },
        ctx(f.users.hrA2!),
      ),
    ]);
    const archived = (
      await prisma.organizationalUnit.findUniqueOrThrow({
        where: { id: unit.id },
      })
    ).archivedAt;
    const children = await prisma.department.count({
      where: { organizationalUnitId: unit.id, archivedAt: null },
    });
    expect(archived !== null && children > 0).toBe(false);
    expect(archived !== null || children === 1).toBe(true);
  });

  it('archiving a position and assigning someone to it never leave a live assignment in an archived position', async () => {
    const f = fx!;
    const { organization, employees } = services(prisma);
    const target = await freePosition(f, 'arch');
    await Promise.allSettled([
      organization.archivePosition(f.orgA, target.id, ctx(f.users.hrA!)),
      employees.createAssignment(
        f.employee2,
        {
          positionId: target.id,
          employmentType: 'PART_TIME',
          startDate: iso(addDays(localDateOf(new Date(), TZ), 10)),
        },
        ctx(f.users.hrA2!),
      ),
    ]);
    const archived = (
      await prisma.position.findUniqueOrThrow({ where: { id: target.id } })
    ).archivedAt;
    const live = await prisma.employmentAssignment.count({
      where: { positionId: target.id, status: { in: ['ACTIVE', 'PLANNED'] } },
    });
    expect(archived !== null && live > 0).toBe(false);
    expect(archived !== null || live === 1).toBe(true);
  });

  it('a primary conflict found after the source was shortened rolls the whole transfer back', async () => {
    const f = fx!;
    const { operations } = services(prisma);
    const destination = await freePosition(f, 'prim');
    const outcome = await Promise.allSettled([
      operations.transfer(
        f.employee1,
        f.assignmentDeptB,
        {
          positionId: destination.id,
          effectiveDate: '2026-06-01',
          isPrimary: true,
        },
        ctx(f.users.hrA!),
      ),
    ]);
    expect(outcome[0]!.status).toBe('rejected');
    expect(
      await prisma.employmentAssignment.findUniqueOrThrow({
        where: { id: f.assignmentDeptB },
      }),
    ).toMatchObject({ status: 'ACTIVE', endDate: null });
    expect(
      await prisma.employmentAssignment.count({
        where: { positionId: destination.id },
      }),
    ).toBe(0);
  });

  it('registering a kiosk and archiving its site at the same time never leave an active device on an archived site', async () => {
    const f = fx!;
    const authorization = new AuthorizationService(prisma);
    const audit = new AuditService(prisma);
    const sites = new PhysicalSiteService(prisma, authorization, audit);
    const devices = new AttendanceDeviceService(prisma, authorization, audit);
    for (let round = 0; round < 3; round += 1) {
      const site = await sites.create(
        f.orgA,
        { name: `Race site ${round}` },
        ctx(f.users.hrA!),
      );
      await Promise.allSettled([
        sites.archive(f.orgA, site.id, ctx(f.users.hrA2!)),
        devices.register(
          f.users.deviceAdmin!,
          {
            organizationId: f.orgA,
            physicalSiteId: site.id,
            name: `Race ${round}`,
          },
          ctx(f.users.deviceAdmin!),
        ),
      ]);
      const archived = (
        await prisma.physicalSite.findUniqueOrThrow({ where: { id: site.id } })
      ).archivedAt;
      const active = await prisma.attendanceDevice.count({
        where: { physicalSiteId: site.id, status: 'ACTIVE' },
      });
      expect(archived !== null && active > 0).toBe(false);
      expect(archived !== null || active === 1).toBe(true);
    }
  });
});
