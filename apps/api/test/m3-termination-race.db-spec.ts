import { randomUUID } from 'node:crypto';
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
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import {
  runApplyDueTerminationsJob,
  runReconcileRetainedGrantsJob,
} from '../src/employee/employee-jobs.js';
import { Gate } from './support/transaction-gates.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

const ADMIN = ['employee.manage', 'employee.read', 'role.read', 'role.assign'];
const USERS = {
  hrA: [{ permissions: [...ADMIN, 'time.clock'], scope: 'org' as const }],
  hrA2: [
    {
      permissions: [...ADMIN, 'role.manage', 'time.clock'],
      scope: 'org' as const,
    },
  ],
};
const GRANTS_FROM = new Date('2026-01-01T00:00:00.000Z');
const DAY = 86_400_000;
const day = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const after = (date: string, days = 1) =>
  new Date(new Date(`${date}T12:00:00.000Z`).getTime() + days * DAY);
const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;

/** Pauses a transaction at one audit action (after that change's writes). */
class GatedAuditAt extends AuditService {
  constructor(
    prisma: PrismaService,
    private readonly gate: Gate,
    private readonly action: string,
  ) {
    super(prisma);
  }
  override async write(
    input: Parameters<AuditService['write']>[0],
    client?: Parameters<AuditService['write']>[1],
  ) {
    if (input.action === this.action) await this.gate.pass(client as never);
    return super.write(input, client);
  }
}

/**
 * Security remediation M3 — races around termination grant revocation, on committed data with
 * separate connections. One side is held open at a chosen point; the other either waits on it
 * (pg_blocking_pids) or completes, and the outcome must be a serial one: no grant survives an
 * applied termination in its organizations unless approved, no grant is revoked twice, and a late
 * approval never brings a revoked grant back.
 */
