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
import type { CreateAuditLogInput } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { AccountEmailService } from '../src/auth/account-email.service.js';
import { AccountTokenService } from '../src/auth/account-token.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeAccountService } from '../src/employee/employee-account.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
  type UserSpec,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

const ADMIN = [
  'employee.manage',
  'employee.read',
  'role.read',
  'role.assign',
  'role.manage',
  'employee.account.manage',
];
const USERS: Record<string, UserSpec[]> = {
  hrA: [{ permissions: ADMIN, scope: 'org' }],
  hrA2: [{ permissions: ADMIN, scope: 'org' }],
  self2: [{ permissions: ['time.clock'], scope: 'org' }],
};

/** An audit service that fails the n-th write of one action (an infrastructure failure). */
class FailingAudit extends AuditService {
  private seen = 0;
  constructor(
    prisma: PrismaService,
    private readonly action: string,
    private readonly failOn: number,
  ) {
    super(prisma);
  }
  override async write(
    input: CreateAuditLogInput,
    client?: Parameters<AuditService['write']>[1],
  ) {
    if (input.action === this.action && ++this.seen === this.failOn)
      throw new Error(`injected failure writing ${input.action}`);
    return super.write(input, client);
  }
  override async writeForOrganizations(
    input: CreateAuditLogInput,
    organizationIds: readonly string[],
    client?: Parameters<AuditService['writeForOrganizations']>[2],
  ) {
    if (input.action === this.action && ++this.seen === this.failOn)
      throw new Error(`injected failure writing ${input.action}`);
    return super.writeForOrganizations(input, organizationIds, client);
  }
}

/** Invitation cancellation sends nothing; any other email use is a test error. */
class NoEmails extends AccountEmailService {
  assertAvailable() {}
  sendPasswordReset(): Promise<void> {
    throw new Error('unexpected email');
  }
  sendInvitation(): Promise<void> {
    throw new Error('unexpected email');
  }
  sendVerification(): Promise<void> {
    throw new Error('unexpected email');
  }
}

function accountService(client: PrismaService, audit?: AuditService) {
  const used = audit ?? new AuditService(client);
  return new EmployeeAccountService(
    client,
    new AuthorizationService(client),
    new PositionAuthorizationTargetResolver(client),
    used,
    new AccountTokenService(client, used),
    new NoEmails(),
  );
}

function services(
  client: PrismaService,
  options: { rolesAudit?: AuditService; lifecycleAudit?: AuditService } = {},
) {
  const authorization = new AuthorizationService(client);
  const audit = new AuditService(client);
  const lifecycleAudit = options.lifecycleAudit ?? audit;
  const access = new EmployeeAccessService(
    client,
    authorization,
    new PositionAuthorizationTargetResolver(client),
    lifecycleAudit,
  );
  const roles = new RoleManagementService(
    client,
    authorization,
    options.rolesAudit ?? audit,
  );
  const lifecycle = new EmployeeLifecycleService(
    client,
    new EmployeeDomainService(client, lifecycleAudit),
    access,
    authorization,
    lifecycleAudit,
    roles,
  );
  return { lifecycle, roles };
}

/**
 * Batch 5E (E-1, E-3) — grant revocation on committed data (separate connections, like
 * production). Revoking an employee's grants is one transaction: the lifecycle lock, the grant
 * rows locked in id order, every authorization check, each revocation and its audit, and the
 * login disable all commit or roll back together. Every path that revokes a grant (lifecycle
 * revocation, the Roles API, archiving a role, cancelling an invitation) locks grant rows in id
 * order and revokes with a conditional update, so a grant is revoked exactly once and counted in
 * exactly one audit entry.
 */
