import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { createLogin, statusOf } from './support/auth-fixtures.js';
import {
  createSchedulingFixtures,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const ASSIGN = ['role.assign', 'time.clock'];
const USERS = {
  assignA: [{ permissions: ASSIGN, scope: 'org' as const }],
  assignB: [{ permissions: ASSIGN, scope: 'orgB' as const }],
  assignBoth: [
    { permissions: ASSIGN, scope: 'org' as const },
    { permissions: ASSIGN, scope: 'orgB' as const },
  ],
  assignDeptA: [{ permissions: ASSIGN, scope: 'deptA' as const }],
};
const DAY = 24 * 60 * 60 * 1000;

/**
 * Tenant isolation of the role-assignment user search (GET /authorization/users) and of role
 * assignment itself: an organization's administrator finds and assigns only accounts connected
 * to an organization they administer (employment or a current role there); System-scope
 * administrators keep the whole directory.
 */
describe('Role assignment user search isolation (database)', () => {
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
      roles: RoleManagementService;
      people: Awaited<ReturnType<typeof population>>;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const client = rollbackClient(tx);
          const roles = new RoleManagementService(
            client,
            new AuthorizationService(client),
            new AuditService(client),
          );
          await run({ tx, fx, roles, people: await population(tx, fx) }).catch(
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

  async function employeeLogin(
    tx: Tx,
    fx: SchedulingFixtures,
    label: string,
    positionId: string,
    status: 'ACTIVE' | 'PLANNED' | 'ENDED',
    options: { invited?: boolean } = {},
  ) {
    const account = await createLogin(tx, fx, label);
    if (options.invited)
      await tx.user.update({
        where: { id: account.id },
        data: { status: 'INVITED' },
      });
    const employee = await tx.employee.create({
      data: {
        personId: account.personId,
        employeeNumber: `US-${label}-${fx.suffix}`,
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await tx.employmentAssignment.create({
      data: {
        employeeId: employee.id,
        positionId,
        employmentType: 'FULL_TIME',
        status,
        isPrimary: true,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        ...(status === 'ENDED'
          ? { endDate: new Date('2026-06-30T00:00:00.000Z') }
          : {}),
      },
    });
    return account.id;
  }

  /** Accounts in organization A, organization B and neither, plus a System-scope assigner. */
  async function population(tx: Tx, fx: SchedulingFixtures) {
    const title = await tx.jobTitle.create({
      data: {
        organizationId: fx.orgB,
        name: 'B Staff',
        code: `UB-${fx.suffix}`,
      },
    });
    const positionB = (
      await tx.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: title.id,
          name: 'B Staff',
          code: `UPB-${fx.suffix}`,
        },
      })
    ).id;
    const roleInB = await tx.role.create({
      data: {
        organizationId: fx.orgB,
        code: `UROLE-B-${fx.suffix}`,
        name: 'B helper',
      },
    });
    const withRoleInB = async (
      label: string,
      extra: { expiresAt?: Date; revokedAt?: Date } = {},
    ) => {
      const account = await createLogin(tx, fx, label);
      await tx.roleAssignment.create({
        data: {
          userId: account.id,
          roleId: roleInB.id,
          roleOrganizationId: fx.orgB,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgB,
          startsAt: new Date(Date.now() - 30 * DAY),
          ...extra,
        },
      });
      return account.id;
    };

    const system = await createLogin(tx, fx, 'sysassign');
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
    for (const key of ASSIGN) {
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

    return {
      positionB,
      system: system.id,
      activeA: await employeeLogin(
        tx,
        fx,
        'activea',
        fx.positionTeamA,
        'ACTIVE',
      ),
      plannedA: await employeeLogin(
        tx,
        fx,
        'planneda',
        fx.positionTeamA,
        'PLANNED',
      ),
      invitedA: await employeeLogin(
        tx,
        fx,
        'inviteda',
        fx.positionTeamA,
        'ACTIVE',
        {
          invited: true,
        },
      ),
      endedA: await employeeLogin(tx, fx, 'endeda', fx.positionTeamA, 'ENDED'),
      activeB: await employeeLogin(tx, fx, 'activeb', positionB, 'ACTIVE'),
      adminB: await withRoleInB('adminb'),
      expiredB: await withRoleInB('expiredb', {
        expiresAt: new Date(Date.now() - DAY),
      }),
      revokedB: await withRoleInB('revokedb', {
        revokedAt: new Date(Date.now() - DAY),
      }),
      unconnected: (await createLogin(tx, fx, 'loose')).id,
    };
  }

  /** Every account an actor finds for this fixture, following the cursor through all pages. */
  async function found(
    roles: RoleManagementService,
    actor: string,
    organizationId: string,
    term: string,
    limit = 100,
  ) {
    const ids: string[] = [];
    let afterId: string | undefined;
    do {
      const page = await roles.searchActiveUsers(
        actor,
        organizationId,
        term,
        limit,
        afterId,
      );
      ids.push(...page.items.map((item) => item.id));
      afterId = page.nextCursor ?? undefined;
    } while (afterId);
    return new Set(ids);
  }

  it('finds only accounts connected to an organization the searcher administers', async () => {
    await scenario(async ({ fx, roles, people }) => {
      const term = fx.suffix;
      const everyone = Object.values(people).filter(
        (value) => value !== people.positionB,
      );
      const visible = async (actor: string, organizationId: string) => {
        const ids = await found(roles, actor, organizationId, term);
        return new Set(everyone.filter((id) => ids.has(id)));
      };

      // Organization A's administrator: A's current, planned and invited employees only.
      expect(await visible(fx.users.assignA!, fx.orgA)).toEqual(
        new Set([people.activeA, people.plannedA, people.invitedA]),
      );
      // Organization B's administrator: B's employee and B's role holder; not an expired or
      // revoked role, nobody from A, nobody unconnected.
      expect(await visible(fx.users.assignB!, fx.orgB)).toEqual(
        new Set([people.activeB, people.adminB]),
      );
      // An administrator of both may appoint a person from one organization in the other.
      const bothSeen = await visible(fx.users.assignBoth!, fx.orgA);
      expect(bothSeen).toEqual(
        new Set([
          people.activeA,
          people.plannedA,
          people.invitedA,
          people.activeB,
          people.adminB,
        ]),
      );
      // A System-scope administrator keeps the whole directory, including unconnected
      // accounts (but never disabled or archived ones: unchanged).
      expect(await visible(people.system, fx.orgA)).toEqual(
        new Set([
          people.system,
          people.activeA,
          people.plannedA,
          people.invitedA,
          people.endedA,
          people.activeB,
          people.adminB,
          people.expiredB,
          people.revokedB,
          people.unconnected,
        ]),
      );

      // Searching by another organization's email, number or name finds nothing.
      for (const query of [
        `b2-activeb-${fx.suffix.toLowerCase()}@example.com`,
        `US-activeb-${fx.suffix}`,
        'loose',
      ])
        expect(
          (await roles.searchActiveUsers(fx.users.assignA!, fx.orgA, query))
            .items,
        ).toEqual([]);

      // Paging (one account per page) returns the same restricted set.
      const paged = await found(roles, fx.users.assignB!, fx.orgB, term, 1);
      expect(new Set(everyone.filter((id) => paged.has(id)))).toEqual(
        new Set([people.activeB, people.adminB]),
      );

      // Unchanged: searching an organization one does not administer is refused.
      expect(
        statusOf(
          await rejection(
            roles.searchActiveUsers(fx.users.assignA!, fx.orgB, term),
          ),
        ),
      ).toBe(403);
    });
  });

  it('assigns roles only to accounts the administrator could find, and answers others like unknown accounts', async () => {
    await scenario(async ({ tx, fx, roles, people }) => {
      const permission = await tx.permission.findUniqueOrThrow({
        where: { key: 'time.clock' },
      });
      const roleInA = await tx.role.create({
        data: {
          organizationId: fx.orgA,
          code: `UROLE-A-${fx.suffix}`,
          name: 'A clocker',
        },
      });
      await tx.rolePermission.create({
        data: { roleId: roleInA.id, permissionId: permission.id },
      });
      const orgA = { type: 'ORGANIZATION' as const, id: fx.orgA };
      const deptA = { type: 'DEPARTMENT' as const, id: fx.deptA };
      const assign = (
        actor: string,
        userId: string,
        scope: { type: 'ORGANIZATION' | 'DEPARTMENT'; id: string } = orgA,
      ) =>
        roles.createAssignment(
          actor,
          { userId, roleId: roleInA.id, scope },
          { actorUserId: actor },
        );
      const refusal = async (promise: Promise<unknown>) => {
        const error = (await rejection(promise)) as Error;
        return [statusOf(error), error.message];
      };
      const unknown = await refusal(
        assign(fx.users.assignA!, '00000000-0000-4000-8000-0000000000ff'),
      );
      expect(unknown).toEqual([404, 'Active or invited user not found']);

      // In scope: an employee of A (an invited one too, granting nothing until activation).
      await assign(fx.users.assignA!, people.activeA);
      await assign(fx.users.assignA!, people.invitedA);
      // Out of scope: another organization's employee or role holder, an unconnected account,
      // an ended employment. The answer is the same as for an account that does not exist.
      for (const outside of [
        people.activeB,
        people.adminB,
        people.unconnected,
        people.endedA,
      ])
        expect(await refusal(assign(fx.users.assignA!, outside))).toEqual(
          unknown,
        );

      // A department-scoped administrator assigns within their organization, not outside it.
      await assign(fx.users.assignDeptA!, people.plannedA, deptA);
      expect(
        await refusal(assign(fx.users.assignDeptA!, people.activeB, deptA)),
      ).toEqual(unknown);

      // An administrator of both organizations appoints B's role holder in A.
      await assign(fx.users.assignBoth!, people.adminB);
      // A System-scope administrator may assign anyone active or invited.
      await assign(people.system, people.unconnected);

      // Unchanged: without role.assign in A, nothing is assigned, whoever the account is.
      expect(
        statusOf(await rejection(assign(fx.users.assignB!, people.activeB))),
      ).toBe(403);
      expect(
        await tx.roleAssignment.count({ where: { roleId: roleInA.id } }),
      ).toBe(5);
    });
  });
});
