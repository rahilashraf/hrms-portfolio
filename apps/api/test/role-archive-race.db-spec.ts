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
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  type SchedulingFixtures,
  type UserSpec,
} from './support/scheduling-fixtures.js';
import {
  Gate,
  GatedAudit,
  GatedAuthorization,
} from './support/transaction-gates.js';

config({ path: '../../.env' });

const ADMIN = ['employee.read', 'role.read', 'role.assign', 'role.manage'];
const USERS: Record<string, UserSpec[]> = {
  admin: [{ permissions: ADMIN, scope: 'org' }],
  admin2: [{ permissions: ADMIN, scope: 'org' }],
};
/** The permission the raced role grants (one the assigning administrator may delegate). */
const GRANTED = 'employee.read';

/**
 * Batch 6A (N1) — a role assigned while the role is being archived (committed data, separate
 * connections). Archiving revokes every grant of the role; reactivating it must not bring back
 * authorization from an assignment that raced the archive. Role assignment runs Serializable;
 * archiving locks the role row FOR UPDATE first (conflicting with the key-share lock the grant
 * insert's foreign-key check takes on the role row), then locks and revokes the role's grants.
 * Both interleavings are forced by pausing role assignment inside its transaction.
 */
describe('Batch 6A (N1): role assignment racing role archival (committed data)', () => {
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
      await cleanupSchedulingFixtures(prisma, fx);
      fx = undefined;
    }
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function raceRole() {
    const f = fx!;
    const role = await prisma.role.create({
      data: {
        organizationId: f.orgA,
        code: `6A-RACE-${f.suffix}-${Math.random().toString(36).slice(2, 6)}`,
        name: '6A raced role',
      },
    });
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: GRANTED },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    return role.id;
  }

  const grantsAccess = () =>
    new AuthorizationService(prisma).canAccess(fx!.selfUser2, GRANTED, {
      type: 'ORGANIZATION',
      id: fx!.orgA,
    });

  async function race(where: 'before-insert' | 'after-insert') {
    const f = fx!;
    const roleId = await raceRole();
    const gate = new Gate();
    const audit = new AuditService(prisma);
    const assigner = new RoleManagementService(
      prisma,
      where === 'before-insert'
        ? new GatedAuthorization(prisma, gate)
        : new AuthorizationService(prisma),
      where === 'after-insert' ? new GatedAudit(prisma, gate) : audit,
    );
    const archiver = new RoleManagementService(
      prisma,
      new AuthorizationService(prisma),
      audit,
    );

    // 1. Role assignment reads the (live) role and pauses, before or after inserting the grant.
    const assigning = assigner.createAssignment(f.users.admin!, {
      userId: f.selfUser2,
      roleId,
      scope: { type: 'ORGANIZATION', id: f.orgA },
    });
    assigning.catch(() => undefined);
    await gate.reached;

    // 2. The role is archived meanwhile: run it until it commits, or until it waits on the
    //    paused assignment.
    let archiveSettled = false;
    const archiving = archiver
      .archiveRole(f.users.admin2!, roleId)
      .finally(() => {
        archiveSettled = true;
      });
    archiving.catch(() => undefined);
    let waiting = false;
    for (let i = 0; i < 200 && !archiveSettled && !waiting; i += 1) {
      const [{ count }] = await prisma.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        'SELECT count(*) AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        gate.pid,
      );
      waiting = Number(count) > 0;
      if (!archiveSettled && !waiting)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(archiveSettled || waiting).toBe(true);

    // 3. The assignment continues.
    gate.open();
    const [assigned, archived] = await Promise.allSettled([
      assigning,
      archiving,
    ]);
    expect(archived.status).toBe('fulfilled');
    expect(
      (await prisma.role.findUniqueOrThrow({ where: { id: roleId } }))
        .archivedAt,
    ).not.toBeNull();

    // Invariant: an archived role holds no live grant.
    expect({
      assignment: assigned.status,
      liveGrantsOnArchivedRole: await prisma.roleAssignment.count({
        where: { roleId, revokedAt: null },
      }),
    }).toMatchObject({ liveGrantsOnArchivedRole: 0 });
    if (assigned.status === 'fulfilled') {
      const created = assigned.value as { id: string };
      // Created (audited once), then revoked by the archive (audited once).
      expect(
        await prisma.auditLog.count({
          where: { action: 'ROLE_ASSIGNMENT_CREATED', entityId: created.id },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: created.id },
        }),
      ).toBe(1);
    }
    expect(
      await prisma.auditLog.count({
        where: { action: 'ROLE_ARCHIVED', entityId: roleId },
      }),
    ).toBe(1);

    // 4. Reactivating the role restores no authorization from the raced assignment.
    await archiver.reactivateRole(f.users.admin2!, roleId);
    expect(await grantsAccess()).toBe(false);
    return {
      archiveWaited: waiting,
      assignment: assigned.status,
      reason:
        assigned.status === 'rejected'
          ? String((assigned as PromiseRejectedResult).reason)
          : null,
    };
  }

  it('assignment paused after reading the live role, before inserting: the archive commits first and the late grant is refused (serialization failure)', async () => {
    const outcome = await race('before-insert');
    expect(outcome.archiveWaited).toBe(false);
    expect(outcome.assignment).toBe('rejected');
    expect(outcome.reason).toMatch(/write conflict|could not serialize/i);
  });

  it('assignment paused after inserting, before committing: the archive waits for it, then revokes the grant', async () => {
    const outcome = await race('after-insert');
    expect(outcome.archiveWaited).toBe(true);
    expect(outcome.assignment).toBe('fulfilled');
  });

  it('ordinary paths are unchanged: archive revokes, reactivation restores nothing, a new assignment applies; archiving twice is idempotent', async () => {
    const f = fx!;
    const roleId = await raceRole();
    const roles = new RoleManagementService(
      prisma,
      new AuthorizationService(prisma),
      new AuditService(prisma),
    );
    const first = await roles.createAssignment(f.users.admin!, {
      userId: f.selfUser2,
      roleId,
      scope: { type: 'ORGANIZATION', id: f.orgA },
    });
    expect(await grantsAccess()).toBe(true);
    await roles.archiveRole(f.users.admin!, roleId);
    await roles.archiveRole(f.users.admin!, roleId);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ROLE_ARCHIVED', entityId: roleId },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.roleAssignment.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).revokedAt,
    ).not.toBeNull();
    await roles.reactivateRole(f.users.admin!, roleId);
    expect(await grantsAccess()).toBe(false);
    await roles.createAssignment(f.users.admin!, {
      userId: f.selfUser2,
      roleId,
      scope: { type: 'ORGANIZATION', id: f.orgA },
    });
    expect(await grantsAccess()).toBe(true);
  });
});
