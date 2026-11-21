import type { HttpException } from '@nestjs/common';
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
import {
  AccountEmailService,
  type AccountEmailMessage,
} from '../src/auth/account-email.service.js';
import { AccountTokenService } from '../src/auth/account-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccountService } from '../src/employee/employee-account.service.js';
import { Gate, GatedAudit } from './support/transaction-gates.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

const MANAGE = 'employee.account.manage';
const USERS = {
  hrA: [{ permissions: [MANAGE], scope: 'org' as const }],
  hrA2: [{ permissions: [MANAGE], scope: 'org' as const }],
  hrB: [
    {
      permissions: [MANAGE, 'role.assign', 'employee.read'],
      scope: 'orgB' as const,
    },
  ],
};

const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const reasonOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { reason?: string } | undefined)
    ?.reason;

class RecordingEmails extends AccountEmailService {
  sent: AccountEmailMessage[] = [];
  assertAvailable() {}
  async sendInvitation(message: AccountEmailMessage) {
    this.sent.push(message);
  }
  async sendPasswordReset(message: AccountEmailMessage) {
    this.sent.push(message);
  }
  async sendVerification(message: AccountEmailMessage) {
    this.sent.push(message);
  }
}

/** Pauses an account action inside its transaction, at its audit entry (after its writes). */
class GatedAccountAudit extends AuditService {
  constructor(
    prisma: PrismaService,
    private readonly gate: Gate,
    private readonly action: string,
  ) {
    super(prisma);
  }
  override async writeForOrganizations(
    ...args: Parameters<AuditService['writeForOrganizations']>
  ) {
    if (args[0].action === this.action) await this.gate.pass(args[2] as never);
    return super.writeForOrganizations(...args);
  }
}

/**
 * Security remediation M1 — authorization races on committed data (separate connections). Each
 * interleaving is forced with a gate that holds one transaction open; the other operation then
 * either waits on it (observed through pg_blocking_pids) or completes, and the outcome must be
 * one a serial order would produce: an out-of-scope grant committed first always refuses the
 * account action, and an account action never acts on a grant it could not see.
 */
