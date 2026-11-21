import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { FixedClock } from './support/time-fixtures.js';
import { withTimeHttp } from './support/time-http.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const HR = [
  'employee.manage',
  'employee.read',
  'organization.manage',
  'organization.read',
  'role.read',
];
/** Every module permission the assignment-impact preview gates on. */
const MODULES = [
  'time.view',
  'schedule.read',
  'leave.read',
  'compensation.read',
  'payroll.read',
  'benefit.read',
  // Batch 7A (Q7): offboarding needs an offboarding permission, not onboarding.read.
  'offboarding.read',
];
const USERS = {
  hrA: [{ permissions: HR, scope: 'org' as const }],
  // Organization-wide HR with every module's read permission.
  hrFull: [{ permissions: [...HR, ...MODULES], scope: 'org' as const }],
  // Batch 7A (Q7): onboarding rights alone never show the offboarding section.
  onboardingHr: [
    {
      permissions: [...HR, 'onboarding.read', 'onboarding.manage'],
      scope: 'org' as const,
    },
  ],
  offboardingManager: [
    { permissions: [...HR, 'offboarding.manage'], scope: 'org' as const },
  ],
  // Manages Dept B only (cannot read Team A).
  deptBHr: [
    {
      permissions: ['employee.manage', 'employee.read'],
      scope: 'deptB' as const,
    },
  ],
  deviceAdmin: [{ permissions: ['time.device.manage'], scope: 'org' as const }],
  hrB: [{ permissions: HR, scope: 'orgB' as const }],
  readerA: [
    {
      permissions: ['employee.read', 'organization.read'],
      scope: 'org' as const,
    },
  ],
  unitHr: [
    {
      permissions: ['employee.manage', 'employee.read'],
      scope: 'unitChild' as const,
    },
  ],
};
// Every permission the scenarios grant, upserted by the fixtures (CI starts from an empty catalog).
const PERMISSIONS = [
  ...HR,
  ...MODULES,
  'onboarding.read',
  'onboarding.manage',
  'offboarding.manage',
  'time.device.manage',
  'audit.read',
];
const TZ = 'America/Toronto';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const addDays = (value: Date, days: number) =>
  new Date(value.getTime() + days * 86_400_000);
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
  );
  const sites = new PhysicalSiteService(client, authorization, audit);
  return {
    authorization,
    targets,
    domain,
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
      sites,
    ),
    sites,
  };
}

/** A SYSTEM-scope administrator (global roles are reserved for the System Owner role). */
async function systemUser(tx: Tx, permissions: string[]) {
  const person = await tx.person.create({ data: {} });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `b5b-sys-${randomUUID().slice(0, 8)}@example.com`,
      status: 'ACTIVE',
    },
  });
  await systemGrant(tx, user.id, permissions);
  return user.id;
}

/** A user with no grants (Batch R3.5: for checks a shared SYSTEM grant must not answer). */
async function plainUser(tx: Tx) {
  const person = await tx.person.create({ data: {} });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `b5b-plain-${randomUUID().slice(0, 8)}@example.com`,
      status: 'ACTIVE',
    },
  });
  return user.id;
}

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
    data: { userId, roleId: role.id, scopeType: 'SYSTEM' },
  });
}

/** An organization-scope grant of `permissions` in `organizationId`. */
async function organizationGrant(
  tx: Tx,
  userId: string,
  organizationId: string,
  permissions: string[],
) {
  const role = await tx.role.create({
    data: {
      organizationId,
      code: `B5B-${randomUUID().slice(0, 8)}`,
      name: 'Batch 5B role',
    },
  });
  for (const key of permissions) {
    const permission = await tx.permission.findUniqueOrThrow({
      where: { key },
    });
    await tx.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
  }
  return tx.roleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      roleOrganizationId: organizationId,
      scopeType: 'ORGANIZATION',
      organizationId,
    },
  });
}

async function position(
  tx: Tx,
  fx: SchedulingFixtures,
  label: string,
  data: Record<string, string> = { departmentId: fx.deptB },
  organizationId = fx.orgA,
) {
  const jobTitle =
    organizationId === fx.orgA
      ? (
          await tx.position.findUniqueOrThrow({
            where: { id: fx.positionDeptB },
          })
        ).jobTitleId
      : (
          await tx.jobTitle.create({
            data: {
              organizationId,
              name: `B5B ${label}`,
              code: `B5B-JT-${label}-${fx.suffix}`,
            },
          })
        ).id;
  return tx.position.create({
    data: {
      organizationId,
      jobTitleId: jobTitle,
      name: `B5B ${label}`,
      code: `B5B-${label}-${fx.suffix}`,
      ...data,
    },
  });
}

/**
 * Batch 5B — organization and assignment operations: transfer (K6), manager links (K7),
 * archived-organization grants (K9), position archive and activation guards (D17), the
 * position scope resolver (D19), physical sites (D12) and the assignment-impact preview (K8).
 */
