import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/database/prisma.service.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

interface OrgHierarchy {
  organizationId: string;
  organizationalUnitId: string;
  departmentId: string;
  teamId: string;
}

interface SchedulingFixtures {
  org: OrgHierarchy;
  otherOrg: OrgHierarchy;
}

type ScheduleScopeData = Pick<
  Prisma.ScheduleUncheckedCreateInput,
  | 'scopeType'
  | 'organizationId'
  | 'organizationalUnitId'
  | 'departmentId'
  | 'teamId'
>;

const CHECK_VIOLATION = { code: expect.stringMatching(/^P(2004|2010|2039)$/) };
const FK_VIOLATION = { code: expect.stringMatching(/^P(2003|2010)$/) };

describe('Scheduling database integrity constraints', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required.');
    prisma = new PrismaService(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function createSchedule(
    tx: Prisma.TransactionClient,
    scope: ScheduleScopeData,
  ) {
    return tx.schedule.create({
      data: {
        ...scope,
        name: 'Week 41',
        periodStart: new Date('2026-10-05T00:00:00.000Z'),
        periodEnd: new Date('2026-10-11T00:00:00.000Z'),
        type: 'STANDARD',
      },
    });
  }

  async function expectScopeAccepted(
    build: (fixtures: SchedulingFixtures) => ScheduleScopeData,
  ) {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createSchedulingFixtures(tx);
        const schedule = await createSchedule(tx, build(fixtures));
        expect(schedule.scopeType).toBe(build(fixtures).scopeType);
        throw new RollbackFixtures();
      }),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  async function expectScopeRejected(
    build: (fixtures: SchedulingFixtures) => ScheduleScopeData,
    error: object,
  ) {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createSchedulingFixtures(tx);
        await createSchedule(tx, build(fixtures));
      }),
    ).rejects.toMatchObject(error);
  }

  it('accepts each scope type with its matching hierarchy target', async () => {
    await expectScopeAccepted(({ org }) => ({
      scopeType: 'ORGANIZATION',
      organizationId: org.organizationId,
    }));
    await expectScopeAccepted(({ org }) => ({
      scopeType: 'ORGANIZATIONAL_UNIT',
      organizationId: org.organizationId,
      organizationalUnitId: org.organizationalUnitId,
    }));
    await expectScopeAccepted(({ org }) => ({
      scopeType: 'DEPARTMENT',
      organizationId: org.organizationId,
      departmentId: org.departmentId,
    }));
    await expectScopeAccepted(({ org }) => ({
      scopeType: 'TEAM',
      organizationId: org.organizationId,
      teamId: org.teamId,
    }));
  });

  it('rejects scope types whose hierarchy columns contradict them', async () => {
    await expectScopeRejected(
      ({ org }) => ({
        scopeType: 'ORGANIZATION',
        organizationId: org.organizationId,
        teamId: org.teamId,
      }),
      CHECK_VIOLATION,
    );
    await expectScopeRejected(
      ({ org }) => ({
        scopeType: 'ORGANIZATIONAL_UNIT',
        organizationId: org.organizationId,
      }),
      CHECK_VIOLATION,
    );
    await expectScopeRejected(
      ({ org }) => ({
        scopeType: 'DEPARTMENT',
        organizationId: org.organizationId,
        organizationalUnitId: org.organizationalUnitId,
      }),
      CHECK_VIOLATION,
    );
    await expectScopeRejected(
      ({ org }) => ({
        scopeType: 'DEPARTMENT',
        organizationId: org.organizationId,
        departmentId: org.departmentId,
        teamId: org.teamId,
      }),
      CHECK_VIOLATION,
    );
    await expectScopeRejected(
      ({ org }) => ({
        scopeType: 'TEAM',
        organizationId: org.organizationId,
        departmentId: org.departmentId,
      }),
      CHECK_VIOLATION,
    );
  });

  it('rejects scope targets that belong to another organization', async () => {
    await expectScopeRejected(
      ({ org, otherOrg }) => ({
        scopeType: 'ORGANIZATIONAL_UNIT',
        organizationId: org.organizationId,
        organizationalUnitId: otherOrg.organizationalUnitId,
      }),
      FK_VIOLATION,
    );
    await expectScopeRejected(
      ({ org, otherOrg }) => ({
        scopeType: 'DEPARTMENT',
        organizationId: org.organizationId,
        departmentId: otherOrg.departmentId,
      }),
      FK_VIOLATION,
    );
    await expectScopeRejected(
      ({ org, otherOrg }) => ({
        scopeType: 'TEAM',
        organizationId: org.organizationId,
        teamId: otherOrg.teamId,
      }),
      FK_VIOLATION,
    );
  });
});

async function createSchedulingFixtures(
  tx: Prisma.TransactionClient,
): Promise<SchedulingFixtures> {
  return {
    org: await createOrgHierarchy(tx),
    otherOrg: await createOrgHierarchy(tx),
  };
}

async function createOrgHierarchy(
  tx: Prisma.TransactionClient,
): Promise<OrgHierarchy> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const organization = await tx.organization.create({
    data: { name: 'Scheduling Test Org', code: `SCHED-${suffix}` },
  });
  const unit = await tx.organizationalUnit.create({
    data: {
      organizationId: organization.id,
      name: 'Scheduling Unit',
      code: `UNIT-${suffix}`,
    },
  });
  const department = await tx.department.create({
    data: {
      organizationId: organization.id,
      organizationalUnitId: unit.id,
      name: 'Scheduling Department',
      code: `DEPT-${suffix}`,
    },
  });
  const team = await tx.team.create({
    data: {
      organizationId: organization.id,
      departmentId: department.id,
      name: 'Scheduling Team',
      code: `TEAM-${suffix}`,
    },
  });
  return {
    organizationId: organization.id,
    organizationalUnitId: unit.id,
    departmentId: department.id,
    teamId: team.id,
  };
}
