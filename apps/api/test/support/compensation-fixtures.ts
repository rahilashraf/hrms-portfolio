import { PrismaService } from '../../src/database/prisma.service.js';
import { CompensationAccessService } from '../../src/compensation/compensation-access.service.js';
import { CompensationPayrollSource } from '../../src/compensation/compensation-payroll.source.js';
import { CompensationService } from '../../src/compensation/compensation.service.js';
import { PayGroupService } from '../../src/compensation/pay-group.service.js';
import { schedulingServices, type Tx } from './scheduling-fixtures.js';

export const COMPENSATION_PERMISSIONS = [
  'compensation.read',
  'compensation.manage',
  'employee.read',
  'employee.manage',
] as const;

/**
 * Users of the Phase 9 specs. self1/self2 are Employee 1/2. hr manages compensation across Org A
 * (and is no employee); self1 too, but is Employee 1. Scoped readers and managers, an
 * employee-only administrator (no compensation permission) and Employee 2 as Employee 1's
 * manager (employee.read only) prove that only compensation.* grants pay access.
 */
export const COMPENSATION_USERS = {
  hr: [
    {
      permissions: ['compensation.read', 'compensation.manage'],
      scope: 'org' as const,
    },
  ],
  reader: [{ permissions: ['compensation.read'], scope: 'org' as const }],
  teamReader: [{ permissions: ['compensation.read'], scope: 'teamA' as const }],
  unitReader: [
    { permissions: ['compensation.read'], scope: 'unitChild' as const },
  ],
  deptBManager: [
    { permissions: ['compensation.manage'], scope: 'deptB' as const },
  ],
  employeeAdmin: [
    {
      permissions: ['employee.read', 'employee.manage'],
      scope: 'org' as const,
    },
  ],
  self1: [
    {
      permissions: ['compensation.read', 'compensation.manage'],
      scope: 'org' as const,
    },
  ],
  self2: [{ permissions: ['employee.read'], scope: 'teamA' as const }],
  outsider: [
    {
      permissions: ['compensation.read', 'compensation.manage'],
      scope: 'orgB' as const,
    },
  ],
};

export function compensationServices(prisma: PrismaService) {
  const base = schedulingServices(prisma);
  const access = new CompensationAccessService(prisma, base.authorization);
  const compensation = new CompensationService(prisma, access, base.audit);
  // Assignment-local "today" sits inside the fixtures' dates (assignments start 2026-01-01).
  compensation.now = () => new Date('2026-10-05T16:00:00.000Z');
  return {
    ...base,
    access,
    compensation,
    payGroups: new PayGroupService(prisma, access, base.audit),
    payroll: new CompensationPayrollSource(prisma),
  };
}

export type CompensationServices = ReturnType<typeof compensationServices>;

/** A SYSTEM-scope user through the reserved System Owner role (inside the test transaction). */
export async function systemOwnerUser(tx: Tx, suffix: string) {
  let role = await tx.role.findFirst({ where: { isSystemOwner: true } });
  if (!role) {
    role = await tx.role.create({
      data: { code: 'SYSTEM_OWNER', name: 'System Owner', isSystemOwner: true },
    });
  }
  for (const key of ['compensation.read', 'compensation.manage']) {
    const permission = await tx.permission.upsert({
      where: { key },
      create: { key, name: key, isActive: true },
      update: { isActive: true },
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      create: { roleId: role.id, permissionId: permission.id },
      update: {},
    });
  }
  const person = await tx.person.create({ data: {} });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `p9-system-${suffix.toLowerCase()}@example.com`,
      status: 'ACTIVE',
    },
  });
  await tx.roleAssignment.create({
    data: { userId: user.id, roleId: role.id, scopeType: 'SYSTEM' },
  });
  return user.id;
}
