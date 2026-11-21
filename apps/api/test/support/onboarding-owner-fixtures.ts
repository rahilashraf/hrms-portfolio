import { createLogin } from './auth-fixtures.js';
import { vacantPosition } from './recruitment-fixtures.js';
import type { SchedulingFixtures, Tx } from './scheduling-fixtures.js';

/** Security fix (onboarding task owners): shared by the database and HTTP specs. */
const DAY = 24 * 60 * 60 * 1000;
export const OWNER_MANAGE = ['onboarding.read', 'onboarding.manage'];
export const OWNER_USERS = {
  templateAdmin: [
    { permissions: ['onboarding.template.manage'], scope: 'org' as const },
  ],
  onboardingHr: [{ permissions: OWNER_MANAGE, scope: 'org' as const }],
  // A role in Org A with no permission at all: connected to the organization.
  roleA: [{ permissions: [], scope: 'org' as const }],
  // A role in Org B only.
  roleB: [{ permissions: [], scope: 'orgB' as const }],
};

/** Accounts in and around Org A for task-owner checks, and a newcomer whose manager is in Org B. */
export async function ownerPopulation(tx: Tx, fx: SchedulingFixtures) {
  const title = await tx.jobTitle.create({
    data: {
      organizationId: fx.orgB,
      name: 'B Staff',
      code: `OB-${fx.suffix}`,
    },
  });
  const positionB = (
    await tx.position.create({
      data: {
        organizationId: fx.orgB,
        jobTitleId: title.id,
        name: 'B Staff',
        code: `OPB-${fx.suffix}`,
      },
    })
  ).id;
  const positionA = await vacantPosition(tx, fx);
  const employed = async (
    label: string,
    assignments: Array<{
      positionId: string;
      status: 'ACTIVE' | 'PLANNED' | 'ENDED';
    }>,
  ) => {
    const login = await createLogin(tx, fx, label);
    const employee = await tx.employee.create({
      data: {
        personId: login.personId,
        employeeNumber: `OT-${label}-${fx.suffix}`,
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const ids: string[] = [];
    for (const [index, assignment] of assignments.entries()) {
      ids.push(
        (
          await tx.employmentAssignment.create({
            data: {
              employeeId: employee.id,
              positionId: assignment.positionId,
              employmentType: 'FULL_TIME',
              status: assignment.status,
              isPrimary: index === 0,
              startDate: new Date('2026-01-01T00:00:00.000Z'),
              ...(assignment.status === 'ENDED'
                ? { endDate: new Date('2026-06-30T00:00:00.000Z') }
                : {}),
            },
          })
        ).id,
      );
    }
    return { userId: login.id, employeeId: employee.id, assignmentIds: ids };
  };
  const roleInA = async (
    label: string,
    extra: { revokedAt?: Date; expiresAt?: Date },
  ) => {
    const login = await createLogin(tx, fx, label);
    const role = await tx.role.create({
      data: {
        organizationId: fx.orgA,
        code: `OTR-${label}-${fx.suffix}`,
        name: label,
      },
    });
    await tx.roleAssignment.create({
      data: {
        userId: login.id,
        roleId: role.id,
        roleOrganizationId: fx.orgA,
        scopeType: 'ORGANIZATION',
        organizationId: fx.orgA,
        startsAt: new Date(Date.now() - 30 * DAY),
        ...extra,
      },
    });
    return login.id;
  };

  // The System Owner (the only System-scope role) with onboarding authority.
  const system = await createLogin(tx, fx, 'otsystem');
  const owner =
    (await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
    (await tx.role.create({
      data: {
        organizationId: null,
        code: 'SYSTEM_OWNER',
        name: 'System Owner',
        isSystemOwner: true,
      },
    }));
  for (const key of [
    'onboarding.read',
    'onboarding.manage',
    'onboarding.template.manage',
  ]) {
    const permission = await tx.permission.upsert({
      where: { key },
      create: { key, name: key, isActive: true },
      update: { isActive: true },
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: owner.id,
          permissionId: permission.id,
        },
      },
      create: { roleId: owner.id, permissionId: permission.id },
      update: {},
    });
  }
  await tx.roleAssignment.create({
    data: { userId: system.id, roleId: owner.id, scopeType: 'SYSTEM' },
  });

  // The employee being onboarded, with a manager who works in Org B.
  const newcomer = await employed('newcomer', [
    { positionId: positionA, status: 'PLANNED' },
  ]);
  const managerB = await employed('managerb', [
    { positionId: positionB, status: 'ACTIVE' },
  ]);
  await tx.employmentAssignment.update({
    where: { id: newcomer.assignmentIds[0]! },
    data: { managerAssignmentId: managerB.assignmentIds[0]! },
  });
  const inactive = await employed('inactivea', [
    { positionId: fx.positionTeamA, status: 'ACTIVE' },
  ]);
  await tx.user.update({
    where: { id: inactive.userId },
    data: { status: 'DISABLED' },
  });

  return {
    system: system.id,
    newcomer,
    newcomerAssignment: newcomer.assignmentIds[0]!,
    managerB: managerB.userId,
    employedA: (
      await employed('employeda', [
        { positionId: fx.positionTeamA, status: 'ACTIVE' },
      ])
    ).userId,
    plannedA: (
      await employed('planneda', [
        { positionId: fx.positionTeamA, status: 'PLANNED' },
      ])
    ).userId,
    bothAB: (
      await employed('bothab', [
        { positionId: positionB, status: 'ACTIVE' },
        { positionId: fx.positionTeamA, status: 'ACTIVE' },
      ])
    ).userId,
    outsiderB: (
      await employed('outsiderb', [{ positionId: positionB, status: 'ACTIVE' }])
    ).userId,
    endedA: (
      await employed('endeda', [
        { positionId: fx.positionTeamA, status: 'ENDED' },
      ])
    ).userId,
    revokedA: await roleInA('revokeda', {
      revokedAt: new Date(Date.now() - DAY),
    }),
    expiredA: await roleInA('expireda', {
      expiresAt: new Date(Date.now() - DAY),
    }),
    inactiveA: inactive.userId,
    unknown: '00000000-0000-4000-8000-0000000000aa',
  };
}

/** A template of Org A: an HR task, then one specific-user task per owner. */
export const ownerTemplate = (
  fx: SchedulingFixtures,
  code: string,
  owners: string[],
) => ({
  organizationId: fx.orgA,
  kind: 'ONBOARDING' as const,
  code,
  name: `Template ${code}`,
  tasks: [
    {
      title: 'Paperwork',
      category: 'PAPERWORK' as const,
      ownerType: 'HR' as const,
      dueOffsetDays: 0,
    },
    ...owners.map((ownerUserId, index) => ({
      title: `Owned task ${index}`,
      category: 'ACCOUNT_ACCESS' as const,
      ownerType: 'SPECIFIC_USER' as const,
      ownerUserId,
      dueOffsetDays: 1,
    })),
  ],
});

/** A saved template's tasks as the editor sends them back: each with its id. */
export const savedTasks = (template: {
  tasks: Array<{
    id: string;
    title: string;
    category: string;
    ownerType: 'EMPLOYEE' | 'MANAGER' | 'HR' | 'SPECIFIC_USER';
    ownerUserId: string | null;
    dueOffsetDays: number;
  }>;
}) =>
  template.tasks.map(
    ({ id, title, category, ownerType, ownerUserId, dueOffsetDays }) => ({
      id,
      title,
      category,
      ownerType,
      ownerUserId,
      dueOffsetDays,
    }),
  );