describe('Batch 5B organization and assignment operations (database)', () => {
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
          for (const id of [fx.orgA, fx.orgB])
            await tx.organization.update({
              where: { id },
              data: { timezone: TZ },
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

  const today = () => localDateOf(new Date(), TZ);

  // ─── K6 transfer ──────────────────────────────────────────────────────────

  it('transfers atomically: source ends the day before, the new assignment starts, primary and manager carry, compensation flagged, audited, replayed', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      const hr = ctx(fx.users.hrA!);
      // Team A (primary) is managed by Employee 2's organization-level assignment.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { managerAssignmentId: fx.orgLevel },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '25.00',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
        },
      });
      const destination = await position(tx, fx, 'dest');
      const effective = addDays(today(), -10);
      const input = {
        positionId: destination.id,
        effectiveDate: iso(effective)!,
      };
      const result = await operations.transfer(
        fx.employee1,
        fx.assignmentTeamA,
        input,
        hr,
      );
      expect(result).toMatchObject({
        replayed: false,
        compensationRequired: true,
        sourceHadCompensation: true,
        primaryCarried: true,
        manager: { managerAssignmentId: fx.orgLevel, carried: true },
        sourceAssignment: {
          id: fx.assignmentTeamA,
          status: 'ENDED',
          endDate: iso(addDays(effective, -1)),
        },
        destinationAssignment: {
          positionId: destination.id,
          status: 'ACTIVE',
          startDate: iso(effective),
          isPrimary: true,
        },
      });
      // Compensation is never copied.
      expect(
        await tx.compensationRecord.count({
          where: { employmentAssignmentId: result.destinationAssignment.id },
        }),
      ).toBe(0);
      const audits = await tx.auditLog.findMany({
        where: {
          action: 'EMPLOYMENT_ASSIGNMENT_TRANSFERRED',
          entityId: fx.assignmentTeamA,
        },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({
        sourceAssignmentId: fx.assignmentTeamA,
        destinationAssignmentId: result.destinationAssignment.id,
        compensationRequired: true,
        crossOrganization: false,
      });
      // The same request again replays the transfer instead of failing or duplicating it.
      const again = await operations.transfer(
        fx.employee1,
        fx.assignmentTeamA,
        input,
        hr,
      );
      expect(again).toMatchObject({
        replayed: true,
        destinationAssignment: { id: result.destinationAssignment.id },
      });
      expect(
        await tx.employmentAssignment.count({
          where: { positionId: destination.id },
        }),
      ).toBe(1);
      expect(
        await tx.auditLog.count({
          where: {
            action: 'EMPLOYMENT_ASSIGNMENT_TRANSFERRED',
            entityId: fx.assignmentTeamA,
          },
        }),
      ).toBe(1);
    });
  });

  it('a future transfer keeps the source ACTIVE until its last day and plans the new assignment', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      const destination = await position(tx, fx, 'future');
      const effective = addDays(today(), 20);
      const result = await operations.transfer(
        fx.employee1,
        fx.assignmentDeptB,
        { positionId: destination.id, effectiveDate: iso(effective)! },
        ctx(fx.users.hrA!),
      );
      expect(result.sourceAssignment).toMatchObject({
        status: 'ACTIVE',
        endDate: iso(addDays(effective, -1)),
      });
      expect(result.destinationAssignment).toMatchObject({
        status: 'PLANNED',
        startDate: iso(effective),
        isPrimary: false,
      });
    });
  });

  it('cross-organization transfers need authority in both organizations; the manager does not cross', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentDeptB },
        data: { managerAssignmentId: fx.orgLevel },
      });
      const destination = await position(tx, fx, 'orgb', {}, fx.orgB);
      const input = {
        positionId: destination.id,
        effectiveDate: iso(addDays(today(), -5))!,
      };
      // Org A's administrator cannot see Org B's position.
      const hidden = await rejection(
        operations.transfer(
          fx.employee1,
          fx.assignmentDeptB,
          input,
          ctx(fx.users.hrA!),
        ),
      );
      expect(statusOf(hidden)).toBe(404);
      // Org B's administrator cannot see the source assignment.
      const source = await rejection(
        operations.transfer(
          fx.employee1,
          fx.assignmentDeptB,
          input,
          ctx(fx.users.hrB!),
        ),
      );
      expect(statusOf(source)).toBe(404);
      // Visible but read-only: 403.
      const reader = await rejection(
        operations.transfer(
          fx.employee1,
          fx.assignmentDeptB,
          input,
          ctx(fx.users.readerA!),
        ),
      );
      expect(statusOf(reader)).toBe(403);
      expect(
        await tx.employmentAssignment.count({
          where: { positionId: destination.id },
        }),
      ).toBe(0);
      // Authority in both: allowed, audited as cross-organization, manager not carried (K7).
      const both = await systemUser(tx, ['employee.manage', 'employee.read']);
      const result = await operations.transfer(
        fx.employee1,
        fx.assignmentDeptB,
        input,
        ctx(both),
      );
      expect(result.manager).toEqual({
        managerAssignmentId: null,
        carried: false,
        droppedReason: 'MANAGER_ORGANIZATION_MISMATCH',
      });
      const [audit] = await tx.auditLog.findMany({
        where: {
          action: 'EMPLOYMENT_ASSIGNMENT_TRANSFERRED',
          entityId: fx.assignmentDeptB,
        },
      });
      expect(audit!.metadata).toMatchObject({ crossOrganization: true });
    });
  });

  it('refuses transfers outside the source dates, into the same position, of an inactive employee, or over recorded time', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      const hr = ctx(fx.users.hrA!);
      const destination = await position(tx, fx, 'refuse');
      const transfer = (effectiveDate: string, positionId = destination.id) =>
        rejection(
          operations.transfer(
            fx.employee1,
            fx.assignmentDeptB,
            { positionId, effectiveDate },
            hr,
          ),
        );
      expect(codeOf(await transfer('2026-01-01'))).toBe(
        'TRANSFER_DATE_OUTSIDE_ASSIGNMENT',
      );
      expect(codeOf(await transfer('2026-06-01', fx.positionDeptB))).toBe(
        'TRANSFER_SAME_POSITION',
      );
      // Time recorded on the source after the would-be last day.
      await tx.timeEntry.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentDeptB,
          clockInAt: new Date('2026-06-10T13:00:00.000Z'),
          clockOutAt: new Date('2026-06-10T17:00:00.000Z'),
          timezone: TZ,
          workDate: d('2026-06-10'),
          status: 'CLOSED',
          source: 'MANUAL',
        },
      });
      const finalized = await transfer('2026-06-01');
      expect(codeOf(finalized)).toBe('LIFECYCLE_FINALIZED_RECORDS');
      // The source is untouched and nothing was created.
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: fx.assignmentDeptB },
          })
        ).endDate,
      ).toBeNull();
      expect(
        await tx.employmentAssignment.count({
          where: { positionId: destination.id },
        }),
      ).toBe(0);
      await tx.employee.update({
        where: { id: fx.employee1 },
        data: { status: 'INACTIVE' },
      });
      expect(codeOf(await transfer('2026-07-01'))).toBe('EMPLOYEE_NOT_ACTIVE');
    });
  });

  // ─── K7 manager links ─────────────────────────────────────────────────────

  it('K7: new manager links stay in one organization; legacy links survive corrections and are flagged', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees } = services(client);
      const system = await systemUser(tx, ['employee.manage', 'employee.read']);
      const orgBPosition = await position(tx, fx, 'mgr', {}, fx.orgB);
      const orgBManager = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: orgBPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: d('2026-01-01'),
        },
      });
      const mismatch = await rejection(
        employees.setManager(
          fx.employee1,
          fx.assignmentDeptB,
          orgBManager.id,
          ctx(system),
        ),
      );
      expect(codeOf(mismatch)).toBe('MANAGER_ORGANIZATION_MISMATCH');
      expect(statusOf(mismatch)).toBe(409);
      const create = await rejection(
        employees.createAssignment(
          fx.employee1,
          {
            positionId: (await position(tx, fx, 'mgr2')).id,
            employmentType: 'PART_TIME',
            startDate: '2026-12-01',
            managerAssignmentId: orgBManager.id,
          },
          ctx(system),
        ),
      );
      expect(codeOf(create)).toBe('MANAGER_ORGANIZATION_MISMATCH');
      // A legacy cross-organization link is kept by a correction that does not change it.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentDeptB },
        data: { managerAssignmentId: orgBManager.id },
      });
      await employees.correctAssignment(
        fx.employee1,
        fx.assignmentDeptB,
        { employmentType: 'FULL_TIME', startDate: '2026-01-01' },
        ctx(fx.users.hrA!),
      );
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: fx.assignmentDeptB },
          })
        ).managerAssignmentId,
      ).toBe(orgBManager.id);
      // An ended manager: the link stays, the profile warns.
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { status: 'ENDED', endDate: d('2026-06-30') },
      });
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { managerAssignmentId: fx.otherTeamA },
      });
      const profile = await employees.profile(fx.employee1, system);
      const all = [
        ...profile.assignments.current,
        ...profile.assignments.upcoming,
        ...profile.assignments.historical,
      ] as Array<{ id: string; managerWarnings: string[] }>;
      expect(
        all.find((a) => a.id === fx.assignmentDeptB)!.managerWarnings,
      ).toEqual(['MANAGER_ORGANIZATION_MISMATCH']);
      expect(
        all.find((a) => a.id === fx.assignmentTeamA)!.managerWarnings,
      ).toEqual(['MANAGER_ASSIGNMENT_ENDED']);
      // The picker offers only same-organization managers.
      const options = await employees.managerAssignmentOptions(
        { subordinateAssignmentId: fx.assignmentDeptB, limit: 100 },
        system,
      );
      const offered = (rows: { items: Array<{ assignmentId: string }> }) =>
        rows.items.map((o) => o.assignmentId);
      expect(offered(options)).toContain(fx.otherTeamA);
      expect(offered(options)).not.toContain(orgBManager.id);
      // Batch 5C: managers for a new assignment (rehire / transfer), by position and dates —
      // same organization, overlapping dates, never the employee's own assignments.
      const future = await employees.managerAssignmentOptions(
        {
          positionId: fx.positionDeptB,
          startDate: '2026-12-01',
          employeeId: fx.employee1,
          limit: 100,
        },
        fx.users.hrA!,
      );
      expect(offered(future)).not.toContain(orgBManager.id);
      expect(offered(future)).not.toContain(fx.otherTeamA); // ended 2026-06-30
      expect(offered(future)).not.toContain(fx.assignmentDeptB); // the employee's own
      const earlier = await employees.managerAssignmentOptions(
        {
          positionId: fx.positionDeptB,
          startDate: '2026-03-01',
          endDate: '2026-04-30',
          employeeId: fx.employee1,
          limit: 100,
        },
        fx.users.hrA!,
      );
      expect(offered(earlier)).toContain(fx.otherTeamA);
      // employee.manage on the position is required, as for an existing assignment.
      expect(
        statusOf(
          await rejection(
            employees.managerAssignmentOptions(
              { positionId: fx.positionDeptB, startDate: '2026-12-01' },
              fx.users.readerA!,
            ),
          ),
        ),
      ).toBe(403);
      expect(
        statusOf(
          await rejection(
            employees.managerAssignmentOptions(
              { positionId: fx.positionDeptB, startDate: '2026-12-01' },
              fx.users.hrB!,
            ),
          ),
        ),
      ).toBe(403); // the same answer as for an existing assignment (assertPosition)
      expect(
        statusOf(
          await rejection(
            employees.managerAssignmentOptions(
              {
                positionId: fx.positionDeptB,
                startDate: '2026-12-01',
                endDate: '2026-11-01',
              },
              fx.users.hrA!,
            ),
          ),
        ),
      ).toBe(400);
    });
  });

  // ─── D17 position archive and activation ──────────────────────────────────

  it('D17: a position with live assignments is not archived; an archived position is never activated into', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { organization, employees } = services(client);
      const hr = ctx(fx.users.hrA!);
      const live = await rejection(
        organization.archivePosition(fx.orgA, fx.positionDeptB, hr),
      );
      expect(statusOf(live)).toBe(409);
      expect(codeOf(live)).toBe('POSITION_HAS_LIVE_ASSIGNMENTS');
      const empty = await position(tx, fx, 'empty');
      await organization.archivePosition(fx.orgA, empty.id, hr);
      // A planned assignment left in a position archived before this guard (legacy data).
      const legacy = await position(tx, fx, 'legacy');
      const planned = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: legacy.id,
          employmentType: 'PART_TIME',
          status: 'PLANNED',
          startDate: d('2026-02-01'),
        },
      });
      await tx.position.update({
        where: { id: legacy.id },
        data: { archivedAt: new Date() },
      });
      const activation = await rejection(
        employees.activateAssignment(fx.employee1, planned.id, hr),
      );
      expect(codeOf(activation)).toBe('POSITION_ARCHIVED');
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: planned.id },
          })
        ).status,
      ).toBe('PLANNED');
    });
  });

  // ─── K9 archived organizations ────────────────────────────────────────────

  it('K9: grants of an archived organization stop counting, others and SYSTEM stay, reactivation restores them', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { authorization } = services(client);
      // Batch R3.5: the user whose organization grants are checked holds no SYSTEM grant. The
      // database allows a single System Owner role, shared by every spec; when another spec has
      // committed employee.read on it, a SYSTEM grant would (correctly) answer for organization
      // B too and hide what K9 checks. SYSTEM is checked on its own user below.
      const shared = await plainUser(tx);
      const inA = await organizationGrant(tx, shared, fx.orgA, [
        'employee.read',
      ]);
      const inB = await organizationGrant(tx, shared, fx.orgB, [
        'employee.read',
      ]);
      // SYSTEM and an organization B grant on one user: archiving B must keep the SYSTEM grant.
      const withSystem = await systemUser(tx, ['audit.read']);
      await organizationGrant(tx, withSystem, fx.orgB, ['employee.read']);
      const organizationGrants = async (userId: string) =>
        (await authorization.effectiveGrants(userId)).filter(
          (g) => g.scope.type === 'ORGANIZATION',
        );
      const can = (organizationId: string) =>
        authorization.can(shared, 'employee.read', {
          type: 'ORGANIZATION',
          id: organizationId,
        });
      expect(await can(fx.orgA)).toBe(true);
      expect(await can(fx.orgB)).toBe(true);
      await tx.organization.update({
        where: { id: fx.orgB },
        data: { archivedAt: new Date() },
      });
      expect(await can(fx.orgB)).toBe(false);
      expect(await can(fx.orgA)).toBe(true);
      expect(await organizationGrants(shared)).toEqual([
        {
          permission: 'employee.read',
          scope: { type: 'ORGANIZATION', id: fx.orgA },
        },
      ]);
      expect(
        await authorization.can(withSystem, 'audit.read', { type: 'SYSTEM' }),
      ).toBe(true);
      expect(await organizationGrants(withSystem)).toEqual([]);
      // The records themselves are untouched.
      for (const grant of [inA, inB])
        expect(
          (
            await tx.roleAssignment.findUniqueOrThrow({
              where: { id: grant.id },
            })
          ).revokedAt,
        ).toBeNull();
      await tx.organization.update({
        where: { id: fx.orgB },
        data: { archivedAt: null },
      });
      expect(await can(fx.orgB)).toBe(true);
      expect(await organizationGrants(withSystem)).toHaveLength(1);
      // A grant scoped to Org A through a role owned by an archived organization also stops.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { archivedAt: new Date() },
      });
      expect(await can(fx.orgA)).toBe(false);
      expect(await can(fx.orgB)).toBe(true);
    });
  });

  // ─── D19 position scope resolver ──────────────────────────────────────────

  it('D19: unit-scoped managers see team- and department-anchored positions under their unit', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees, targets } = services(client);
      const teamOnly = await position(tx, fx, 'teamonly', { teamId: fx.teamA });
      const deptOnly = await position(tx, fx, 'deptonly', {
        departmentId: fx.deptA,
      });
      const outside = await position(tx, fx, 'outside', {
        departmentId: fx.deptB,
      });
      const target = await targets.resolvePosition(teamOnly.id);
      expect(target).toMatchObject({
        type: 'TEAM',
        teamId: fx.teamA,
        departmentId: fx.deptA,
      });
      expect(target.unitPathIds).toContain(fx.unitChild);
      const options = await employees.positionOptions(
        { organizationId: fx.orgA, limit: 100 },
        fx.users.unitHr!,
      );
      const ids = options.items.map((p: { id: string }) => p.id);
      expect(ids).toEqual(expect.arrayContaining([teamOnly.id, deptOnly.id]));
      expect(ids).not.toContain(outside.id);
    });
  });

  // ─── D12 physical sites ───────────────────────────────────────────────────

  it('D12: physical sites are organization-scoped, audited, never archived while in use, and never created silently', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { sites, organization } = services(client);
      const hr = ctx(fx.users.hrA!);
      const created = await sites.create(
        fx.orgA,
        { name: 'North Campus', city: 'Toronto' },
        hr,
      );
      const clash = await rejection(
        sites.create(fx.orgA, { name: 'north campus' }, hr),
      );
      expect(codeOf(clash)).toBe('PHYSICAL_SITE_NAME_TAKEN');
      await sites.update(
        fx.orgA,
        created.id,
        { name: 'North Campus East', city: null },
        hr,
      );
      expect(
        (await sites.list(fx.orgA, fx.users.readerA!)).items.map((s) => s.name),
      ).toContain('North Campus East');
      expect(
        statusOf(
          await rejection(
            sites.create(fx.orgA, { name: 'X' }, ctx(fx.users.readerA!)),
          ),
        ),
      ).toBe(403);
      expect(
        statusOf(await rejection(sites.list(fx.orgA, fx.users.hrB!))),
      ).toBe(404);
      expect(
        statusOf(
          await rejection(sites.get(fx.orgB, created.id, fx.users.hrB!)),
        ),
      ).toBe(404);
      // In use by a work location (and the fixtures' kiosk-free site): refused.
      const inUse = await rejection(
        sites.archive(fx.orgA, fx.physicalSiteToronto, hr),
      );
      expect(codeOf(inUse)).toBe('PHYSICAL_SITE_IN_USE');
      await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: created.id,
          name: 'Front desk',
          credentialHash: `hash-${fx.suffix}`,
          credentialIssuedAt: new Date(),
        },
      });
      expect(
        codeOf(await rejection(sites.archive(fx.orgA, created.id, hr))),
      ).toBe('PHYSICAL_SITE_IN_USE');
      await tx.attendanceDevice.updateMany({
        where: { physicalSiteId: created.id },
        data: { status: 'DISABLED' },
      });
      await sites.archive(fx.orgA, created.id, hr);
      await sites.reactivate(fx.orgA, created.id, hr);
      expect(
        (
          await tx.auditLog.findMany({
            where: { entityType: 'PhysicalSite', entityId: created.id },
            orderBy: { occurredAt: 'asc' },
          })
        ).map((a) => a.action),
      ).toEqual([
        'PHYSICAL_SITE_CREATED',
        'PHYSICAL_SITE_UPDATED',
        'PHYSICAL_SITE_ARCHIVED',
        'PHYSICAL_SITE_REACTIVATED',
      ]);
      // Work locations: a site must be chosen, or a matching one requested explicitly.
      const missing = await rejection(
        organization.createWorkLocation(
          fx.orgA,
          { name: 'Annex', code: `ANX-${fx.suffix}`, timezone: TZ },
          hr,
        ),
      );
      expect(codeOf(missing)).toBe('PHYSICAL_SITE_REQUIRED');
      const before = await tx.physicalSite.count({
        where: { organizationId: fx.orgA },
      });
      const annex = await organization.createWorkLocation(
        fx.orgA,
        {
          name: 'Annex',
          code: `ANX-${fx.suffix}`,
          timezone: TZ,
          createPhysicalSite: true,
        },
        hr,
      );
      expect(
        await tx.physicalSite.count({ where: { organizationId: fx.orgA } }),
      ).toBe(before + 1);
      expect(
        await tx.auditLog.count({
          where: {
            action: 'PHYSICAL_SITE_CREATED',
            entityId: annex.physicalSiteId!,
          },
        }),
      ).toBe(1);
      // Another organization's site is never accepted.
      const foreign = await tx.physicalSite.create({
        data: { organizationId: fx.orgB, name: 'B site' },
      });
      expect(
        statusOf(
          await rejection(
            organization.updateWorkLocation(
              fx.orgA,
              annex.id,
              { physicalSiteId: foreign.id },
              hr,
            ),
          ),
        ),
      ).toBe(404);
    });
  });

  // ─── K8 assignment impact ─────────────────────────────────────────────────

  it('K8: the impact preview lists what an assignment end leaves behind, changes nothing, and is scoped', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      await tx.timeEntry.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          clockInAt: new Date(Date.now() - 3_600_000),
          timezone: TZ,
          workDate: today(),
        },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '25.00',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
        },
      });
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { managerAssignmentId: fx.assignmentTeamA },
      });
      const template = await tx.workflowTemplate.create({
        data: {
          organizationId: fx.orgA,
          kind: 'OFFBOARDING',
          code: `OFF-${fx.suffix}`,
          name: 'Standard offboarding',
          status: 'ACTIVE',
          activatedAt: new Date(),
          isDefault: true,
        },
      });
      // Batch 6B: "changes nothing" is asserted over this scenario's own audit trail (its
      // fixture users as actors, its records as entities): a database-wide count also counted
      // rows other spec files committed meanwhile, which made the test flaky.
      const fixtureAudits = () =>
        tx.auditLog.count({
          where: {
            OR: [
              {
                actorUserId: {
                  in: [...Object.values(fx.users), fx.selfUser1, fx.selfUser2],
                },
              },
              {
                entityId: {
                  in: [
                    fx.orgA,
                    fx.employee1,
                    fx.employee2,
                    fx.assignmentTeamA,
                    fx.otherTeamA,
                    template.id,
                  ],
                },
              },
            ],
          },
        });
      const audits = await fixtureAudits();
      const end = iso(addDays(today(), 7))!;
      const impact = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        fx.users.hrFull!,
        { endDate: end },
      );
      expect(impact).toMatchObject({
        endDate: end,
        blocked: false,
        blockers: [],
        attendance: {
          openTimeEntries: {
            total: 1,
            truncated: false,
            items: [expect.objectContaining({ id: expect.any(String) })],
          },
        },
        compensation: {
          recordsBeyondEnd: {
            total: 1,
            items: [expect.objectContaining({ effectiveTo: null })],
          },
        },
        managerRelationships: {
          visibleDirectReportCount: 1,
          visibleDirectReports: [
            expect.objectContaining({ employmentAssignmentId: fx.otherTeamA }),
          ],
        },
        employment: {
          remainsEmployedInOrganization: true,
          // Only a SYSTEM reader sees the employee-wide conclusion.
          endsLastCurrentEmployment: null,
        },
        access: { changesAccess: false },
        offboarding: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          plannedEndDate: end,
          defaultTemplate: { id: template.id, name: 'Standard offboarding' },
          openWorkflowId: null,
        },
      });
      expect(await fixtureAudits()).toBe(audits);
      expect(
        statusOf(
          await rejection(
            operations.impact(
              fx.employee1,
              fx.assignmentTeamA,
              fx.users.hrB!,
              {},
            ),
          ),
        ),
      ).toBe(404);
      expect(
        statusOf(
          await rejection(
            operations.impact(
              fx.employee1,
              fx.assignmentTeamA,
              fx.users.readerA!,
              {},
            ),
          ),
        ),
      ).toBe(403);
      expect(
        statusOf(
          await rejection(
            operations.impact(fx.employee1, fx.assignmentTeamA, fx.users.hrA!, {
              endDate: '2025-12-31',
            }),
          ),
        ),
      ).toBe(400);
    });
  });

  // ─── Pre-merge audit fixes ────────────────────────────────────────────────

  it('K8 scoping: callers see only the sections, assignments and reports their permissions cover', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      // Employee 1 also works in Organization B; Team A manages a report there too (legacy).
      const orgBPosition = await position(tx, fx, 'impactb', {}, fx.orgB);
      const orgBAssignment = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: orgBPosition.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          startDate: d('2026-01-01'),
        },
      });
      const orgBReportPosition = await position(
        tx,
        fx,
        'impactrb',
        {},
        fx.orgB,
      );
      await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: orgBReportPosition.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          startDate: d('2026-01-01'),
          managerAssignmentId: fx.assignmentTeamA,
        },
      });
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { managerAssignmentId: fx.assignmentTeamA },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'HOURLY',
          rateAmount: '25.00',
          currency: 'CAD',
          effectiveFrom: d('2026-01-01'),
        },
      });
      // Recorded time after the would-be end: the end is blocked.
      const end = iso(addDays(today(), -20))!;
      await tx.timeEntry.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          clockInAt: new Date(Date.now() - 5 * 86_400_000),
          clockOutAt: new Date(Date.now() - 5 * 86_400_000 + 3_600_000),
          timezone: TZ,
          workDate: addDays(today(), -5),
          status: 'CLOSED',
          source: 'MANUAL',
        },
      });

      // Organization-wide employee.manage + role.read, no module read permissions.
      const limited = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        fx.users.hrA!,
        { endDate: end },
      );
      expect(limited).toMatchObject({
        blocked: true,
        blockers: [],
        attendance: null,
        scheduling: null,
        leave: null,
        compensation: null,
        payroll: null,
        benefits: null,
        offboarding: null,
        access: expect.objectContaining({ changesAccess: false }),
        employment: {
          remainsEmployedInOrganization: true,
          endsLastCurrentEmployment: null,
        },
        managerRelationships: { visibleDirectReportCount: 1 },
      });
      // Nothing of Organization B leaks: not its assignment, not its report, not their ids.
      const text = JSON.stringify(limited);
      expect(text).not.toContain(orgBAssignment.id);
      expect(text).not.toContain(orgBPosition.id);
      expect(text).not.toContain(fx.orgB);
      expect(
        limited.employment.otherCurrentAssignments.map(
          (o) => o.employmentAssignmentId,
        ),
      ).toEqual([fx.assignmentDeptB]);

      // A unit-scoped manager: no role.read (no access section), no organization-wide view.
      const unit = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        fx.users.unitHr!,
        { endDate: end },
      );
      expect(unit).toMatchObject({
        access: null,
        employment: {
          otherCurrentAssignments: [],
          remainsEmployedInOrganization: null,
          endsLastCurrentEmployment: null,
        },
      });

      // Every module permission: the sections and the time blocker appear.
      const full = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        fx.users.hrFull!,
        { endDate: end },
      );
      expect(full.blockers).toEqual([
        expect.objectContaining({ kind: 'TIME_RECORDED' }),
      ]);
      expect(full.compensation?.recordsBeyondEnd.total).toBe(1);
      expect(full.offboarding).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
      });
      expect(JSON.stringify(full)).not.toContain(orgBAssignment.id);

      // Batch 7A (Q7): onboarding permissions do not reveal offboarding; offboarding.manage does.
      const onboardingOnly = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        fx.users.onboardingHr!,
        { endDate: end },
      );
      expect(onboardingOnly.offboarding).toBeNull();
      const offboardingManager = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        fx.users.offboardingManager!,
        { endDate: end },
      );
      expect(offboardingManager.offboarding).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
      });

      // SYSTEM sees the employee-wide picture.
      const system = await systemUser(tx, ['employee.manage', 'employee.read']);
      const wide = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        system,
        { endDate: end },
      );
      expect(wide.employment.endsLastCurrentEmployment).toBe(false);
      expect(
        wide.employment.otherCurrentAssignments.map(
          (o) => o.employmentAssignmentId,
        ),
      ).toEqual(
        expect.arrayContaining([fx.assignmentDeptB, orgBAssignment.id]),
      );
    });
  });

  it('K8 bounds: more than the limit is reported with its exact total and truncated', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      const schedule = await tx.schedule.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          name: 'Bounds',
          type: 'AD_HOC',
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishedByUserId: fx.users.hrA!,
          periodStart: addDays(today(), 1),
          periodEnd: addDays(today(), 60),
        },
      });
      for (let i = 1; i <= 55; i += 1) {
        const day = addDays(today(), i);
        await tx.scheduledShift.create({
          data: {
            scheduleId: schedule.id,
            employmentAssignmentId: fx.assignmentTeamA,
            workDate: day,
            startsAt: new Date(day.getTime() + 14 * 3_600_000),
            endsAt: new Date(day.getTime() + 15 * 3_600_000),
            timezone: TZ,
          },
        });
      }
      const impact = await operations.impact(
        fx.employee1,
        fx.assignmentTeamA,
        fx.users.hrFull!,
        { endDate: iso(today())! },
      );
      expect(impact.scheduling?.futurePublishedShifts).toMatchObject({
        total: 55,
        truncated: true,
        limit: 50,
      });
      expect(impact.scheduling?.futurePublishedShifts.items).toHaveLength(50);
    });
  });

  it('an explicitly chosen manager must be visible to the caller (create and transfer)', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { employees, operations } = services(client);
      const hr = ctx(fx.users.deptBHr!);
      const target = await position(tx, fx, 'mgrvis');
      // Team A's assignment is invisible to a Dept B manager: 403, as set-manager answers.
      const create = await rejection(
        employees.createAssignment(
          fx.employee1,
          {
            positionId: target.id,
            employmentType: 'PART_TIME',
            startDate: '2026-12-01',
            managerAssignmentId: fx.assignmentTeamA,
          },
          hr,
        ),
      );
      expect(statusOf(create)).toBe(403);
      const missing = await rejection(
        employees.createAssignment(
          fx.employee1,
          {
            positionId: target.id,
            employmentType: 'PART_TIME',
            startDate: '2026-12-01',
            managerAssignmentId: '00000000-0000-4000-8000-000000000000',
          },
          hr,
        ),
      );
      expect(statusOf(missing)).toBe(404);
      const transfer = await rejection(
        operations.transfer(
          fx.employee1,
          fx.assignmentDeptB,
          {
            positionId: target.id,
            effectiveDate: iso(addDays(today(), 10))!,
            managerAssignmentId: fx.assignmentTeamA,
          },
          hr,
        ),
      );
      expect(statusOf(transfer)).toBe(403);
      // A visible manager in the same organization is accepted.
      const visibleManager = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: (await position(tx, fx, 'mgrvis2')).id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: d('2026-01-01'),
        },
      });
      const moved = await operations.transfer(
        fx.employee1,
        fx.assignmentDeptB,
        {
          positionId: target.id,
          effectiveDate: iso(addDays(today(), 10))!,
          managerAssignmentId: visibleManager.id,
        },
        hr,
      );
      expect(moved.destinationAssignment.managerAssignmentId).toBe(
        visibleManager.id,
      );
    });
  });

  it('transfers judge each side in its own time zone (Asia/Kolkata and America/Toronto)', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      const hr = ctx(fx.users.hrA!);
      const kolkata = await tx.workLocation.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: 'Kolkata',
          code: `B5B-KOL-${fx.suffix}`,
          timezone: 'Asia/Kolkata',
        },
      });
      // 20:00 UTC on 10 November: 01:30 on the 11th in Kolkata, 15:00 on the 10th in Toronto.
      const now = new Date('2026-11-10T20:00:00.000Z');
      const effectiveDate = '2026-11-11';
      // Kolkata → Toronto: the source's last day (10th) has passed in Kolkata → ENDED; the
      // 11th has not begun in Toronto → PLANNED.
      const kolkataSource = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: (
            await position(tx, fx, 'kolsrc', {
              departmentId: fx.deptB,
              workLocationId: kolkata.id,
            })
          ).id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          startDate: d('2026-01-01'),
        },
      });
      const toToronto = await operations.transfer(
        fx.employee2,
        kolkataSource.id,
        { positionId: (await position(tx, fx, 'torDest')).id, effectiveDate },
        hr,
        now,
      );
      expect(toToronto.sourceAssignment).toMatchObject({
        status: 'ENDED',
        endDate: '2026-11-10',
      });
      expect(toToronto.destinationAssignment.status).toBe('PLANNED');
      // Toronto → Kolkata: the last day is still today in Toronto → ACTIVE; the 11th is today in
      // Kolkata → ACTIVE.
      const toKolkata = await operations.transfer(
        fx.employee1,
        fx.assignmentDeptB,
        {
          positionId: (
            await position(tx, fx, 'kolDest', {
              departmentId: fx.deptB,
              workLocationId: kolkata.id,
            })
          ).id,
          effectiveDate,
        },
        hr,
        now,
      );
      expect(toKolkata.sourceAssignment).toMatchObject({
        status: 'ACTIVE',
        endDate: '2026-11-10',
      });
      expect(toKolkata.destinationAssignment.status).toBe('ACTIVE');
    });
  });

  it('transfers a PLANNED assignment whose start has arrived', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      const planned = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: (await position(tx, fx, 'plsrc')).id,
          employmentType: 'PART_TIME',
          status: 'PLANNED',
          startDate: d('2026-02-01'),
        },
      });
      const result = await operations.transfer(
        fx.employee2,
        planned.id,
        {
          positionId: (await position(tx, fx, 'pldst')).id,
          effectiveDate: '2026-06-01',
        },
        ctx(fx.users.hrA!),
      );
      expect(result.sourceAssignment).toMatchObject({
        status: 'ENDED',
        endDate: '2026-05-31',
      });
      expect(result.destinationAssignment.status).toBe('ACTIVE');
      // A PLANNED assignment that has not started cannot be transferred.
      const future = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: (await position(tx, fx, 'plfut')).id,
          employmentType: 'PART_TIME',
          status: 'PLANNED',
          startDate: addDays(today(), 30),
        },
      });
      const refused = await rejection(
        operations.transfer(
          fx.employee2,
          future.id,
          {
            positionId: (await position(tx, fx, 'plfut2')).id,
            effectiveDate: iso(addDays(today(), 40))!,
          },
          ctx(fx.users.hrA!),
        ),
      );
      expect(codeOf(refused)).toBe('TRANSFER_SOURCE_NOT_ACTIVE');
    });
  });

  it('an approved timesheet or a finalized payroll run after the last day blocks the transfer, changing nothing', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      const hr = ctx(fx.users.hrA!);
      const destination = await position(tx, fx, 'fin');
      const transfer = (effectiveDate: string) =>
        rejection(
          operations.transfer(
            fx.employee1,
            fx.assignmentDeptB,
            { positionId: destination.id, effectiveDate },
            hr,
          ),
        );
      // An approved timesheet segment for 1–14 June.
      const june = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: d('2026-06-01'),
          endDate: d('2026-06-14'),
          status: 'OPEN',
          openedAt: new Date(),
        },
      });
      const sheet = await tx.timesheet.create({
        data: { employeeId: fx.employee1, timePeriodId: june.id },
      });
      await tx.timesheetSegment.create({
        data: {
          timesheetId: sheet.id,
          employmentAssignmentId: fx.assignmentDeptB,
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedByUserId: fx.users.hrA!,
        },
      });
      const approved = await transfer('2026-06-05');
      expect(codeOf(approved)).toBe('LIFECYCLE_FINALIZED_RECORDS');
      expect(
        ((approved as HttpException).getResponse() as { blockers: unknown[] })
          .blockers,
      ).toEqual([expect.objectContaining({ kind: 'APPROVED_TIMESHEET' })]);

      // A finalized payroll run for 1–14 July that includes the employee.
      const payGroup = await tx.payGroup.create({
        data: { organizationId: fx.orgA, code: `PG-${fx.suffix}`, name: 'PG' },
      });
      const calendar = await tx.payrollCalendar.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          cadence: 'BIWEEKLY',
          timezone: TZ,
          anchorDate: d('2026-07-01'),
          payDateOffsetDays: 6,
          processingCutoffOffsetDays: 3,
          effectiveFrom: d('2026-07-01'),
        },
      });
      const july = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: d('2026-07-01'),
          endDate: d('2026-07-14'),
          status: 'OPEN',
          openedAt: new Date(),
        },
      });
      const period = await tx.payrollPeriod.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          payrollCalendarId: calendar.id,
          periodStart: d('2026-07-01'),
          periodEnd: d('2026-07-14'),
          payDate: d('2026-07-20'),
          processingCutoffAt: new Date('2026-07-17T22:00:00.000Z'),
          timezone: TZ,
          timePeriodId: july.id,
        },
      });
      const run = await tx.payrollRun.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          payrollPeriodId: period.id,
          currency: 'CAD',
          createdByUserId: fx.users.hrA!,
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
      const stamp = new Date();
      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'FINALIZED',
          calculatedAt: stamp,
          calculationVersion: 'v1',
          sourceFingerprint: 'sha256:b5b',
          approvedAt: stamp,
          approvedByUserId: fx.selfUser1,
          finalizedAt: stamp,
          finalizedByUserId: fx.selfUser2,
          grossAmount: '0.00',
          deductionAmount: '0.00',
          employerContributionAmount: '0.00',
        },
      });
      const finalized = await transfer('2026-07-05');
      expect(codeOf(finalized)).toBe('LIFECYCLE_FINALIZED_RECORDS');
      expect(
        ((finalized as HttpException).getResponse() as { blockers: unknown[] })
          .blockers,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'FINALIZED_PAYROLL',
            payrollRunId: run.id,
          }),
        ]),
      );
      expect(
        (
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: fx.assignmentDeptB },
          })
        ).endDate,
      ).toBeNull();
      expect(
        await tx.employmentAssignment.count({
          where: { positionId: destination.id },
        }),
      ).toBe(0);
    });
  });

  it('refuses a transfer that would overlap another primary assignment', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { operations } = services(client);
      // Team A is Employee 1's primary; Dept B moves and asks to become primary too.
      const error = await rejection(
        operations.transfer(
          fx.employee1,
          fx.assignmentDeptB,
          {
            positionId: (await position(tx, fx, 'prim')).id,
            effectiveDate: iso(addDays(today(), -3))!,
            isPrimary: true,
          },
          ctx(fx.users.hrA!),
        ),
      );
      expect(statusOf(error)).toBe(409);
      expect(String((error as Error).message)).toMatch(
        /Primary assignments may not overlap/,
      );
    });
  });

  it('kiosk devices are never registered, moved or re-enabled on an archived site', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { sites } = services(client);
      const devices = new AttendanceDeviceService(
        client,
        new AuthorizationService(client),
        new AuditService(client),
      );
      const admin = fx.users.deviceAdmin!;
      const hr = ctx(fx.users.hrA!);
      const live = await sites.create(fx.orgA, { name: 'Live site' }, hr);
      const old = await sites.create(fx.orgA, { name: 'Old site' }, hr);
      // Valid flows on a live site.
      const registered = await devices.register(
        admin,
        { organizationId: fx.orgA, physicalSiteId: live.id, name: 'Front' },
        ctx(admin),
      );
      const deviceId = registered.device.id;
      await devices.setEnabled(admin, deviceId, false, ctx(admin));
      await devices.setEnabled(admin, deviceId, true, ctx(admin));
      // Disable it and archive its site: re-enabling there is refused.
      await devices.setEnabled(admin, deviceId, false, ctx(admin));
      await devices.update(
        admin,
        deviceId,
        { physicalSiteId: old.id },
        ctx(admin),
      );
      await sites.archive(fx.orgA, old.id, hr);
      const reenable = await rejection(
        devices.setEnabled(admin, deviceId, true, ctx(admin)),
      );
      expect(codeOf(reenable)).toBe('KIOSK_LOCATION_UNUSABLE');
      expect(
        (
          await tx.attendanceDevice.findUniqueOrThrow({
            where: { id: deviceId },
          })
        ).status,
      ).toBe('DISABLED');
      // Registering on, or moving to, an archived site is refused too.
      expect(
        codeOf(
          await rejection(
            devices.register(
              admin,
              { organizationId: fx.orgA, physicalSiteId: old.id, name: 'Back' },
              ctx(admin),
            ),
          ),
        ),
      ).toBe('KIOSK_LOCATION_UNUSABLE');
      const other = await devices.register(
        admin,
        { organizationId: fx.orgA, physicalSiteId: live.id, name: 'Side' },
        ctx(admin),
      );
      expect(
        codeOf(
          await rejection(
            devices.update(
              admin,
              other.device.id,
              { physicalSiteId: old.id },
              ctx(admin),
            ),
          ),
        ),
      ).toBe('KIOSK_LOCATION_UNUSABLE');
      // Another organization's site is never accepted.
      const foreign = await tx.physicalSite.create({
        data: { organizationId: fx.orgB, name: 'B site' },
      });
      expect(
        statusOf(
          await rejection(
            devices.update(
              admin,
              other.device.id,
              { physicalSiteId: foreign.id },
              ctx(admin),
            ),
          ),
        ),
      ).toBe(404);
      // Moving the disabled device back to a live site, then re-enabling, works.
      await devices.update(
        admin,
        deviceId,
        { physicalSiteId: live.id },
        ctx(admin),
      );
      await devices.setEnabled(admin, deviceId, true, ctx(admin));
      expect(
        (
          await tx.attendanceDevice.findUniqueOrThrow({
            where: { id: deviceId },
          })
        ).status,
      ).toBe('ACTIVE');
    });
  });

  it('HTTP: limited callers get only their sections, refusals keep their status', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { sites } = services(client);
      const orgBPosition = await position(tx, fx, 'httpb', {}, fx.orgB);
      const orgBAssignment = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: orgBPosition.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          startDate: d('2026-01-01'),
        },
      });
      const live = await sites.create(
        fx.orgA,
        { name: 'HTTP site' },
        ctx(fx.users.hrA!),
      );
      const device = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: live.id,
          name: 'HTTP kiosk',
          status: 'DISABLED',
        },
      });
      await tx.physicalSite.update({
        where: { id: live.id },
        data: { archivedAt: new Date() },
      });
      await withTimeHttp(tx, new FixedClock(), async (http) => {
        const path = `/employees/${fx.employee1}/assignments/${fx.assignmentTeamA}/impact`;
        const limited = await (
          await http.as(fx.users.hrA!)
        )
          .get(path)
          .expect(200);
        expect(limited.body).toMatchObject({
          attendance: null,
          scheduling: null,
          leave: null,
          compensation: null,
          payroll: null,
          benefits: null,
          offboarding: null,
        });
        expect(JSON.stringify(limited.body)).not.toContain(orgBAssignment.id);
        await (await http.as(fx.users.hrB!)).get(path).expect(404);
        await (await http.as(fx.users.readerA!)).get(path).expect(403);
        const full = await (
          await http.as(fx.users.hrFull!)
        )
          .get(path)
          .expect(200);
        expect(full.body.attendance).toMatchObject({
          openTimeEntries: { total: 0 },
        });
        // Transfer naming a manager the caller cannot read: 403.
        const target = await position(tx, fx, 'httpt');
        await (
          await http.as(fx.users.deptBHr!)
        )
          .post(
            `/employees/${fx.employee1}/assignments/${fx.assignmentDeptB}/transfer`,
            {
              positionId: target.id,
              effectiveDate: iso(addDays(today(), 10)),
              managerAssignmentId: fx.assignmentTeamA,
            },
          )
          .expect(403);
        expect(
          (
            await tx.employmentAssignment.findUniqueOrThrow({
              where: { id: fx.assignmentDeptB },
            })
          ).endDate,
        ).toBeNull();
        // A kiosk is not re-enabled on an archived site.
        const enable = await (
          await http.as(fx.users.deviceAdmin!)
        )
          .post(`/time/devices/${device.id}/enable`)
          .expect(409);
        expect(enable.body.code).toBe('KIOSK_LOCATION_UNUSABLE');
      });
    });
  });
});
