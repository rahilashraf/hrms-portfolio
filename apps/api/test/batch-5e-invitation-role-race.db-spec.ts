import type { ConfigService } from '@nestjs/config';
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
import type { AccountRecoveryQueue } from '../src/auth/account-recovery-queue.service.js';
import {
  AccountEmailService,
  type AccountEmailMessage,
} from '../src/auth/account-email.service.js';
import { AccountTokenService } from '../src/auth/account-token.service.js';
import type { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import type { LoginRateLimiterService } from '../src/auth/login-rate-limiter.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccountService } from '../src/employee/employee-account.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { UsersService } from '../src/users/users.service.js';
import { PASSWORD, RecordingRecoveryQueue } from './support/auth-fixtures.js';
import {
  Gate,
  GatedAudit,
  GatedAuthorization,
} from './support/transaction-gates.js';
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
  'employee.account.manage',
  'role.read',
  'role.assign',
];
const USERS: Record<string, UserSpec[]> = {
  hrA: [{ permissions: ADMIN, scope: 'org' }],
  hrA2: [{ permissions: ADMIN, scope: 'org' }],
};
/** The permission the raced role grants (one the assigning administrator may delegate). */
const GRANTED = 'employee.read';

const testConfig = {
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`${key} missing`);
    return key.startsWith('ARGON2_') ? Number(value) : value;
  },
} as unknown as ConfigService;

/** Records invitation links instead of emailing them. */
class RecordingEmails extends AccountEmailService {
  sent: AccountEmailMessage[] = [];
  /** Runs once while an invitation is "being delivered"; it may act and then fail delivery. */
  onInvitation?: () => Promise<void>;
  assertAvailable() {}
  async sendInvitation(message: AccountEmailMessage) {
    const hook = this.onInvitation;
    if (hook) {
      this.onInvitation = undefined;
      await hook();
    }
    this.sent.push(message);
  }
  async sendPasswordReset(message: AccountEmailMessage) {
    this.sent.push(message);
  }
  async sendVerification(message: AccountEmailMessage) {
    this.sent.push(message);
  }
}

/**
 * Batch 5E — a role assigned to an INVITED login while its invitation is cancelled (committed
 * data, separate connections). The interleaving is forced: role assignment reads the INVITED
 * user and pauses; the cancellation then runs until it commits or waits on the assignment; then
 * the assignment continues. Afterwards the invitation is reissued (the same login is revived)
 * and accepted. Invariant: no grant created for the invitation survives its cancellation, so the
 * reissued, activated login is authorized by nothing from before.
 */