describe('Batch 5E: grant revocation atomicity and races (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures | undefined;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  beforeEach(async () => {
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, USERS, ADMIN),
      { timeout: 60_000 },
    );
  });
  afterEach(async () => {
    if (fx) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        // Only this test's entries: the roles and grants of its fixture organization. (Other
        // database specs run in parallel and audit their own grants, some with no actor, such as
        // the worker's automatic revocations; a filter on entity type and actor alone deleted
        // those committed entries too.)
        const roleIds = (
          await tx.role.findMany({
            where: { organizationId: fx!.orgA },
            select: { id: true },
          })
        ).map((row) => row.id);
        const grantIds = (
          await tx.roleAssignment.findMany({
            where: {
              OR: [{ roleId: { in: roleIds } }, { organizationId: fx!.orgA }],
            },
            select: { id: true },
          })
        ).map((row) => row.id);
        await tx.auditLog.deleteMany({
          where: {
            OR: [
              { entityId: { in: [fx!.employee1, fx!.employee2] } },
              {
                entityType: { in: ['RoleAssignment', 'Role'] },
                entityId: { in: [...roleIds, ...grantIds] },
              },
              {
                entityType: { in: ['RoleAssignment', 'Role'] },
                metadata: { path: ['organizationId'], equals: fx!.orgA },
              },
            ],
          },
        });
      });
      await cleanupSchedulingFixtures(prisma, fx);
      fx = undefined;
    }
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /** Extra organization-A grants for Employee 2's login (cleaned with the organization). */
  async function grants(count: number, keys = ['time.clock']) {
    const f = fx!;
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const role = await prisma.role.create({
        data: {
          organizationId: f.orgA,
          code: `5E-${f.suffix}-${index}-${Math.random().toString(36).slice(2, 6)}`,
          name: '5E grant',
        },
      });
      for (const key of keys) {
        const permission = await prisma.permission.findUniqueOrThrow({
          where: { key },
        });
        await prisma.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
      }
      ids.push(
        (
          await prisma.roleAssignment.create({
            data: {
              userId: f.selfUser2,
              roleId: role.id,
              roleOrganizationId: f.orgA,
              scopeType: 'ORGANIZATION',
              organizationId: f.orgA,
            },
          })
        ).id,
      );
    }
    return ids;
  }
  const liveCount = async (ids: string[]) =>
    prisma.roleAssignment.count({
      where: { id: { in: ids }, revokedAt: null },
    });
  const auditsOf = async (ids: string[]) =>
    prisma.auditLog.count({
      where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: { in: ids } },
    });

  it('E-1: an infrastructure failure on the second revocation leaves every grant in place, with no audit', async () => {
    const f = fx!;
    const ids = await grants(3);
    const { lifecycle } = services(prisma, {
      rolesAudit: new FailingAudit(prisma, 'ROLE_ASSIGNMENT_REVOKED', 2),
    });
    await expect(
      lifecycle.revokeGrants(
        f.employee2,
        { roleAssignmentIds: ids },
        ctx(f.users.hrA!),
      ),
    ).rejects.toThrow(/injected failure/);
    expect(await liveCount(ids)).toBe(3);
    expect(await auditsOf(ids)).toBe(0);
  });

  it('E-1: a failure while disabling the login of a terminated employee rolls back the revocations too', async () => {
    const f = fx!;
    await prisma.employee.update({
      where: { id: f.employee2 },
      data: {
        status: 'TERMINATED',
        terminationDate: new Date('2026-01-31T00:00:00.000Z'),
      },
    });
    const all = (
      await prisma.roleAssignment.findMany({
        where: { userId: f.selfUser2, revokedAt: null },
      })
    ).map((row) => row.id);
    const { lifecycle } = services(prisma, {
      lifecycleAudit: new FailingAudit(prisma, 'EMPLOYEE_ACCOUNT_DISABLED', 1),
    });
    await expect(
      lifecycle.revokeGrants(
        f.employee2,
        { roleAssignmentIds: all },
        ctx(f.users.hrA!),
      ),
    ).rejects.toThrow(/injected failure/);
    expect(await liveCount(all)).toBe(all.length);
    expect(await auditsOf(all)).toBe(0);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: f.selfUser2 } }))
        .status,
    ).toBe('ACTIVE');
    // Without the failure, everything commits together: grants revoked, login disabled.
    const ok = await services(prisma).lifecycle.revokeGrants(
      f.employee2,
      { roleAssignmentIds: all },
      ctx(f.users.hrA!),
    );
    expect(ok).toMatchObject({ loginDisabled: true });
    expect(await liveCount(all)).toBe(0);
  });

  it('E-3: the same grants revoked at once from two lifecycle requests and two Roles API calls are revoked and audited exactly once each', async () => {
    const f = fx!;
    const ids = await grants(4);
    const { lifecycle, roles } = services(prisma);
    const outcomes = await Promise.allSettled([
      lifecycle.revokeGrants(
        f.employee2,
        { roleAssignmentIds: ids },
        ctx(f.users.hrA!),
      ),
      lifecycle.revokeGrants(
        f.employee2,
        { roleAssignmentIds: [...ids].reverse() },
        ctx(f.users.hrA2!),
      ),
      ...ids.map((id) => roles.revokeAssignment(f.users.hrA!, id, undefined)),
      ...ids.map((id) => roles.revokeAssignment(f.users.hrA2!, id, undefined)),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(
      outcomes.map(() => 'fulfilled'),
    );
    expect(await liveCount(ids)).toBe(0);
    for (const id of ids) expect(await auditsOf([id])).toBe(1);
    // Each lifecycle response accounts for every requested grant, once.
    for (const outcome of outcomes.slice(0, 2)) {
      const value = (
        outcome as PromiseFulfilledResult<{
          revoked: string[];
          alreadyRevoked: string[];
        }>
      ).value;
      expect([...value.revoked, ...value.alreadyRevoked].sort()).toEqual(
        [...ids].sort(),
      );
    }
  });

  it('E-3: archiving a role while its grant is revoked: one revocation, one audit, no deadlock', async () => {
    const f = fx!;
    const ids = await grants(2);
    const roleIds = (
      await prisma.roleAssignment.findMany({ where: { id: { in: ids } } })
    ).map((row) => row.roleId);
    const { lifecycle, roles } = services(prisma);
    const outcomes = await Promise.allSettled([
      lifecycle.revokeGrants(
        f.employee2,
        { roleAssignmentIds: ids },
        ctx(f.users.hrA!),
      ),
      roles.archiveRole(f.users.hrA2!, roleIds[0]!),
      roles.archiveRole(f.users.hrA2!, roleIds[1]!),
      roles.archiveRole(f.users.hrA!, roleIds[1]!),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(
      outcomes.map(() => 'fulfilled'),
    );
    expect(await liveCount(ids)).toBe(0);
    for (const id of ids) expect(await auditsOf([id])).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ROLE_ARCHIVED', entityId: roleIds[1]! },
      }),
    ).toBe(1);
  });

  it('E-1/E-3: a batch racing the removal of the caller’s own role.assign is applied entirely or not at all', async () => {
    const f = fx!;
    for (let round = 0; round < 3; round += 1) {
      const ids = await grants(3);
      // A dedicated role.assign grant for hrA2, removed by hrA while hrA2 revokes.
      const [assigner] = await (async () => {
        const role = await prisma.role.create({
          data: {
            organizationId: f.orgA,
            code: `5E-RA-${f.suffix}-${round}`,
            name: '5E assigner',
          },
        });
        for (const key of ['employee.read', 'role.assign']) {
          const permission = await prisma.permission.findUniqueOrThrow({
            where: { key },
          });
          await prisma.rolePermission.create({
            data: { roleId: role.id, permissionId: permission.id },
          });
        }
        const user = await prisma.user.create({
          data: {
            email: `5e-assigner-${round}-${f.suffix.toLowerCase()}@example.com`,
            status: 'ACTIVE',
            personId: (await prisma.person.create({ data: {} })).id,
          },
        });
        const assignment = await prisma.roleAssignment.create({
          data: {
            userId: user.id,
            roleId: role.id,
            roleOrganizationId: f.orgA,
            scopeType: 'ORGANIZATION',
            organizationId: f.orgA,
          },
        });
        return [{ userId: user.id, assignmentId: assignment.id }];
      })();
      const { lifecycle, roles } = services(prisma);
      const [batch] = await Promise.allSettled([
        lifecycle.revokeGrants(
          f.employee2,
          { roleAssignmentIds: ids },
          ctx(assigner!.userId),
        ),
        roles.revokeAssignment(f.users.hrA!, assigner!.assignmentId, undefined),
      ]);
      const remaining = await liveCount(ids);
      if (batch.status === 'fulfilled') expect(remaining).toBe(0);
      else expect(remaining).toBe(3);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.auditLog.deleteMany({
          where: { actorUserId: assigner!.userId },
        });
        await tx.roleAssignment.deleteMany({
          where: { userId: assigner!.userId },
        });
        const user = await tx.user.delete({
          where: { id: assigner!.userId },
        });
        await tx.person.delete({ where: { id: user.personId! } });
      });
    }
  });
  /**
   * Employee 2's login becomes a pending invitation holding three extra grants. They are created
   * highest id first, with the earliest start for the highest id, so a scan by insertion order or
   * by the (userId, revokedAt, startsAt) index meets them in descending id order.
   */
  async function invitedWithGrants() {
    const f = fx!;
    await prisma.user.update({
      where: { id: f.selfUser2 },
      data: { status: 'INVITED', passwordHash: null },
    });
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'time.clock' },
    });
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort(
      (a, b) => (a < b ? 1 : -1),
    );
    for (const [index, id] of ids.entries()) {
      const role = await prisma.role.create({
        data: {
          organizationId: f.orgA,
          code: `5E-INV-${f.suffix}-${index}`,
          name: '5E invited grant',
        },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      await prisma.roleAssignment.create({
        data: {
          id,
          userId: f.selfUser2,
          roleId: role.id,
          roleOrganizationId: f.orgA,
          scopeType: 'ORGANIZATION',
          organizationId: f.orgA,
          startsAt: new Date(Date.UTC(2020, 0, 1 + index)),
        },
      });
    }
    const all = (
      await prisma.roleAssignment.findMany({
        where: { userId: f.selfUser2, revokedAt: null },
        select: { id: true },
      })
    )
      .map((row) => row.id)
      .sort();
    return { created: [...ids].sort(), all };
  }

  it('5E audit fix 1: cancelling an invitation locks the login’s grants in id order (never a higher one while waiting for a lower one)', async () => {
    const f = fx!;
    const { created, all } = await invitedWithGrants();
    // The lowest of the created grants (the fixture's own grant may sort below it): whatever
    // order the previous code scanned in, it held a higher created grant before reaching this.
    const lowest = created[0]!;
    const highest = created[created.length - 1]!;
    expect(highest > lowest).toBe(true);
    const accounts = accountService(prisma);
    let cancelled: Promise<unknown> | undefined;
    await prisma.$transaction(
      async (holder) => {
        // Hold that grant, as a concurrent revocation in id order would.
        await holder.$queryRawUnsafe(
          `SELECT "id" FROM "RoleAssignment" WHERE "id" = $1::uuid FOR UPDATE`,
          lowest,
        );
        const [{ pid }] = await holder.$queryRawUnsafe<Array<{ pid: number }>>(
          'SELECT pg_backend_pid() AS pid',
        );
        cancelled = accounts.cancel(f.employee2, ctx(f.users.hrA!));
        cancelled.catch(() => undefined);
        // Wait until the cancellation is blocked behind this transaction.
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
          const [{ count }] = await prisma.$queryRawUnsafe<
            Array<{ count: bigint }>
          >(
            'SELECT count(*) AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            pid,
          );
          blocked = Number(count) > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(blocked).toBe(true);
        // In id order nothing above the lowest grant is locked yet: a NOWAIT lock succeeds.
        const probe = await prisma
          .$transaction(async (other) => {
            await other.$queryRawUnsafe(
              `SELECT "id" FROM "RoleAssignment" WHERE "id" = $1::uuid FOR UPDATE NOWAIT`,
              highest,
            );
            return 'free';
          })
          .catch((error: unknown) => String(error));
        expect(probe).toBe('free');
      },
      { timeout: 20_000 },
    );
    await cancelled;
    expect(
      await prisma.roleAssignment.count({
        where: { id: { in: all }, revokedAt: null },
      }),
    ).toBe(0);
    const audits = await prisma.auditLog.findMany({
      where: {
        action: 'EMPLOYEE_ACCOUNT_INVITATION_CANCELLED',
        entityId: f.selfUser2,
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    for (const audit of audits)
      expect(audit.metadata).toMatchObject({
        revokedRoleAssignmentCount: all.length,
      });
  });

  it('5E audit fix 1: an invitation cancellation racing a lifecycle revocation — both complete, each grant revoked once, audits exact', async () => {
    const f = fx!;
    const { created, all } = await invitedWithGrants();
    const { lifecycle } = services(prisma);
    const [cancel, revoke] = await Promise.allSettled([
      accountService(prisma).cancel(f.employee2, ctx(f.users.hrA!)),
      lifecycle.revokeGrants(
        f.employee2,
        { roleAssignmentIds: created },
        ctx(f.users.hrA2!),
      ),
    ]);
    expect([cancel.status, revoke.status]).toEqual(['fulfilled', 'fulfilled']);
    expect(
      await prisma.roleAssignment.count({
        where: { id: { in: all }, revokedAt: null },
      }),
    ).toBe(0);
    const result = (
      revoke as PromiseFulfilledResult<{
        revoked: string[];
        alreadyRevoked: string[];
      }>
    ).value;
    expect([...result.revoked, ...result.alreadyRevoked].sort()).toEqual(
      created,
    );
    // Per-grant audit entries only for what the lifecycle request revoked; the cancellation
    // counts exactly the grants it revoked itself.
    expect(await auditsOf(created)).toBe(result.revoked.length);
    const cancelAudit = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'EMPLOYEE_ACCOUNT_INVITATION_CANCELLED',
        entityId: f.selfUser2,
      },
    });
    expect(cancelAudit.metadata).toMatchObject({
      revokedRoleAssignmentCount: all.length - result.revoked.length,
    });
  });

  it('5E audit fix 1: a failed invitation cancellation leaves every grant and the invitation as they were', async () => {
    const f = fx!;
    const { all } = await invitedWithGrants();
    const failing = accountService(
      prisma,
      new FailingAudit(prisma, 'EMPLOYEE_ACCOUNT_INVITATION_CANCELLED', 1),
    );
    await expect(
      failing.cancel(f.employee2, ctx(f.users.hrA!)),
    ).rejects.toThrow(/injected failure/);
    expect(
      await prisma.roleAssignment.count({
        where: { id: { in: all }, revokedAt: null },
      }),
    ).toBe(all.length);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: f.selfUser2 } }))
        .status,
    ).toBe('INVITED');
  });
});