describe('M3: termination grant races (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures | undefined;
  let gates: Gate[] = [];
  const created = {
    users: [] as string[],
    persons: [] as string[],
    employees: [] as string[],
    roles: [] as string[],
    orgs: [] as string[],
  };

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  beforeEach(async () => {
    fx = await prisma.$transaction(
      (tx) =>
        createSchedulingFixtures(
          tx,
          USERS,
          [...ADMIN, 'role.manage', 'time.clock'],
          {
            grantsStartAt: GRANTS_FROM,
          },
        ),
      { timeout: 60_000 },
    );
  });
  afterEach(async () => {
    for (const gate of gates) gate.open();
    gates = [];
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!fx) return;
    const f = fx;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      const terminations = (
        await tx.employeeTermination.findMany({
          where: { employeeId: { in: created.employees } },
          select: { id: true },
        })
      ).map((row) => row.id);
      const grants = (
        await tx.roleAssignment.findMany({
          where: {
            OR: [
              { userId: { in: created.users } },
              { roleId: { in: created.roles } },
            ],
          },
          select: { id: true },
        })
      ).map((row) => row.id);
      const assignments = (
        await tx.employmentAssignment.findMany({
          where: { employeeId: { in: created.employees } },
          select: { id: true },
        })
      ).map((row) => row.id);
      await tx.auditLog.deleteMany({
        where: {
          OR: [
            {
              actorUserId: {
                in: [...created.users, ...Object.values(f.users)],
              },
            },
            {
              entityId: {
                in: [
                  ...created.users,
                  ...created.employees,
                  ...created.roles,
                  ...grants,
                  ...assignments,
                ],
              },
            },
          ],
        },
      });
      await tx.employeeTerminationGrantDecision.deleteMany({
        where: { terminationId: { in: terminations } },
      });
      await tx.employeeTerminationAssignment.deleteMany({
        where: { terminationId: { in: terminations } },
      });
      await tx.employeeTermination.deleteMany({
        where: { id: { in: terminations } },
      });
      await tx.authSession.deleteMany({
        where: { userId: { in: created.users } },
      });
      await tx.accountToken.deleteMany({
        where: { userId: { in: created.users } },
      });
      await tx.roleAssignment.deleteMany({
        where: {
          OR: [
            { userId: { in: created.users } },
            { roleId: { in: created.roles } },
          ],
        },
      });
      await tx.rolePermission.deleteMany({
        where: { roleId: { in: created.roles } },
      });
      await tx.role.deleteMany({ where: { id: { in: created.roles } } });
      await tx.user.deleteMany({ where: { id: { in: created.users } } });
      await tx.employmentAssignment.deleteMany({
        where: { employeeId: { in: created.employees } },
      });
      await tx.employee.deleteMany({
        where: { id: { in: created.employees } },
      });
      await tx.person.deleteMany({ where: { id: { in: created.persons } } });
      await tx.organization.deleteMany({ where: { id: { in: created.orgs } } });
    });
    await cleanupSchedulingFixtures(prisma, f);
    fx = undefined;
    for (const list of Object.values(created)) list.length = 0;
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const newGate = () => {
    const gate = new Gate();
    gates.push(gate);
    return gate;
  };

  function lifecycle(audit: AuditService = new AuditService(prisma)) {
    const authorization = new AuthorizationService(prisma);
    return new EmployeeLifecycleService(
      prisma,
      new EmployeeDomainService(prisma, audit),
      new EmployeeAccessService(
        prisma,
        authorization,
        new PositionAuthorizationTargetResolver(prisma),
        audit,
      ),
      authorization,
      audit,
      new RoleManagementService(prisma, authorization, audit),
    );
  }
  function roles(audit: AuditService = new AuditService(prisma)) {
    return new RoleManagementService(
      prisma,
      new AuthorizationService(prisma),
      audit,
    );
  }

  async function role(organizationId: string) {
    const created_ = await prisma.role.create({
      data: {
        organizationId,
        code: `M3R-${randomUUID().slice(0, 8)}`,
        name: 'M3 raced role',
      },
    });
    created.roles.push(created_.id);
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'time.clock' },
    });
    await prisma.rolePermission.create({
      data: { roleId: created_.id, permissionId: permission.id },
    });
    return created_.id;
  }
  const grantData = (
    userId: string,
    roleId: string,
    organizationId: string,
  ) => ({
    userId,
    roleId,
    roleOrganizationId: organizationId,
    scopeType: 'ORGANIZATION' as const,
    organizationId,
    startsAt: GRANTS_FROM,
  });

  /** An employee of A with an active login and one grant in A. */
  async function target() {
    const f = fx!;
    const person = await prisma.person.create({
      data: { firstName: 'M3Race', lastName: f.suffix },
    });
    created.persons.push(person.id);
    const employee = await prisma.employee.create({
      data: {
        personId: person.id,
        employeeNumber: `M3R-${created.employees.length}-${f.suffix}`,
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    created.employees.push(employee.id);
    await prisma.employmentAssignment.create({
      data: {
        employeeId: employee.id,
        positionId: f.positionTeamA,
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        isPrimary: true,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const user = await prisma.user.create({
      data: {
        personId: person.id,
        email: `m3-race-${created.users.length}-${f.suffix.toLowerCase()}@example.com`,
        status: 'ACTIVE',
        passwordHash: 'not-a-real-hash',
      },
    });
    created.users.push(user.id);
    const roleA = await role(f.orgA);
    const grant = await prisma.roleAssignment.create({
      data: grantData(user.id, roleA, f.orgA),
    });
    return { employeeId: employee.id, userId: user.id, grant: grant.id, roleA };
  }

  /** A scheduled termination for `date` (default in five days). */
  async function scheduled(
    employeeId: string,
    date = day(5),
    decisions?: unknown[],
  ) {
    return (
      await lifecycle().terminate(
        employeeId,
        {
          terminationDate: date,
          ...(decisions ? { grantDecisions: decisions as never } : {}),
        },
        ctx(fx!.users.hrA!),
      )
    ).termination.id;
  }

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

  const settle = (promise: Promise<unknown>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const grantRow = (id: string) =>
    prisma.roleAssignment.findUniqueOrThrow({ where: { id } });
  const apply = (
    employeeId: string,
    terminationId: string,
    date: string,
    l = lifecycle(),
  ) =>
    l.applyTermination(
      employeeId,
      terminationId,
      ctx(fx!.users.hrA!),
      after(date),
    );

  it('apply versus role creation: a grant committed first is revoked by the waiting apply', async () => {
    const t = await target();
    const date = day(5);
    const tid = await scheduled(t.employeeId, date);
    // Another role of A (the same role and scope again would be a duplicate of the live grant).
    const otherRoleA = await role(fx!.orgA);
    const gate = newGate();
    let addedId = '';
    const adding = hold(gate, async (tx) => {
      addedId = (
        await tx.roleAssignment.create({
          data: grantData(t.userId, otherRoleA, fx!.orgA),
        })
      ).id;
    });
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      apply(t.employeeId, tid, date),
    );
    expect(waited).toBe(true);
    gate.open();
    await adding;
    await running;
    expect(await grantRow(addedId)).toMatchObject({
      revocationReason: 'employment_terminated',
    });
    expect((await grantRow(addedId)).revokedAt).not.toBeNull();
  });

  it('apply versus role revocation: the grant is revoked once, by whoever committed first', async () => {
    const t = await target();
    const date = day(5);
    const tid = await scheduled(t.employeeId, date);
    const gate = newGate();
    const revoking = roles(
      new GatedAuditAt(prisma, gate, 'ROLE_ASSIGNMENT_REVOKED'),
    ).revokeAssignment(fx!.users.hrA2!, t.grant, 'Covered elsewhere', {});
    revoking.catch(() => undefined);
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      apply(t.employeeId, tid, date),
    );
    expect(waited).toBe(true);
    gate.open();
    await revoking;
    await running;
    expect(await grantRow(t.grant)).toMatchObject({
      revokedByUserId: fx!.users.hrA2,
      revocationReason: 'Covered elsewhere',
    });
    expect(
      await prisma.auditLog.count({
        where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: t.grant },
      }),
    ).toBe(1);
  });

  it('apply versus role archiving: no deadlock, and each grant is revoked once', async () => {
    const t = await target();
    const date = day(5);
    const tid = await scheduled(t.employeeId, date);
    const gate = newGate();
    const archiving = roles(
      new GatedAuditAt(prisma, gate, 'ROLE_ARCHIVED'),
    ).archiveRole(fx!.users.hrA2!, t.roleA, {});
    archiving.catch(() => undefined);
    await gate.reached;
    const { running } = await runAgainst(gate, () =>
      apply(t.employeeId, tid, date),
    );
    gate.open();
    const [archived, applied] = await Promise.all([
      settle(archiving),
      settle(running),
    ]);
    expect(archived.ok).toBe(true);
    expect(applied.ok).toBe(true);
    const row = await grantRow(t.grant);
    expect(row.revokedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: t.grant },
      }),
    ).toBeLessThanOrEqual(1);
  });

  it('apply versus cancellation and versus rescheduling: serialized; a cancelled or moved termination revokes nothing', async () => {
    for (const [action, run] of [
      [
        'EMPLOYEE_TERMINATION_CANCELLED',
        (l: EmployeeLifecycleService, employeeId: string, tid: string) =>
          l.cancelTermination(employeeId, tid, {}, ctx(fx!.users.hrA2!)),
      ],
      [
        'EMPLOYEE_TERMINATION_RESCHEDULED',
        (l: EmployeeLifecycleService, employeeId: string, tid: string) =>
          l.rescheduleTermination(
            employeeId,
            tid,
            { terminationDate: day(9) },
            ctx(fx!.users.hrA2!),
          ),
      ],
    ] as const) {
      const t = await target();
      const date = day(5);
      const tid = await scheduled(t.employeeId, date);
      const gate = newGate();
      const changing = run(
        lifecycle(new GatedAuditAt(prisma, gate, action)),
        t.employeeId,
        tid,
      );
      changing.catch(() => undefined);
      await gate.reached;
      const { running, waited } = await runAgainst(gate, () =>
        apply(t.employeeId, tid, date),
      );
      expect(waited).toBe(true);
      gate.open();
      await changing;
      const applied = await settle(running);
      expect(applied.ok).toBe(false);
      expect((await grantRow(t.grant)).revokedAt).toBeNull();
    }
  });

  it('keep approval versus application, both orders: an approval first is honoured; a late one resurrects nothing', async () => {
    // Approval first.
    {
      const t = await target();
      const date = day(5);
      const tid = await scheduled(t.employeeId, date, [
        {
          roleAssignmentId: t.grant,
          decision: 'KEEP',
          reason: 'Handover of open approvals',
          keepUntil: after(date, 5).toISOString(),
        },
      ]);
      const decision =
        await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
          where: { terminationId: tid },
        });
      const gate = newGate();
      const approving = lifecycle(
        new GatedAuditAt(
          prisma,
          gate,
          'EMPLOYEE_TERMINATION_GRANT_KEEP_APPROVED',
        ),
      ).approveGrantKeep(
        t.employeeId,
        tid,
        decision.id,
        {},
        ctx(fx!.users.hrA2!),
      );
      approving.catch(() => undefined);
      await gate.reached;
      const { running, waited } = await runAgainst(gate, () =>
        apply(t.employeeId, tid, date),
      );
      expect(waited).toBe(true);
      gate.open();
      await approving;
      await running;
      const row =
        await prisma.employeeTerminationGrantDecision.findUniqueOrThrow({
          where: { id: decision.id },
        });
      expect(row.outcome).toBe('RETAINED');
    }
    // Application first.
    {
      const t = await target();
      const date = day(5);
      const tid = await scheduled(t.employeeId, date, [
        {
          roleAssignmentId: t.grant,
          decision: 'KEEP',
          reason: 'Handover of open approvals',
          keepUntil: after(date, 5).toISOString(),
        },
      ]);
      const decision =
        await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
          where: { terminationId: tid },
        });
      const gate = newGate();
      const applying = apply(
        t.employeeId,
        tid,
        date,
        lifecycle(new GatedAuditAt(prisma, gate, 'EMPLOYEE_TERMINATED')),
      );
      applying.catch(() => undefined);
      await gate.reached;
      const { running, waited } = await runAgainst(gate, () =>
        lifecycle().approveGrantKeep(
          t.employeeId,
          tid,
          decision.id,
          {},
          ctx(fx!.users.hrA2!),
        ),
      );
      expect(waited).toBe(true);
      gate.open();
      await applying;
      const approval = await settle(running);
      expect(approval.ok).toBe(false);
      expect(codeOf((approval as { error: unknown }).error)).toBe(
        'TERMINATION_NOT_SCHEDULED',
      );
      expect((await grantRow(t.grant)).revokedAt).not.toBeNull();
      expect(
        await prisma.roleAssignment.count({
          where: { userId: t.userId, revokedAt: null },
        }),
      ).toBe(0);
    }
  });

  it('worker versus manual application: one application, one revocation entry', async () => {
    const t = await target();
    const date = day(5);
    const tid = await scheduled(t.employeeId, date);
    const gate = newGate();
    const manual = apply(
      t.employeeId,
      tid,
      date,
      lifecycle(new GatedAuditAt(prisma, gate, 'EMPLOYEE_TERMINATED')),
    );
    manual.catch(() => undefined);
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      lifecycle().processDueTerminations(after(date)),
    );
    expect(waited).toBe(true);
    gate.open();
    await manual;
    const worker = (await running) as {
      completed: string[];
      failed: unknown[];
    };
    expect(worker.completed).not.toContain(tid);
    expect(worker.failed).toHaveLength(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: t.grant },
      }),
    ).toBe(1);
  });

  it('last retained grant expiry versus role creation: a grant committed first keeps the login', async () => {
    const t = await target();
    const date = day(1);
    const keepUntil = after(date, 3);
    const tid = await scheduled(t.employeeId, date, [
      {
        roleAssignmentId: t.grant,
        decision: 'KEEP',
        reason: 'Closing the open timesheets',
        keepUntil: keepUntil.toISOString(),
      },
    ]);
    const decision =
      await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: tid },
      });
    await lifecycle().approveGrantKeep(
      t.employeeId,
      tid,
      decision.id,
      {},
      ctx(fx!.users.hrA2!),
    );
    await apply(t.employeeId, tid, date);
    const roleB = await role(fx!.orgB);
    const gate = newGate();
    const adding = hold(gate, (tx) =>
      tx.roleAssignment.create({ data: grantData(t.userId, roleB, fx!.orgB) }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      lifecycle().processDueTerminations(
        new Date(keepUntil.getTime() + 60_000),
      ),
    );
    expect(waited).toBe(true);
    gate.open();
    await adding;
    await running;
    // The new grant in B authorizes something: the login stays.
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
    ).toBe('ACTIVE');
  });

  it('cross-organization access changing during application: a grant outside the termination is kept with the login', async () => {
    const t = await target();
    const date = day(5);
    const tid = await scheduled(t.employeeId, date);
    const orgC = (
      await prisma.organization.create({
        data: { name: 'M3 race C', code: `M3RC-${fx!.suffix}` },
      })
    ).id;
    created.orgs.push(orgC);
    const roleC = await role(orgC);
    const gate = newGate();
    let addedId = '';
    const adding = hold(gate, async (tx) => {
      addedId = (
        await tx.roleAssignment.create({
          data: grantData(t.userId, roleC, orgC),
        })
      ).id;
    });
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      apply(t.employeeId, tid, date),
    );
    expect(waited).toBe(true);
    gate.open();
    await adding;
    await running;
    expect((await grantRow(addedId)).revokedAt).toBeNull();
    expect((await grantRow(t.grant)).revokedAt).not.toBeNull();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
    ).toBe('ACTIVE');
  });

  // ─── Decision A: retained-grant expiry reconciliation (independent of lifecycle automation) ──

  /** Lifecycle automation explicitly off: the reconciliation must not depend on it. */
  const AUTOMATION_OFF = { EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'false' };
  const reconcile = (now: Date, limit?: number) =>
    runReconcileRetainedGrantsJob(
      {},
      { prisma, now, env: AUTOMATION_OFF, ...(limit ? { limit } : {}) },
    );

  /** Terminates `t` (applied) keeping its grant in A, approved, until `keepDays` after. */
  async function retained(t: Awaited<ReturnType<typeof target>>, keepDays = 3) {
    const date = day(1);
    const keepUntil = after(date, keepDays);
    const tid = await scheduled(t.employeeId, date, [
      {
        roleAssignmentId: t.grant,
        decision: 'KEEP',
        reason: 'Closing the open timesheets',
        keepUntil: keepUntil.toISOString(),
      },
    ]);
    const decision =
      await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: tid },
      });
    await lifecycle().approveGrantKeep(
      t.employeeId,
      tid,
      decision.id,
      {},
      ctx(fx!.users.hrA2!),
    );
    await apply(t.employeeId, tid, date);
    const kept =
      await prisma.employeeTerminationGrantDecision.findUniqueOrThrow({
        where: { id: decision.id },
      });
    expect(kept.outcome).toBe('RETAINED');
    return {
      tid,
      decisionId: decision.id,
      retainedGrant: kept.retainedRoleAssignmentId!,
      keepUntil,
      before: new Date(keepUntil.getTime() - 60_000),
      expired: new Date(keepUntil.getTime() + 60_000),
    };
  }
  const userStatus = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).status;
  const auditCount = (action: string, entityId: string) =>
    prisma.auditLog.count({ where: { action, entityId } });

  it('A1–4, 16: with lifecycle automation off, the job disables the login once the last retained grant expires (sessions ended, audited, attributed to the worker)', async () => {
    const t = await target();
    const r = await retained(t);
    expect(await userStatus(t.userId)).toBe('ACTIVE');
    const session = await prisma.authSession.create({
      data: {
        userId: t.userId,
        refreshTokenHash: `m3-reconcile-${randomUUID()}`,
        expiresAt: new Date(r.expired.getTime() + 30 * DAY),
      },
    });
    // The gap this closes: with lifecycle automation off, the due-terminations job does nothing,
    // so the expired retention left the login enabled.
    const gated = await runApplyDueTerminationsJob(
      {},
      { prisma, now: r.expired, env: AUTOMATION_OFF },
    );
    expect(gated.disabled).toBe(true);
    expect(await userStatus(t.userId)).toBe('ACTIVE');
    // Before the expiry nothing changes.
    const early = await reconcile(r.before);
    expect(early.handled).not.toContain(t.employeeId);
    expect(await userStatus(t.userId)).toBe('ACTIVE');
    // After it: disabled, sessions ended, one audit each, no administrator credited.
    const late = await reconcile(r.expired);
    expect(late.handled).toContain(t.employeeId);
    expect(late.failed).toEqual([]);
    expect(await userStatus(t.userId)).toBe('DISABLED');
    expect(
      (
        await prisma.authSession.findUniqueOrThrow({
          where: { id: session.id },
        })
      ).revokedAt,
    ).not.toBeNull();
    const disabled = await prisma.auditLog.findMany({
      where: { action: 'EMPLOYEE_ACCOUNT_DISABLED', entityId: t.employeeId },
    });
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({
      actorUserId: null,
      userAgent: 'hrms-worker',
    });
    expect(disabled[0]!.metadata).toMatchObject({
      reason: 'retention_expired',
      automatic: true,
    });
    const reconciled = await prisma.auditLog.findMany({
      where: {
        action: 'EMPLOYEE_TERMINATION_RETENTION_EXPIRED',
        entityId: t.employeeId,
      },
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.actorUserId).toBeNull();
    expect(reconciled[0]!.metadata).toMatchObject({
      source: 'AUTOMATIC',
      loginDisabled: true,
      retainedRoleAssignmentIds: [r.retainedGrant],
    });
    // History is kept: the retained grant row, the decision and the termination remain.
    expect((await grantRow(r.retainedGrant)).revokedAt).toBeNull();
    expect(
      (
        await prisma.employeeTerminationGrantDecision.findUniqueOrThrow({
          where: { id: r.decisionId },
        })
      ).expiryHandledAt,
    ).not.toBeNull();
    expect(
      (
        await prisma.employeeTermination.findUniqueOrThrow({
          where: { id: r.tid },
        })
      ).status,
    ).toBe('APPLIED');
  });

  it('A5–6: an active grant in a second organization keeps the login and is left as it is', async () => {
    const t = await target();
    const r = await retained(t);
    const roleB = await role(fx!.orgB);
    const grantB = await prisma.roleAssignment.create({
      data: grantData(t.userId, roleB, fx!.orgB),
    });
    const outcome = await reconcile(r.expired);
    expect(outcome.handled).toContain(t.employeeId);
    expect(await userStatus(t.userId)).toBe('ACTIVE');
    expect((await grantRow(grantB.id)).revokedAt).toBeNull();
    expect(await auditCount('EMPLOYEE_ACCOUNT_DISABLED', t.employeeId)).toBe(0);
    const [reconciled] = await prisma.auditLog.findMany({
      where: {
        action: 'EMPLOYEE_TERMINATION_RETENTION_EXPIRED',
        entityId: t.employeeId,
      },
    });
    expect(reconciled!.metadata).toMatchObject({ loginDisabled: false });
  });

  it('A7–8: a future-start grant is not yet effective, and expired or revoked grants never count as authority', async () => {
    const t = await target();
    const r = await retained(t);
    const roleB = await role(fx!.orgB);
    const future = await prisma.roleAssignment.create({
      data: {
        ...grantData(t.userId, roleB, fx!.orgB),
        startsAt: new Date(r.expired.getTime() + 10 * DAY),
      },
    });
    const roleB2 = await role(fx!.orgB);
    await prisma.roleAssignment.create({
      data: {
        ...grantData(t.userId, roleB2, fx!.orgB),
        expiresAt: new Date(r.expired.getTime() - DAY),
      },
    });
    const roleB3 = await role(fx!.orgB);
    await prisma.roleAssignment.create({
      data: {
        ...grantData(t.userId, roleB3, fx!.orgB),
        revokedAt: new Date(r.expired.getTime() - DAY),
      },
    });
    await reconcile(r.expired);
    // The existing effective-grant rules: not started, expired and revoked grants authorize
    // nothing, so the login is disabled; the future grant itself is not touched.
    expect(await userStatus(t.userId)).toBe('DISABLED');
    expect((await grantRow(future.id)).revokedAt).toBeNull();
  });

  it('A9: running again changes nothing and writes nothing', async () => {
    const t = await target();
    const r = await retained(t);
    await reconcile(r.expired);
    const again = await reconcile(new Date(r.expired.getTime() + 60_000));
    expect(again.handled).not.toContain(t.employeeId);
    expect(await auditCount('EMPLOYEE_ACCOUNT_DISABLED', t.employeeId)).toBe(1);
    expect(
      await auditCount('EMPLOYEE_TERMINATION_RETENTION_EXPIRED', t.employeeId),
    ).toBe(1);
  });

  it('A10: two reconciliation workers on the same employee serialize; one disablement, one audit each', async () => {
    const t = await target();
    const r = await retained(t);
    const gate = newGate();
    const first = settle(
      lifecycle(
        new GatedAuditAt(
          prisma,
          gate,
          'EMPLOYEE_TERMINATION_RETENTION_EXPIRED',
        ),
      ).reconcileRetainedGrants(r.expired),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      reconcile(r.expired),
    );
    expect(waited).toBe(true);
    gate.open();
    const [one, two] = await Promise.all([first, settle(running)]);
    expect(one.ok && two.ok).toBe(true);
    expect(await userStatus(t.userId)).toBe('DISABLED');
    expect(await auditCount('EMPLOYEE_ACCOUNT_DISABLED', t.employeeId)).toBe(1);
    expect(
      await auditCount('EMPLOYEE_TERMINATION_RETENTION_EXPIRED', t.employeeId),
    ).toBe(1);
  });

  it('A11: a grant being created while the job runs: committed first, it keeps the login', async () => {
    const t = await target();
    const r = await retained(t);
    const roleB = await role(fx!.orgB);
    const gate = newGate();
    const adding = hold(gate, (tx) =>
      tx.roleAssignment.create({ data: grantData(t.userId, roleB, fx!.orgB) }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      reconcile(r.expired),
    );
    expect(waited).toBe(true);
    gate.open();
    await adding;
    await running;
    expect(await userStatus(t.userId)).toBe('ACTIVE');
  });

  it('A11b: the last other grant being revoked while the job runs: the job waits, then disables', async () => {
    const t = await target();
    const r = await retained(t);
    const roleB = await role(fx!.orgB);
    const grantB = await prisma.roleAssignment.create({
      data: grantData(t.userId, roleB, fx!.orgB),
    });
    const gate = newGate();
    const revoking = hold(gate, (tx) =>
      tx.roleAssignment.update({
        where: { id: grantB.id },
        data: { revokedAt: new Date() },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      reconcile(r.expired),
    );
    expect(waited).toBe(true);
    gate.open();
    await revoking;
    await running;
    // Seen after the revocation committed: nothing authorizes the login any more.
    expect(await userStatus(t.userId)).toBe('DISABLED');
  });

  it('A11c: an account action holding the login row makes the job wait (serialized with M1 account changes)', async () => {
    const t = await target();
    const r = await retained(t);
    const gate = newGate();
    const holding = hold(gate, (tx) =>
      tx.$queryRawUnsafe(
        'SELECT "id" FROM "User" WHERE "id" = $1::uuid FOR UPDATE',
        t.userId,
      ),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      reconcile(r.expired),
    );
    expect(waited).toBe(true);
    gate.open();
    await holding;
    await running;
    expect(await userStatus(t.userId)).toBe('DISABLED');
  });

  it('A12–13: one employee failing never stops the others; the failure is reported and a later run retries it', async () => {
    const first = await target();
    const second = await target();
    const r1 = await retained(first);
    const r2 = await retained(second);
    const expired = new Date(
      Math.max(r1.expired.getTime(), r2.expired.getTime()),
    );
    const fn = `m3_fail_${fx!.suffix.toLowerCase()}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."id" = '${first.userId}'::uuid THEN RAISE EXCEPTION 'injected reconciliation failure'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      const outcome = await reconcile(expired);
      expect(outcome.failed.map((f) => f.employeeId)).toContain(
        first.employeeId,
      );
      expect(outcome.handled).toContain(second.employeeId);
      expect(await userStatus(second.userId)).toBe('DISABLED');
      expect(await userStatus(first.userId)).toBe('ACTIVE');
      // Nothing of the failed employee was half-written.
      expect(
        (
          await prisma.employeeTerminationGrantDecision.findUniqueOrThrow({
            where: { id: r1.decisionId },
          })
        ).expiryHandledAt,
      ).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "User"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    const retry = await reconcile(new Date(expired.getTime() + 60_000));
    expect(retry.handled).toContain(first.employeeId);
    expect(await userStatus(first.userId)).toBe('DISABLED');
  });

  it('A14–15: the job never applies a due termination and never changes assignments, payroll or time records', async () => {
    const t = await target();
    const r = await retained(t);
    const other = await target();
    const date = day(1);
    const due = await scheduled(other.employeeId, date);
    const snapshot = async () => ({
      termination: (
        await prisma.employeeTermination.findUniqueOrThrow({
          where: { id: due },
        })
      ).status,
      assignments: await prisma.employmentAssignment.findMany({
        where: { employeeId: { in: [t.employeeId, other.employeeId] } },
        select: { id: true, status: true, endDate: true },
        orderBy: { id: 'asc' },
      }),
      otherGrant: (await grantRow(other.grant)).revokedAt,
      timeEntries: await prisma.timeEntry.count({
        where: { employeeId: { in: [t.employeeId, other.employeeId] } },
      }),
      payrollRows: await prisma.payrollRunEmployee.count({
        where: { employeeId: { in: [t.employeeId, other.employeeId] } },
      }),
    });
    const before = await snapshot();
    await reconcile(
      new Date(Math.max(r.expired.getTime(), after(date).getTime())),
    );
    expect(await snapshot()).toEqual(before);
    expect(before.termination).toBe('SCHEDULED');
    expect(await userStatus(other.userId)).toBe('ACTIVE');
  });

  it('A16 (re-review M1): a retained grant that has not started yet is not reconciled early; when it later ends, the login is disabled', async () => {
    const t = await target();
    const date = day(1);
    // A second grant in A that only starts after the last day (kept as a future window).
    const roleLater = await role(fx!.orgA);
    const later = await prisma.roleAssignment.create({
      data: {
        ...grantData(t.userId, roleLater, fx!.orgA),
        startsAt: after(date, 5),
      },
    });
    const firstUntil = after(date, 3);
    const laterUntil = after(date, 20);
    const tid = await scheduled(t.employeeId, date, [
      {
        roleAssignmentId: t.grant,
        decision: 'KEEP',
        reason: 'Closing the open timesheets',
        keepUntil: firstUntil.toISOString(),
      },
      {
        roleAssignmentId: later.id,
        decision: 'KEEP',
        reason: 'Covering the January payroll close',
        keepUntil: laterUntil.toISOString(),
      },
    ]);
    for (const decision of await prisma.employeeTerminationGrantDecision.findMany(
      {
        where: { terminationId: tid, decision: 'KEEP' },
      },
    ))
      await lifecycle().approveGrantKeep(
        t.employeeId,
        tid,
        decision.id,
        {},
        ctx(fx!.users.hrA2!),
      );
    await apply(t.employeeId, tid, date);
    // Another organization's grant keeps the login open during the first run.
    const roleB = await role(fx!.orgB);
    const grantB = await prisma.roleAssignment.create({
      data: grantData(t.userId, roleB, fx!.orgB),
    });
    const first = await reconcile(new Date(firstUntil.getTime() + 60_000));
    expect(first.handled).toContain(t.employeeId);
    expect(await userStatus(t.userId)).toBe('ACTIVE');
    // The not-yet-started keep was not marked handled.
    const laterDecision =
      await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: tid, roleAssignmentId: later.id },
      });
    expect(laterDecision.outcome).toBe('RETAINED');
    expect(laterDecision.expiryHandledAt).toBeNull();
    // B goes away; once the later keep has also ended, the login is disabled.
    await prisma.roleAssignment.update({
      where: { id: grantB.id },
      data: { revokedAt: new Date() },
    });
    const last = await reconcile(new Date(laterUntil.getTime() + 60_000));
    expect(last.handled).toContain(t.employeeId);
    expect(await userStatus(t.userId)).toBe('DISABLED');
  });

  it('C11b (re-review L2): the approver losing their authority while the approval runs: the approval waits, then is refused', async () => {
    const t = await target();
    const tid = await scheduled(t.employeeId, day(5), [
      {
        roleAssignmentId: t.grant,
        decision: 'KEEP',
        reason: 'Closing the open timesheets',
        keepUntil: after(day(5), 3).toISOString(),
      },
    ]);
    const decision =
      await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: tid },
      });
    const approverGrants = await prisma.roleAssignment.findMany({
      where: { userId: fx!.users.hrA2!, revokedAt: null },
      select: { id: true },
    });
    const gate = newGate();
    const revoking = hold(gate, (tx) =>
      tx.roleAssignment.updateMany({
        where: { id: { in: approverGrants.map((g) => g.id) } },
        data: { revokedAt: new Date() },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      lifecycle().approveGrantKeep(
        t.employeeId,
        tid,
        decision.id,
        {},
        ctx(fx!.users.hrA2!),
      ),
    );
    expect(waited).toBe(true);
    gate.open();
    await revoking;
    const result = await settle(running);
    expect(result.ok).toBe(false);
    expect(codeOf(!result.ok && result.error)).toBe(
      'TERMINATION_KEEP_NOT_AUTHORIZED',
    );
    const refused = await prisma.auditLog.findMany({
      where: {
        action: 'EMPLOYEE_TERMINATION_GRANT_KEEP_REVIEW_REFUSED',
        entityId: t.employeeId,
      },
    });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.metadata).toMatchObject({
      decisionId: decision.id,
      action: 'APPROVE',
      code: 'TERMINATION_KEEP_NOT_AUTHORIZED',
    });
    expect(
      (
        await prisma.employeeTerminationGrantDecision.findUniqueOrThrow({
          where: { id: decision.id },
        })
      ).status,
    ).toBe('REQUESTED');
  });

  it('C11: a permission added to the kept role while the approval runs: the approval waits and checks the new permission set', async () => {
    const t = await target();
    const tid = await scheduled(t.employeeId, day(5), [
      {
        roleAssignmentId: t.grant,
        decision: 'KEEP',
        reason: 'Closing the open timesheets',
        keepUntil: after(day(5), 3).toISOString(),
      },
    ]);
    const decision =
      await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: tid },
      });
    // hrA2 can delegate time.clock but not payroll.calculate.
    const payroll = await prisma.permission.upsert({
      where: { key: 'payroll.calculate' },
      create: {
        key: 'payroll.calculate',
        name: 'payroll.calculate',
        isActive: true,
      },
      update: {},
    });
    const gate = newGate();
    const widening = hold(gate, (tx) =>
      tx.rolePermission.create({
        data: { roleId: t.roleA, permissionId: payroll.id },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      lifecycle().approveGrantKeep(
        t.employeeId,
        tid,
        decision.id,
        {},
        ctx(fx!.users.hrA2!),
      ),
    );
    expect(waited).toBe(true);
    gate.open();
    await widening;
    const result = await settle(running);
    expect(result.ok).toBe(false);
    expect(codeOf(!result.ok && result.error)).toBe(
      'TERMINATION_KEEP_NOT_AUTHORIZED',
    );
    expect(
      (
        await prisma.employeeTerminationGrantDecision.findUniqueOrThrow({
          where: { id: decision.id },
        })
      ).status,
    ).toBe('REQUESTED');
  });

  // ─── Final M3 change: KEEP approvals revalidated at application (committed data) ─────────

  /** An approved KEEP of `t`'s grant in A, approved by hrA2; the termination is due tomorrow. */
  async function approvedKeepOf(t: Awaited<ReturnType<typeof target>>) {
    const date = day(1);
    const tid = await scheduled(t.employeeId, date, [
      {
        roleAssignmentId: t.grant,
        decision: 'KEEP',
        reason: 'Closing the open timesheets',
        keepUntil: after(date, 5).toISOString(),
      },
    ]);
    const decision =
      await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: tid, roleAssignmentId: t.grant },
      });
    await lifecycle().approveGrantKeep(
      t.employeeId,
      tid,
      decision.id,
      {},
      ctx(fx!.users.hrA2!),
    );
    return { tid, decisionId: decision.id, date };
  }
  const decisionRow = (id: string) =>
    prisma.employeeTerminationGrantDecision.findUniqueOrThrow({
      where: { id },
    });
  const revalidationFailures = (employeeId: string) =>
    prisma.auditLog.findMany({
      where: {
        action: 'EMPLOYEE_TERMINATION_GRANT_KEEP_REVALIDATION_FAILED',
        entityId: employeeId,
      },
    });
  const approverGrantIds = async () =>
    (
      await prisma.roleAssignment.findMany({
        where: { userId: fx!.users.hrA2!, revokedAt: null },
        select: { id: true },
      })
    ).map((g) => g.id);

  it('K1: the approver losing authority before the application commits: the application waits, then revokes the grant', async () => {
    const t = await target();
    const k = await approvedKeepOf(t);
    const ids = await approverGrantIds();
    const gate = newGate();
    const revoking = hold(gate, (tx) =>
      tx.roleAssignment.updateMany({
        where: { id: { in: ids } },
        data: { revokedAt: new Date() },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      apply(t.employeeId, k.tid, k.date),
    );
    expect(waited).toBe(true);
    gate.open();
    await revoking;
    await running;
    expect(await decisionRow(k.decisionId)).toMatchObject({
      outcome: 'REVOKED',
      retainedRoleAssignmentId: null,
    });
    expect((await grantRow(t.grant)).revokedAt).not.toBeNull();
    const [failure] = await revalidationFailures(t.employeeId);
    expect(failure!.metadata).toMatchObject({
      reason: 'APPROVER_NOT_AUTHORIZED',
    });
  });

  it('K2: the application committing first: the approver’s revocation waits; the keep was valid and is retained', async () => {
    const t = await target();
    const k = await approvedKeepOf(t);
    const ids = await approverGrantIds();
    const gate = newGate();
    const applying = settle(
      apply(
        t.employeeId,
        k.tid,
        k.date,
        lifecycle(new GatedAuditAt(prisma, gate, 'ROLE_ASSIGNMENT_RETAINED')),
      ),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      prisma.roleAssignment.updateMany({
        where: { id: { in: ids } },
        data: { revokedAt: new Date() },
      }),
    );
    expect(waited).toBe(true);
    gate.open();
    expect((await applying).ok).toBe(true);
    await running;
    expect((await decisionRow(k.decisionId)).outcome).toBe('RETAINED');
    expect(await revalidationFailures(t.employeeId)).toHaveLength(0);
  });

  it('K3: a permission added to the kept role before the application commits: the application waits, then revokes', async () => {
    const t = await target();
    const k = await approvedKeepOf(t);
    const payroll = await prisma.permission.upsert({
      where: { key: 'payroll.calculate' },
      create: {
        key: 'payroll.calculate',
        name: 'payroll.calculate',
        isActive: true,
      },
      update: {},
    });
    const gate = newGate();
    const widening = hold(gate, (tx) =>
      tx.rolePermission.create({
        data: { roleId: t.roleA, permissionId: payroll.id },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      apply(t.employeeId, k.tid, k.date),
    );
    expect(waited).toBe(true);
    gate.open();
    await widening;
    await running;
    expect((await decisionRow(k.decisionId)).outcome).toBe('REVOKED');
    const [failure] = await revalidationFailures(t.employeeId);
    expect(failure!.metadata).toMatchObject({
      reason: 'APPROVER_NOT_AUTHORIZED',
    });
  });

  it('K4: the application committing first: the permission change waits; the keep is retained against the role as it was', async () => {
    const t = await target();
    const k = await approvedKeepOf(t);
    const payroll = await prisma.permission.upsert({
      where: { key: 'payroll.calculate' },
      create: {
        key: 'payroll.calculate',
        name: 'payroll.calculate',
        isActive: true,
      },
      update: {},
    });
    const gate = newGate();
    const applying = settle(
      apply(
        t.employeeId,
        k.tid,
        k.date,
        lifecycle(new GatedAuditAt(prisma, gate, 'ROLE_ASSIGNMENT_RETAINED')),
      ),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      prisma.rolePermission.create({
        data: { roleId: t.roleA, permissionId: payroll.id },
      }),
    );
    expect(waited).toBe(true);
    gate.open();
    expect((await applying).ok).toBe(true);
    await running;
    expect((await decisionRow(k.decisionId)).outcome).toBe('RETAINED');
  });

  it('K5: the kept role archived before the application commits: the application waits, then revokes (role ineligible)', async () => {
    const t = await target();
    const k = await approvedKeepOf(t);
    const gate = newGate();
    const archiving = hold(gate, (tx) =>
      tx.role.update({
        where: { id: t.roleA },
        data: { archivedAt: new Date() },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      apply(t.employeeId, k.tid, k.date),
    );
    expect(waited).toBe(true);
    gate.open();
    await archiving;
    await running;
    expect((await decisionRow(k.decisionId)).outcome).toBe('REVOKED');
    const [failure] = await revalidationFailures(t.employeeId);
    expect(failure!.metadata).toMatchObject({ reason: 'ROLE_INELIGIBLE' });
  });

  // SYSTEM keeps need System Owners (committed): the reserved role, reused if it exists.
  async function systemOwner() {
    let ownerRole = await prisma.role.findFirst({
      where: { isSystemOwner: true },
    });
    if (!ownerRole) {
      ownerRole = await prisma.role.create({
        data: {
          organizationId: null,
          code: 'SYSTEM_OWNER',
          name: 'System Owner',
          isSystemOwner: true,
        },
      });
      created.roles.push(ownerRole.id);
    }
    for (const key of [...ADMIN, 'role.manage', 'time.clock']) {
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { key },
      });
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: ownerRole.id,
            permissionId: permission.id,
          },
        },
        create: { roleId: ownerRole.id, permissionId: permission.id },
        update: {},
      });
    }
    const person = await prisma.person.create({ data: {} });
    created.persons.push(person.id);
    const user = await prisma.user.create({
      data: {
        personId: person.id,
        email: `m3-owner-${randomUUID().slice(0, 8)}@example.com`,
        status: 'ACTIVE',
        passwordHash: 'not-a-real-hash',
      },
    });
    created.users.push(user.id);
    const grant = await prisma.roleAssignment.create({
      data: {
        userId: user.id,
        roleId: ownerRole.id,
        roleOrganizationId: null,
        scopeType: 'SYSTEM',
        startsAt: GRANTS_FROM,
      },
    });
    return { userId: user.id, grant: grant.id, roleId: ownerRole.id };
  }

  /** `t` also holds a SYSTEM grant, kept by owner1's request and owner2's approval. */
  async function systemKeep() {
    const t = await target();
    const owner1 = await systemOwner();
    const owner2 = await systemOwner();
    const systemGrant = await prisma.roleAssignment.create({
      data: {
        userId: t.userId,
        roleId: owner1.roleId,
        roleOrganizationId: null,
        scopeType: 'SYSTEM',
        startsAt: GRANTS_FROM,
      },
    });
    const date = day(1);
    const tid = (
      await lifecycle().terminate(
        t.employeeId,
        {
          terminationDate: date,
          grantDecisions: [
            {
              roleAssignmentId: systemGrant.id,
              decision: 'KEEP',
              reason: 'Handover of the payroll provider integration',
              keepUntil: after(date, 5).toISOString(),
            },
          ],
        },
        ctx(owner1.userId),
      )
    ).termination.id;
    const decision =
      await prisma.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: tid, roleAssignmentId: systemGrant.id },
      });
    await lifecycle().approveGrantKeep(
      t.employeeId,
      tid,
      decision.id,
      {},
      ctx(owner2.userId),
    );
    return {
      t,
      owner1,
      owner2,
      systemGrant: systemGrant.id,
      tid,
      decisionId: decision.id,
      date,
    };
  }

  it('K6: the SYSTEM approver losing authority while the application runs: it waits, then fails closed and changes nothing', async () => {
    const s = await systemKeep();
    const before = await prisma.employmentAssignment.findMany({
      where: { employeeId: s.t.employeeId },
      select: { id: true, status: true, endDate: true },
    });
    const gate = newGate();
    const revoking = hold(gate, (tx) =>
      tx.roleAssignment.update({
        where: { id: s.owner2.grant },
        data: { revokedAt: new Date() },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      lifecycle().applyTermination(
        s.t.employeeId,
        s.tid,
        ctx(s.owner1.userId),
        after(s.date),
      ),
    );
    expect(waited).toBe(true);
    gate.open();
    await revoking;
    const result = await settle(running);
    expect(result.ok).toBe(false);
    expect(codeOf(!result.ok && result.error)).toBe(
      'TERMINATION_KEEP_APPROVAL_INVALID',
    );
    // Atomic: no assignment ended, no grant revoked or created, the login untouched.
    expect(
      await prisma.employmentAssignment.findMany({
        where: { employeeId: s.t.employeeId },
        select: { id: true, status: true, endDate: true },
      }),
    ).toEqual(before);
    expect((await grantRow(s.systemGrant)).revokedAt).toBeNull();
    expect((await grantRow(s.t.grant)).revokedAt).toBeNull();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: s.t.userId } }))
        .status,
    ).toBe('ACTIVE');
    expect(
      (
        await prisma.employeeTermination.findUniqueOrThrow({
          where: { id: s.tid },
        })
      ).status,
    ).toBe('SCHEDULED');
    // The worker reports it as blocked, and changes nothing either.
    const run = await lifecycle().processDueTerminations(after(s.date));
    expect(run.blocked).toContainEqual({
      terminationId: s.tid,
      code: 'TERMINATION_KEEP_APPROVAL_INVALID',
    });
    expect((await grantRow(s.systemGrant)).revokedAt).toBeNull();
  });

  it('K7: a fresh SYSTEM approval racing the application: approval first lets it apply; application first is blocked, then the approval proceeds', async () => {
    const s = await systemKeep();
    await prisma.roleAssignment.update({
      where: { id: s.owner2.grant },
      data: { revokedAt: new Date() },
    });
    const owner3 = await systemOwner();
    const rerequest = () =>
      lifecycle().recordGrantDecisions(
        s.t.employeeId,
        s.tid,
        {
          decisions: [
            {
              roleAssignmentId: s.systemGrant,
              decision: 'KEEP',
              reason: 'Handover of the payroll provider integration',
              keepUntil: after(s.date, 5).toISOString(),
            },
          ],
        },
        ctx(s.owner1.userId),
      );
    // Order 1: the application first — blocked, nothing changes; the approval then proceeds.
    await rerequest();
    const blocked = await settle(
      lifecycle().applyTermination(
        s.t.employeeId,
        s.tid,
        ctx(s.owner1.userId),
        after(s.date),
      ),
    );
    expect(blocked.ok).toBe(false);
    expect(codeOf(!blocked.ok && blocked.error)).toBe(
      'TERMINATION_KEEP_APPROVAL_REQUIRED',
    );
    // Order 2: the approval holding the lifecycle lock — the application waits, then applies
    // with the fresh approval and retains the grant.
    const gate = newGate();
    const approving = settle(
      lifecycle(
        new GatedAuditAt(
          prisma,
          gate,
          'EMPLOYEE_TERMINATION_GRANT_KEEP_APPROVED',
        ),
      ).approveGrantKeep(
        s.t.employeeId,
        s.tid,
        s.decisionId,
        {},
        ctx(owner3.userId),
      ),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      lifecycle().applyTermination(
        s.t.employeeId,
        s.tid,
        ctx(s.owner1.userId),
        after(s.date),
      ),
    );
    expect(waited).toBe(true);
    gate.open();
    expect((await approving).ok).toBe(true);
    const applied = await settle(running);
    expect(applied.ok).toBe(true);
    expect((await decisionRow(s.decisionId)).outcome).toBe('RETAINED');
  });

  it('K6b (review M1): the worker meeting a SYSTEM approval invalidated under its locks reports it as blocked, not failed, and changes nothing', async () => {
    const s = await systemKeep();
    const gate = newGate();
    const revoking = hold(gate, (tx) =>
      tx.roleAssignment.update({
        where: { id: s.owner2.grant },
        data: { revokedAt: new Date() },
      }),
    );
    await gate.reached;
    const { running, waited } = await runAgainst(gate, () =>
      lifecycle().processDueTerminations(after(s.date)),
    );
    expect(waited).toBe(true);
    gate.open();
    await revoking;
    const run = (await running) as Awaited<
      ReturnType<EmployeeLifecycleService['processDueTerminations']>
    >;
    expect(run.blocked).toContainEqual({
      terminationId: s.tid,
      code: 'TERMINATION_KEEP_APPROVAL_INVALID',
    });
    expect(run.failed.map((f) => f.terminationId)).not.toContain(s.tid);
    expect((await grantRow(s.systemGrant)).revokedAt).toBeNull();
    expect(
      (
        await prisma.employeeTermination.findUniqueOrThrow({
          where: { id: s.tid },
        })
      ).status,
    ).toBe('SCHEDULED');
  });
});