describe('Batch 5E: role assignment racing an invitation cancellation (committed data)', () => {
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
    // Employee 2's login is a pending invitation (never activated).
    await prisma.user.update({
      where: { id: fx.selfUser2 },
      data: { status: 'INVITED', passwordHash: null },
    });
  });
  afterEach(async () => {
    if (fx) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        // Employee 2's logins: the fixture's, or one an invitation created in the test.
        const person = (
          await tx.employee.findUniqueOrThrow({
            where: { id: fx!.employee2 },
            select: { personId: true },
          })
        ).personId;
        const logins = [
          fx!.selfUser2,
          ...(
            await tx.user.findMany({
              where: { personId: person },
              select: { id: true },
            })
          ).map((row) => row.id),
        ];
        await tx.auditLog.deleteMany({
          where: {
            OR: [
              { entityId: { in: [fx!.employee1, fx!.employee2, ...logins] } },
              { actorUserId: { in: logins } },
              // This test's grants and roles (some audited without an actor), by the fixture
              // organization the entries are tagged with; never other specs' entries.
              {
                entityType: { in: ['RoleAssignment', 'Role'] },
                metadata: { path: ['organizationId'], equals: fx!.orgA },
              },
            ],
          },
        });
        await tx.accountToken.deleteMany({ where: { userId: { in: logins } } });
        await tx.authSession.deleteMany({ where: { userId: { in: logins } } });
        await tx.roleAssignment.deleteMany({
          where: { userId: { in: logins } },
        });
        await tx.user.deleteMany({
          where: { id: { in: logins.filter((id) => id !== fx!.selfUser2) } },
        });
      });
      await cleanupSchedulingFixtures(prisma, fx);
      fx = undefined;
    }
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function wire(
    authorization: AuthorizationService,
    rolesAudit?: AuditService,
  ) {
    const audit = new AuditService(prisma);
    const tokens = new AccountTokenService(prisma, audit);
    const emails = new RecordingEmails();
    const roles = new RoleManagementService(
      prisma,
      authorization,
      rolesAudit ?? audit,
    );
    const accounts = new EmployeeAccountService(
      prisma,
      new AuthorizationService(prisma),
      new PositionAuthorizationTargetResolver(prisma),
      audit,
      tokens,
      emails,
    );
    const auth = new AuthService(
      prisma,
      audit,
      new UsersService(prisma),
      new SessionsService(prisma),
      new PasswordHasherService(testConfig),
      {} as AccessTokenService,
      tokens,
      emails,
      {
        assertLoginAllowed: async () => undefined,
      } as unknown as LoginRateLimiterService,
      new RecordingRecoveryQueue() as unknown as AccountRecoveryQueue,
    );
    return { roles, accounts, auth, emails };
  }

  async function grantableRole() {
    const f = fx!;
    const role = await prisma.role.create({
      data: {
        organizationId: f.orgA,
        code: `5E-RACE-${f.suffix}-${Math.random().toString(36).slice(2, 6)}`,
        name: '5E raced role',
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

  /** Employee 2's login (the fixture's, or the one an invitation created). */
  async function loginOf() {
    const person = (
      await prisma.employee.findUniqueOrThrow({
        where: { id: fx!.employee2 },
        select: { personId: true },
      })
    ).personId;
    return (
      await prisma.user.findUniqueOrThrow({ where: { personId: person } })
    ).id;
  }

  /** Reissue the invitation (reviving the same login) and accept it. */
  async function reissueAndAccept(
    h: ReturnType<typeof wire>,
    userId = fx!.selfUser2,
  ) {
    const f = fx!;
    await h.accounts.invite(
      f.employee2,
      { email: `5e-reinvite-${f.suffix.toLowerCase()}@example.com` },
      ctx(f.users.hrA!),
    );
    const reissued = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(reissued).toMatchObject({ status: 'INVITED', archivedAt: null });
    await h.auth.acceptInvitation(h.emails.sent.at(-1)!.token, PASSWORD, {});
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status,
    ).toBe('ACTIVE');
  }

  const grantsAccess = (userId = fx!.selfUser2) =>
    new AuthorizationService(prisma).canAccess(userId, GRANTED, {
      type: 'ORGANIZATION',
      id: fx!.orgA,
    });

  /**
   * Forces the interleaving: role assignment pauses at `where`; the cancellation runs until it
   * commits or waits on the paused transaction; then the assignment continues. Returns what
   * happened, after checking the invariant and the reissue.
   */
  async function race(where: 'before-insert' | 'after-insert') {
    const f = fx!;
    const roleId = await grantableRole();
    const gate = new Gate();
    const h =
      where === 'before-insert'
        ? wire(new GatedAuthorization(prisma, gate))
        : wire(new AuthorizationService(prisma), new GatedAudit(prisma, gate));

    // 1. Role assignment reads the INVITED login, then pauses before writing the grant. The
    //    audit context is the one the HTTP controller passes, so the entry names its actor.
    const assigning = h.roles.createAssignment(
      f.users.hrA!,
      {
        userId: f.selfUser2,
        roleId,
        scope: { type: 'ORGANIZATION', id: f.orgA },
      },
      ctx(f.users.hrA!),
    );
    assigning.catch(() => undefined);
    await gate.reached;

    // 2. The invitation is cancelled meanwhile: run it until it commits, or until it waits on
    //    the paused assignment (whichever the locking allows).
    let cancelSettled = false;
    const cancelling = h.accounts
      .cancel(f.employee2, ctx(f.users.hrA2!))
      .finally(() => {
        cancelSettled = true;
      });
    cancelling.catch(() => undefined);
    let waitingOnAssignment = false;
    for (let i = 0; i < 200 && !cancelSettled && !waitingOnAssignment; i += 1) {
      const [{ count }] = await prisma.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        'SELECT count(*) AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        gate.pid,
      );
      waitingOnAssignment = Number(count) > 0;
      if (!cancelSettled && !waitingOnAssignment)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(cancelSettled || waitingOnAssignment).toBe(true);

    // 3. The assignment continues.
    gate.open();
    const [assigned, cancelled] = await Promise.allSettled([
      assigning,
      cancelling,
    ]);
    expect(cancelled.status).toBe('fulfilled');
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: f.selfUser2 },
    });
    expect(user.status).toBe('ARCHIVED');

    // Invariant: nothing of the cancelled invitation stays live on the archived login.
    const live = await prisma.roleAssignment.findMany({
      where: { userId: f.selfUser2, revokedAt: null },
    });
    expect({
      assignment: assigned.status,
      liveGrantsOnArchivedLogin: live.length,
    }).toMatchObject({ liveGrantsOnArchivedLogin: 0 });
    // A grant written by the assignment, if any, is revoked and both actions are audited.
    if (assigned.status === 'fulfilled') {
      const created = assigned.value as { id: string };
      expect(
        (
          await prisma.roleAssignment.findUniqueOrThrow({
            where: { id: created.id },
          })
        ).revokedAt,
      ).not.toBeNull();
      // Exactly one creation entry for the grant, naming its actor and target. (The whole
      // rows are compared, so a failure shows what was found.)
      const entries = await prisma.auditLog.findMany({
        where: { action: 'ROLE_ASSIGNMENT_CREATED', entityId: created.id },
        select: {
          action: true,
          entityType: true,
          entityId: true,
          actorUserId: true,
          metadata: true,
        },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entityType: 'RoleAssignment',
        actorUserId: f.users.hrA,
        metadata: { userId: f.selfUser2, roleId },
      });
    }

    // 4. Reissue and accept: the revived login is authorized by nothing from before.
    await reissueAndAccept(h);
    expect(await grantsAccess()).toBe(false);
    return {
      cancelWaitedOnAssignment: waitingOnAssignment,
      assignment: assigned.status,
      reason:
        assigned.status === 'rejected'
          ? String((assigned as PromiseRejectedResult).reason)
          : null,
    };
  }

  it('assignment paused after reading the INVITED login, before writing the grant: the cancellation commits first, the late grant is refused (serialization failure), the reissued login is authorized by nothing', async () => {
    const outcome = await race('before-insert');
    expect(outcome.cancelWaitedOnAssignment).toBe(false);
    expect(outcome.assignment).toBe('rejected');
    expect(outcome.reason).toMatch(/write conflict|could not serialize/i);
  });

  it('assignment paused after writing the grant, before committing: the cancellation waits for it, then revokes the grant; the reissued login is authorized by nothing', async () => {
    const outcome = await race('after-insert');
    expect(outcome.cancelWaitedOnAssignment).toBe(true);
    expect(outcome.assignment).toBe('fulfilled');
  });

  it('ordinary paths are unchanged: an invited login is given a role, cancellation revokes it, reissue and acceptance do not bring it back; an active login is given a role and it applies', async () => {
    const f = fx!;
    const roleId = await grantableRole();
    const h = wire(new AuthorizationService(prisma));
    const assignment = await h.roles.createAssignment(f.users.hrA!, {
      userId: f.selfUser2,
      roleId,
      scope: { type: 'ORGANIZATION', id: f.orgA },
    });
    await h.accounts.cancel(f.employee2, ctx(f.users.hrA!));
    expect(
      (
        await prisma.roleAssignment.findUniqueOrThrow({
          where: { id: assignment.id },
        })
      ).revokedAt,
    ).not.toBeNull();
    // Assigning to the cancelled (archived) login is refused.
    const refused = await h.roles
      .createAssignment(f.users.hrA!, {
        userId: f.selfUser2,
        roleId,
        scope: { type: 'ORGANIZATION', id: f.orgA },
      })
      .then(
        () => null,
        (error: unknown) => error as { getStatus?: () => number },
      );
    expect(refused?.getStatus?.()).toBe(404);
    await reissueAndAccept(h);
    expect(await grantsAccess()).toBe(false);
    // The activated login can be given the role again, and then it applies.
    await h.roles.createAssignment(f.users.hrA!, {
      userId: f.selfUser2,
      roleId,
      scope: { type: 'ORGANIZATION', id: f.orgA },
    });
    expect(await grantsAccess()).toBe(true);
  });
  // ─── Failed invitation delivery (initial invitation; undo on failure) ─────────────────────

  /** Employee 2 without any login, as before a first invitation. */
  async function withoutLogin() {
    await prisma.user.delete({ where: { id: fx!.selfUser2 } });
  }
  it('failed initial invitation email: a role assigned while delivery was pending is revoked with the archival (atomic, audited); reissue and acceptance restore no old authorization', async () => {
    const f = fx!;
    await withoutLogin();
    const roleId = await grantableRole();
    const h = wire(new AuthorizationService(prisma));
    let granted: { id: string } | undefined;
    h.emails.onInvitation = async () => {
      // Committed meanwhile by another administrator: the INVITED login is given a role.
      granted = await h.roles.createAssignment(f.users.hrA2!, {
        userId: await loginOf(),
        roleId,
        scope: { type: 'ORGANIZATION', id: f.orgA },
      });
      throw new Error('smtp down');
    };
    await expect(
      h.accounts.invite(
        f.employee2,
        { email: `5e-first-${f.suffix.toLowerCase()}@example.com` },
        ctx(f.users.hrA!),
      ),
    ).rejects.toThrow('smtp down');
    const userId = await loginOf();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    ).toMatchObject({ status: 'ARCHIVED', passwordHash: null });
    // No live grant survives; the one assigned meanwhile is revoked by the undo.
    expect(
      await prisma.roleAssignment.count({
        where: { userId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma.roleAssignment.findUniqueOrThrow({
        where: { id: granted!.id },
      }),
    ).toMatchObject({ revokedByUserId: f.users.hrA });
    const failure = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'EMPLOYEE_ACCOUNT_INVITATION_FAILED', entityId: userId },
    });
    expect(failure.metadata).toMatchObject({
      employeeId: f.employee2,
      undone: true,
      superseded: false,
      revokedRoleAssignmentCount: 1,
    });
    // Reissue revives the same login; acceptance activates it — with no old authorization.
    await reissueAndAccept(h, userId);
    expect(await grantsAccess(userId)).toBe(false);
  });

  it('failed delivery superseded by a resend: nothing is undone or revoked, and the delivered invitation keeps the role prepared for it', async () => {
    const f = fx!;
    await withoutLogin();
    const roleId = await grantableRole();
    const h = wire(new AuthorizationService(prisma));
    h.emails.onInvitation = async () => {
      await h.roles.createAssignment(f.users.hrA2!, {
        userId: await loginOf(),
        roleId,
        scope: { type: 'ORGANIZATION', id: f.orgA },
      });
      // Another administrator resends (a newer link is delivered) before this one fails.
      await h.accounts.resend(f.employee2, {}, ctx(f.users.hrA2!));
      throw new Error('smtp down');
    };
    await expect(
      h.accounts.invite(
        f.employee2,
        { email: `5e-sup-${f.suffix.toLowerCase()}@example.com` },
        ctx(f.users.hrA!),
      ),
    ).rejects.toThrow('smtp down');
    const userId = await loginOf();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status,
    ).toBe('INVITED');
    expect(
      await prisma.roleAssignment.count({ where: { userId, revokedAt: null } }),
    ).toBe(1);
    const failure = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'EMPLOYEE_ACCOUNT_INVITATION_FAILED', entityId: userId },
    });
    expect(failure.metadata).toMatchObject({
      undone: false,
      superseded: true,
      revokedRoleAssignmentCount: 0,
    });
    // The resent (delivered) link activates the login with its prepared role.
    await h.auth.acceptInvitation(h.emails.sent.at(-1)!.token, PASSWORD, {});
    expect(await grantsAccess(userId)).toBe(true);
  });

  it('failed delivery after a cancellation: the cancellation revoked the role (once); the failure undoes nothing more; reissue restores no old authorization', async () => {
    const f = fx!;
    await withoutLogin();
    const roleId = await grantableRole();
    const h = wire(new AuthorizationService(prisma));
    let granted: { id: string } | undefined;
    h.emails.onInvitation = async () => {
      granted = await h.roles.createAssignment(f.users.hrA2!, {
        userId: await loginOf(),
        roleId,
        scope: { type: 'ORGANIZATION', id: f.orgA },
      });
      await h.accounts.cancel(f.employee2, ctx(f.users.hrA2!));
      throw new Error('smtp down');
    };
    await expect(
      h.accounts.invite(
        f.employee2,
        { email: `5e-can-${f.suffix.toLowerCase()}@example.com` },
        ctx(f.users.hrA!),
      ),
    ).rejects.toThrow('smtp down');
    const userId = await loginOf();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status,
    ).toBe('ARCHIVED');
    expect(
      await prisma.roleAssignment.findUniqueOrThrow({
        where: { id: granted!.id },
      }),
    ).toMatchObject({ revokedByUserId: f.users.hrA2 });
    const failure = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'EMPLOYEE_ACCOUNT_INVITATION_FAILED', entityId: userId },
    });
    expect(failure.metadata).toMatchObject({
      undone: false,
      superseded: true,
      revokedRoleAssignmentCount: 0,
    });
    await reissueAndAccept(h, userId);
    expect(await grantsAccess(userId)).toBe(false);
  });

  it('defence in depth: reissuing an archived invitation that still holds a live grant (left by earlier code) revokes it first, audited; acceptance restores no old authorization', async () => {
    const f = fx!;
    const roleId = await grantableRole();
    const h = wire(new AuthorizationService(prisma));
    // A cancelled (archived, never activated) login still holding a live grant.
    await prisma.user.update({
      where: { id: f.selfUser2 },
      data: { status: 'ARCHIVED', archivedAt: new Date(), passwordHash: null },
    });
    const leftover = await prisma.roleAssignment.create({
      data: {
        userId: f.selfUser2,
        roleId,
        roleOrganizationId: f.orgA,
        scopeType: 'ORGANIZATION',
        organizationId: f.orgA,
      },
    });
    await reissueAndAccept(h);
    expect(
      await prisma.roleAssignment.findUniqueOrThrow({
        where: { id: leftover.id },
      }),
    ).toMatchObject({ revokedByUserId: f.users.hrA });
    const invited = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'EMPLOYEE_ACCOUNT_INVITED', entityId: f.selfUser2 },
      orderBy: { occurredAt: 'desc' },
    });
    expect(invited.metadata).toMatchObject({
      revived: true,
      revokedRoleAssignmentCount: 1,
    });
    expect(await grantsAccess()).toBe(false);
  });
});
