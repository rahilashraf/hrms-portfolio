import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/database/prisma.service.js';

config({ path: '../../.env' });

interface Fixtures {
  userId: string;
  organizationId: string;
  otherOrganizationId: string;
  organizationalUnitId: string;
  otherOrganizationalUnitId: string;
  departmentId: string;
  teamId: string;
  roleId: string;
  systemOwnerRoleId: string;
}

describe('RBAC database integrity constraints', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required to run API database tests.');
    }
    prisma = new PrismaService(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('accepts each organizational scope representation', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createFixtures(tx);
        await tx.roleAssignment.createMany({
          data: [
            {
              userId: fixtures.userId,
              roleId: fixtures.roleId,
              roleOrganizationId: fixtures.organizationId,
              scopeType: 'ORGANIZATION',
              organizationId: fixtures.organizationId,
            },
            {
              userId: fixtures.userId,
              roleId: fixtures.roleId,
              roleOrganizationId: fixtures.organizationId,
              scopeType: 'ORGANIZATIONAL_UNIT',
              organizationId: fixtures.organizationId,
              organizationalUnitId: fixtures.organizationalUnitId,
            },
            {
              userId: fixtures.userId,
              roleId: fixtures.roleId,
              roleOrganizationId: fixtures.organizationId,
              scopeType: 'DEPARTMENT',
              organizationId: fixtures.organizationId,
              departmentId: fixtures.departmentId,
            },
            {
              userId: fixtures.userId,
              roleId: fixtures.roleId,
              roleOrganizationId: fixtures.organizationId,
              scopeType: 'TEAM',
              organizationId: fixtures.organizationId,
              teamId: fixtures.teamId,
            },
            {
              userId: fixtures.userId,
              roleId: fixtures.systemOwnerRoleId,
              roleOrganizationId: null,
              scopeType: 'SYSTEM',
              organizationId: null,
              organizationalUnitId: null,
              departmentId: null,
              teamId: null,
            },
          ],
        });
        throw new RollbackFixtures();
      }),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });

  it.each([
    [
      'missing organizational unit target',
      (f: Fixtures) => ({
        scopeType: 'ORGANIZATIONAL_UNIT' as const,
        organizationId: f.organizationId,
        organizationalUnitId: randomUUID(),
      }),
    ],
    [
      'multiple scope targets',
      (f: Fixtures) => ({
        scopeType: 'DEPARTMENT' as const,
        organizationId: f.organizationId,
        departmentId: f.departmentId,
        teamId: f.teamId,
      }),
    ],
    [
      'wrong target for scope type',
      (f: Fixtures) => ({
        scopeType: 'TEAM' as const,
        organizationId: f.organizationId,
        departmentId: f.departmentId,
      }),
    ],
    [
      'cross-organization structural target',
      (f: Fixtures) => ({
        scopeType: 'ORGANIZATIONAL_UNIT' as const,
        organizationId: f.organizationId,
        organizationalUnitId: f.otherOrganizationalUnitId,
      }),
    ],
    [
      'role and assignment organization mismatch',
      (f: Fixtures) => ({
        scopeType: 'ORGANIZATION' as const,
        organizationId: f.otherOrganizationId,
      }),
    ],
  ])('rejects %s at the database boundary', async (_caseName, scopeData) => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createFixtures(tx);
        const target = scopeData(fixtures);
        await tx.roleAssignment.create({
          data: {
            userId: fixtures.userId,
            roleId: fixtures.roleId,
            roleOrganizationId: fixtures.organizationId,
            ...target,
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2003|2004|2010|2039)$/),
    });
  });

  it.each([
    ['organization', (f: Fixtures) => ({ organizationId: f.organizationId })],
    [
      'organizational unit',
      (f: Fixtures) => ({
        organizationalUnitId: f.organizationalUnitId,
      }),
    ],
    ['department', (f: Fixtures) => ({ departmentId: f.departmentId })],
    ['team', (f: Fixtures) => ({ teamId: f.teamId })],
  ])('rejects a SYSTEM scope with a %s target', async (_target, target) => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createFixtures(tx);
        await tx.roleAssignment.create({
          data: {
            userId: fixtures.userId,
            roleId: fixtures.systemOwnerRoleId,
            roleOrganizationId: null,
            scopeType: 'SYSTEM',
            ...target(fixtures),
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2003|2004|2010|2039)$/),
    });
  });

  it('rejects expiration that is not later than the start', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createFixtures(tx);
        const startsAt = new Date('2026-01-01T00:00:00.000Z');
        await tx.roleAssignment.create({
          data: {
            userId: fixtures.userId,
            roleId: fixtures.roleId,
            roleOrganizationId: fixtures.organizationId,
            scopeType: 'ORGANIZATION',
            organizationId: fixtures.organizationId,
            startsAt,
            expiresAt: startsAt,
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2003|2004|2010|2039)$/),
    });
  });

  it('restricts deletion of referenced role history', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createFixtures(tx);
        await tx.roleAssignment.create({
          data: {
            userId: fixtures.userId,
            roleId: fixtures.roleId,
            roleOrganizationId: fixtures.organizationId,
            scopeType: 'ORGANIZATION',
            organizationId: fixtures.organizationId,
          },
        });
        await tx.role.delete({ where: { id: fixtures.roleId } });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2003|2004|2010|2039)$/),
    });
  });
});

async function createFixtures(tx: Prisma.TransactionClient): Promise<Fixtures> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const person = await tx.person.create({ data: {} });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `phase4-${suffix}@example.invalid`,
      status: 'ACTIVE',
    },
  });
  const organization = await tx.organization.create({
    data: { name: 'RBAC integrity test', code: `RBAC-${suffix}` },
  });
  const otherOrganization = await tx.organization.create({
    data: { name: 'RBAC integrity test other', code: `OTHER-${suffix}` },
  });
  const unit = await tx.organizationalUnit.create({
    data: {
      organizationId: organization.id,
      name: 'Unit',
      code: `UNIT-${suffix}`,
    },
  });
  const otherUnit = await tx.organizationalUnit.create({
    data: {
      organizationId: otherOrganization.id,
      name: 'Other Unit',
      code: `OTHER-UNIT-${suffix}`,
    },
  });
  const department = await tx.department.create({
    data: {
      organizationId: organization.id,
      organizationalUnitId: unit.id,
      name: 'Department',
      code: `DEPT-${suffix}`,
    },
  });
  const team = await tx.team.create({
    data: {
      organizationId: organization.id,
      departmentId: department.id,
      name: 'Team',
      code: `TEAM-${suffix}`,
    },
  });
  const role = await tx.role.create({
    data: {
      organizationId: organization.id,
      code: `RBAC-${suffix}`,
      name: 'RBAC test role',
    },
  });
  const systemOwnerRole = await tx.role.create({
    data: {
      organizationId: null,
      code: 'SYSTEM_OWNER',
      name: 'System Owner',
      isSystemOwner: true,
    },
  });

  return {
    userId: user.id,
    organizationId: organization.id,
    otherOrganizationId: otherOrganization.id,
    organizationalUnitId: unit.id,
    otherOrganizationalUnitId: otherUnit.id,
    departmentId: department.id,
    teamId: team.id,
    roleId: role.id,
    systemOwnerRoleId: systemOwnerRole.id,
  };
}

class RollbackFixtures extends Error {}