describe('M1: account administration races (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures | undefined;
  let orgBPosition: string;
  let extraUsers: string[] = [];
  let extraEmployees: string[] = [];
  let extraRoles: string[] = [];
  let extraPersons: string[] = [];
  let jobTitleB: string;
  /** Every gate a test armed: opened after it, so a failed test never leaves one holding. */
  let gates: Gate[] = [];
  const newGate = () => {
    const created = new Gate();
    gates.push(created);
    return created;
  };

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  beforeEach(async () => {
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, USERS, [MANAGE, 'employee.read']),
      { timeout: 60_000 },
    );
    jobTitleB = (
      await prisma.jobTitle.create({
        data: {
          organizationId: fx.orgB,
          name: 'B Associate',
          code: `M1RJ-${fx.suffix}`,
        },
      })
    ).id;
    orgBPosition = (
      await prisma.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: jobTitleB,
          name: 'B Associate',
          code: `M1RP-${fx.suffix}`,
        },
      })
    ).id;
  });
  afterEach(async () => {
    for (const held of gates) held.open();
    gates = [];
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!fx) return;
    const f = fx;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      await tx.auditLog.deleteMany({
        where: {
          OR: [
            { entityId: { in: [...extraUsers, ...extraEmployees] } },
            { actorUserId: { in: extraUsers } },
          ],
        },
      });
      await tx.accountToken.deleteMany({
        where: { userId: { in: extraUsers } },
      });
      await tx.authSession.deleteMany({
        where: { userId: { in: extraUsers } },
      });
      await tx.roleAssignment.deleteMany({
        where: {
          OR: [{ userId: { in: extraUsers } }, { roleId: { in: extraRoles } }],
        },
      });
      await tx.rolePermission.deleteMany({
        where: { roleId: { in: extraRoles } },
      });
      await tx.role.deleteMany({ where: { id: { in: extraRoles } } });
      await tx.user.deleteMany({ where: { id: { in: extraUsers } } });
      await tx.employmentAssignment.deleteMany({
        where: { employeeId: { in: extraEmployees } },
      });
      await tx.employee.deleteMany({ where: { id: { in: extraEmployees } } });
      await tx.person.deleteMany({ where: { id: { in: extraPersons } } });
      await tx.position.deleteMany({ where: { id: orgBPosition } });
      await tx.jobTitle.deleteMany({ where: { id: jobTitleB } });
      // Roles the API created in organization B for the raced assignments.
      const apiRoles = (
        await tx.role.findMany({
          where: { organizationId: f.orgB, code: { startsWith: 'M1R-' } },
          select: { id: true },
        })
      ).map((row) => row.id);
      await tx.roleAssignment.deleteMany({
        where: { roleId: { in: apiRoles } },
      });
      await tx.rolePermission.deleteMany({
        where: { roleId: { in: apiRoles } },
      });
      await tx.role.deleteMany({ where: { id: { in: apiRoles } } });
    });
    await cleanupSchedulingFixtures(prisma, f);
    fx = undefined;
    extraUsers = [];
    extraEmployees = [];
    extraRoles = [];
    extraPersons = [];
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function accounts(audit: AuditService = new AuditService(prisma)) {
    return new EmployeeAccountService(
      prisma,
      new AuthorizationService(prisma),
      new PositionAuthorizationTargetResolver(prisma),
      audit,
      new AccountTokenService(prisma, audit),
      new RecordingEmails(),
    );
  }

  /** A target employee currently in A and in B, with a login in the given state. */
  async function target(status: 'ACTIVE' | 'INVITED' | 'DISABLED') {
    const f = fx!;
    const person = await prisma.person.create({
      data: { firstName: 'M1Race', lastName: f.suffix },
    });
    extraPersons.push(person.id);
    const employee = await prisma.employee.create({
      data: {
        personId: person.id,
        employeeNumber: `M1R-${extraEmployees.length}-${f.suffix}`,
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    extraEmployees.push(employee.id);
    for (const [index, positionId] of [f.positionTeamA, orgBPosition].entries())
      await prisma.employmentAssignment.create({
        data: {
          employeeId: employee.id,
          positionId,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: index === 0,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
    const user = await prisma.user.create({
      data: {
        personId: person.id,
        email: `m1-race-${extraUsers.length}-${f.suffix.toLowerCase()}@example.com`,
        status,
        passwordHash: status === 'INVITED' ? null : 'not-a-real-hash',
      },
    });
    extraUsers.push(user.id);
    if (status === 'INVITED')
      await prisma.accountToken.create({
        data: {
          userId: user.id,
          type: 'INVITATION',
          tokenHash: `m1-race-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    return { employeeId: employee.id, userId: user.id };
  }

  async function role(organizationId: string | null, code = 'M1X') {
    const created = await prisma.role.create({
      data: {
        organizationId,
        code: `${code}-${crypto.randomUUID().slice(0, 8)}-${fx!.suffix}`,
        name: 'M1 raced role',
      },
    });
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'employee.read' },
    });
    await prisma.rolePermission.create({
      data: { roleId: created.id, permissionId: permission.id },
    });
    if (code === 'M1X') extraRoles.push(created.id);
    return created.id;
  }

  const grantData = (
    userId: string,
    roleId: string,
    organizationId: string | null,
  ) => ({
    userId,
    roleId,
    roleOrganizationId: organizationId,
    scopeType: organizationId ? ('ORGANIZATION' as const) : ('SYSTEM' as const),
    organizationId,
  });

  /** Holds a transaction open (after `work`) until the gate opens. */
  function hold(gate: Gate, work: (tx: Tx) => Promise<unknown>) {
    const held = prisma.$transaction(
      async (tx) => {
        await work(tx);
        await gate.pass(tx as never);
      },
      { timeout: 60_000 },
    );
    held.catch(() => undefined);
    return held;
  }

  /** Runs `operation` until it settles or waits on the gated transaction; reports which. */
  async function runAgainst(gate: Gate, operation: () => Promise<unknown>) {
    let settled = false;
    const running = operation().finally(() => {
      settled = true;
    });
    running.catch(() => undefined);
    let waited = false;
    for (let i = 0; i < 200 && !settled && !waited; i += 1) {
      const [{ count }] = await prisma.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        'SELECT count(*) AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        gate.pid,
      );
      waited = Number(count) > 0;
      if (!settled && !waited) await new Promise((r) => setTimeout(r, 50));
    }
    return { running, waited, settledFirst: settled };
  }

  it('an out-of-scope grant created first makes a concurrent enable wait, then refuse', async () => {
    const f = fx!;
    const t = await target('DISABLED');
    const roleB = await role(f.orgB);
    const gate = newGate();
    const granting = hold(gate, (tx) =>
      tx.roleAssignment.create({ data: grantData(t.userId, roleB, f.orgB) }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      accounts().enable(t.employeeId, ctx(f.users.hrA!)),
    );
    expect(waited).toBe(true);
    gate.open();
    await granting;
    const error = await running.then(
      () => {
        throw new Error('enable should be refused');
      },
      (e: unknown) => e,
    );
    expect(codeOf(error)).toBe('ACCOUNT_OUTSIDE_SCOPE');
    expect(reasonOf(error)).toBe('ACCESS_OUTSIDE_SCOPE');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
    ).toBe('DISABLED');
  });

  it('a concurrent SYSTEM grant (System Owner bootstrap) makes a credential action wait, then refuse', async () => {
    const f = fx!;
    const t = await target('ACTIVE');
    // The schema allows SYSTEM scope only for the reserved System Owner role (a singleton).
    let system = (
      await prisma.role.findFirst({ where: { isSystemOwner: true } })
    )?.id;
    if (!system) {
      system = (
        await prisma.role.create({
          data: {
            organizationId: null,
            code: 'SYSTEM_OWNER',
            name: 'System Owner',
            isSystemOwner: true,
          },
        })
      ).id;
      extraRoles.push(system);
    }
    const gate = newGate();
    const granting = hold(gate, (tx) =>
      tx.roleAssignment.create({ data: grantData(t.userId, system, null) }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      accounts().requirePasswordChange(t.employeeId, {}, ctx(f.users.hrA!)),
    );
    expect(waited).toBe(true);
    gate.open();
    await granting;
    // Refused by the System Owner rule, which also reads after the login's row lock.
    const error = await running.then(
      () => {
        throw new Error('requirePasswordChange should be refused');
      },
      (e: unknown) => e,
    );
    expect((error as HttpException).getStatus()).toBe(403);
    expect(codeOf(error)).toBeUndefined();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: t.userId } }))
        .mustChangePassword,
    ).toBe(false);
  });

  it('a grant attempted while an enable holds the login waits for it (serial: enable, then grant)', async () => {
    const f = fx!;
    const t = await target('DISABLED');
    const roleB = await role(f.orgB);
    const gate = newGate();
    const enabling = accounts(
      new GatedAccountAudit(prisma, gate, 'EMPLOYEE_ACCOUNT_ENABLED'),
    ).enable(t.employeeId, ctx(f.users.hrA!));
    enabling.catch(() => undefined);
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      prisma.roleAssignment.create({
        data: grantData(t.userId, roleB, f.orgB),
      }),
    );
    expect(waited).toBe(true);
    gate.open();
    await enabling;
    await running;
    // Serial order: the enable saw no grant in B; the grant came after it.
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
    ).toBe('ACTIVE');
    // The next account action sees the grant.
    await expect(
      accounts().disable(t.employeeId, {}, ctx(f.users.hrA!)),
    ).rejects.toSatisfy((e: unknown) => reasonOf(e) === 'ACCESS_OUTSIDE_SCOPE');
  });

  it('a role assigned through the API races a resend: the resend waits and refuses', async () => {
    const f = fx!;
    const t = await target('INVITED');
    const roleB = await role(f.orgB, 'M1R');
    const gate = newGate();
    const authorization = new AuthorizationService(prisma);
    const roles = new RoleManagementService(
      prisma,
      authorization,
      new GatedAudit(prisma, gate),
    );
    const assigning = roles.createAssignment(f.users.hrB!, {
      userId: t.userId,
      roleId: roleB,
      scope: { type: 'ORGANIZATION', id: f.orgB },
    });
    assigning.catch(() => undefined);
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      accounts().resend(t.employeeId, {}, ctx(f.users.hrA!)),
    );
    expect(waited).toBe(true);
    gate.open();
    await assigning;
    await expect(running).rejects.toSatisfy(
      (e: unknown) => reasonOf(e) === 'ACCESS_OUTSIDE_SCOPE',
    );
  });

  it('a revocation in flight never deadlocks a disable: refused while the grant is live, allowed after', async () => {
    const f = fx!;
    const t = await target('ACTIVE');
    const roleB = await role(f.orgB);
    const grant = await prisma.roleAssignment.create({
      data: grantData(t.userId, roleB, f.orgB),
    });
    const gate = newGate();
    const revoking = hold(gate, (tx) =>
      tx.roleAssignment.update({
        where: { id: grant.id },
        data: { revokedAt: new Date() },
      }),
    );
    await gate.reached;
    const { running, waited, settledFirst } = await runAgainst(gate, () =>
      accounts().disable(t.employeeId, {}, ctx(f.users.hrA!)),
    );
    expect(waited).toBe(false);
    expect(settledFirst).toBe(true);
    await expect(running).rejects.toSatisfy(
      (e: unknown) => reasonOf(e) === 'ACCESS_OUTSIDE_SCOPE',
    );
    gate.open();
    await revoking;
    // Retried after the revocation commits: allowed.
    await accounts().disable(t.employeeId, {}, ctx(f.users.hrA!));
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
    ).toBe('DISABLED');
  });

  it('an assignment ending concurrently with a credential reset yields a serial outcome', async () => {
    const f = fx!;
    const t = await target('ACTIVE');
    const inA = await prisma.employmentAssignment.findFirstOrThrow({
      where: { employeeId: t.employeeId, positionId: f.positionTeamA },
    });
    const ending = {
      status: 'ENDED' as const,
      endDate: new Date('2026-06-30T00:00:00.000Z'),
    };
    // In flight: the reset reads the committed (ACTIVE) assignment and is not blocked.
    const gate = newGate();
    const held = hold(gate, (tx) =>
      tx.employmentAssignment.update({ where: { id: inA.id }, data: ending }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      accounts().sendPasswordReset(t.employeeId, ctx(f.users.hrA!)),
    );
    expect(waited).toBe(false);
    await running;
    gate.open();
    await held;
    // Committed first: the next credential action is refused.
    await expect(
      accounts().sendPasswordReset(t.employeeId, ctx(f.users.hrA!)),
    ).rejects.toSatisfy(
      (e: unknown) => reasonOf(e) === 'NO_CURRENT_ASSIGNMENT',
    );
  });

  it('concurrent enable and disable on one login serialize on the employee lock without deadlock', async () => {
    const f = fx!;
    const t = await target('DISABLED');
    const gate = newGate();
    const enabling = accounts(
      new GatedAccountAudit(prisma, gate, 'EMPLOYEE_ACCOUNT_ENABLED'),
    ).enable(t.employeeId, ctx(f.users.hrA!));
    enabling.catch(() => undefined);
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      accounts().disable(t.employeeId, {}, ctx(f.users.hrA2!)),
    );
    expect(waited).toBe(true);
    gate.open();
    await enabling;
    await running;
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
    ).toBe('DISABLED');
  });
});
