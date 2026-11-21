import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditViewerService } from '../src/audit/audit-viewer.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { EmployeeAccountService } from '../src/employee/employee-account.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  authServices,
  createLogin,
  META,
  PASSWORD,
  RecordingEmails,
  statusOf,
} from './support/auth-fixtures.js';
import {
  createSchedulingFixtures,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const AUDIT_READ = 'audit.read';
const MANAGE = 'employee.account.manage';
const USERS = {
  auditorA: [{ permissions: [AUDIT_READ], scope: 'org' as const }],
  auditorB: [{ permissions: [AUDIT_READ], scope: 'orgB' as const }],
  hrA: [{ permissions: [MANAGE], scope: 'org' as const }],
  hrB: [{ permissions: [MANAGE], scope: 'orgB' as const }],
  hrBoth: [
    { permissions: [MANAGE], scope: 'org' as const },
    { permissions: [MANAGE], scope: 'orgB' as const },
  ],
};

/**
 * Batch 2: account events (sign-in, password, sessions, administrator actions on a login) are
 * visible to exactly the organizations the account works in or administers when the event
 * happens; accounts with no organization appear only in the System view.
 */
describe('Audit visibility of account events (database)', () => {
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
      client: PrismaService;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          await run({ tx, fx, client: rollbackClient(tx) }).catch(
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

  /** A position in organization B (the shared fixtures place every position in A). */
  async function positionInOrgB(tx: Tx, fx: SchedulingFixtures) {
    const title = await tx.jobTitle.create({
      data: {
        organizationId: fx.orgB,
        name: 'B Associate',
        code: `JB-${fx.suffix}`,
      },
    });
    return (
      await tx.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: title.id,
          name: 'B Associate',
          code: `PB-${fx.suffix}`,
        },
      })
    ).id;
  }

  /** An employee with a login and the given assignments. */
  async function employeeLogin(
    tx: Tx,
    fx: SchedulingFixtures,
    label: string,
    assignments: Array<{
      positionId: string;
      status: 'ACTIVE' | 'PLANNED' | 'ENDED';
    }>,
  ) {
    const account = await createLogin(tx, fx, label);
    const employee = await tx.employee.create({
      data: {
        personId: account.personId,
        employeeNumber: `AV-${label}-${fx.suffix}`,
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    for (const [index, assignment] of assignments.entries()) {
      await tx.employmentAssignment.create({
        data: {
          employeeId: employee.id,
          positionId: assignment.positionId,
          employmentType: 'PART_TIME',
          status: assignment.status,
          isPrimary: index === 0,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          ...(assignment.status === 'ENDED'
            ? { endDate: new Date('2026-06-30T00:00:00.000Z') }
            : {}),
        },
      });
    }
    return account;
  }

  /**
   * A System-scope audit reader. Only the singleton System Owner role can be held at System
   * scope, so the System view is in practice the deployment owner's.
   */
  async function systemAuditor(tx: Tx, fx: SchedulingFixtures) {
    const auditor = await createLogin(tx, fx, 'sysaudit');
    const role =
      (await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
      (await tx.role.create({
        data: {
          organizationId: null,
          code: 'SYSTEM_OWNER',
          name: 'System Owner',
          isSystemOwner: true,
        },
      }));
    for (const key of [AUDIT_READ, MANAGE]) {
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
    await tx.roleAssignment.create({
      data: { userId: auditor.id, roleId: role.id, scopeType: 'SYSTEM' },
    });
    return auditor.id;
  }

  it('shows an account’s events to exactly the organizations it works in or administers, and the rest only at System scope', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { auth } = authServices(client);
      const viewer = new AuditViewerService(
        client,
        new AuthorizationService(client),
      );
      const positionB = await positionInOrgB(tx, fx);

      const both = await employeeLogin(tx, fx, 'both', [
        { positionId: fx.positionTeamA, status: 'ACTIVE' },
        { positionId: positionB, status: 'PLANNED' },
      ]);
      const onlyA = await employeeLogin(tx, fx, 'onlya', [
        { positionId: fx.positionTeamA, status: 'ACTIVE' },
      ]);
      // Left organization B: its later events are not B's.
      const leftB = await employeeLogin(tx, fx, 'leftb', [
        { positionId: fx.positionDeptB, status: 'ACTIVE' },
        { positionId: positionB, status: 'ENDED' },
      ]);
      // Administers B (organization-scoped role) without being employed anywhere.
      const adminB = await createLogin(tx, fx, 'adminb');
      const roleB = await tx.role.create({
        data: {
          organizationId: fx.orgB,
          code: `RB-${fx.suffix}`,
          name: 'B admin',
        },
      });
      await tx.roleAssignment.create({
        data: {
          userId: adminB.id,
          roleId: roleB.id,
          roleOrganizationId: fx.orgB,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgB,
        },
      });
      // Belongs to no organization at all.
      const outside = await createLogin(tx, fx, 'outside');
      const sysAuditor = await systemAuditor(tx, fx);

      for (const account of [both, onlyA, leftB, adminB, outside])
        await auth.login(account.email, PASSWORD, META);
      await rejection(auth.login(onlyA.email, 'wrong-password', META));

      const seen = async (
        reader: string,
        query: { organizationId?: string; scope?: 'system' },
        action: string,
      ) =>
        (await viewer.list(reader, { ...query, action, limit: 200 })).items.map(
          (item) => item.entityId,
        );
      const loginsIn = (reader: string, organizationId: string) =>
        seen(reader, { organizationId }, 'AUTH_LOGIN_SUCCESS');

      expect(new Set(await loginsIn(fx.users.auditorA!, fx.orgA))).toEqual(
        new Set([both.id, onlyA.id, leftB.id]),
      );
      expect(new Set(await loginsIn(fx.users.auditorB!, fx.orgB))).toEqual(
        new Set([both.id, adminB.id]),
      );
      // Sessions are attributed through their account.
      const sessionsInB = await seen(
        fx.users.auditorB!,
        { organizationId: fx.orgB },
        'AUTH_SESSION_CREATED',
      );
      const sessionOwners = await tx.authSession.findMany({
        where: { id: { in: sessionsInB as string[] } },
        select: { userId: true },
      });
      expect(sessionOwners.map((row) => row.userId).sort()).toEqual(
        [both.id, adminB.id].sort(),
      );
      // One copy per organization: two for the account in both.
      expect(
        await tx.auditLog.count({
          where: { action: 'AUTH_LOGIN_SUCCESS', entityId: both.id },
        }),
      ).toBe(2);

      // A failed sign-in shows its reason code; never the address, IP or device.
      const failed = await viewer.list(fx.users.auditorA!, {
        organizationId: fx.orgA,
        action: 'AUTH_LOGIN_FAILED',
      });
      expect(failed.items).toEqual([
        expect.objectContaining({
          entityId: onlyA.id,
          metadata: { organizationId: fx.orgA, reasonCode: 'INVALID_PASSWORD' },
        }),
      ]);
      const serialized = JSON.stringify(failed);
      expect(serialized).not.toContain(META.ipAddress);
      expect(serialized).not.toContain(onlyA.email);
      expect(serialized).not.toContain('vitest');
      expect(
        await seen(
          fx.users.auditorB!,
          { organizationId: fx.orgB },
          'AUTH_LOGIN_FAILED',
        ),
      ).toEqual([]);

      // The System view: only System-scope readers, only untagged entries.
      for (const reader of [fx.users.auditorA!, fx.users.auditorB!]) {
        expect(
          statusOf(await rejection(viewer.list(reader, { scope: 'system' }))),
        ).toBe(403);
      }
      expect(
        statusOf(
          await rejection(
            viewer.list(fx.users.auditorA!, { organizationId: fx.orgB }),
          ),
        ),
      ).toBe(403);
      const system = await seen(
        sysAuditor,
        { scope: 'system' },
        'AUTH_LOGIN_SUCCESS',
      );
      expect(system).toContain(outside.id);
      for (const id of [both.id, onlyA.id, leftB.id, adminB.id])
        expect(system).not.toContain(id);
      // A System-scope reader also reads every organization's view.
      expect(new Set(await loginsIn(sysAuditor, fx.orgB))).toEqual(
        new Set([both.id, adminB.id]),
      );
    });
  });

  it('shows an administrator’s action on a shared login only where their authority applied', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const { auth, audit, tokens } = authServices(client);
      const authorization = new AuthorizationService(client);
      const viewer = new AuditViewerService(client, authorization);
      const accounts = new EmployeeAccountService(
        client,
        authorization,
        new PositionAuthorizationTargetResolver(client),
        audit,
        tokens,
        new RecordingEmails(),
      );
      const positionB = await positionInOrgB(tx, fx);
      // An employee working in both organizations, with one login.
      const shared = await employeeLogin(tx, fx, 'shared', [
        { positionId: fx.positionTeamA, status: 'ACTIVE' },
        { positionId: positionB, status: 'ACTIVE' },
      ]);
      const employeeId = (
        await tx.employee.findUniqueOrThrow({
          where: { personId: shared.personId },
        })
      ).id;
      const sysOwner = await systemAuditor(tx, fx);
      const as = (actor: string) => ({
        actorUserId: actor,
        ipAddress: '203.0.113.7',
        userAgent: 'vitest',
        correlationId: 'b2-admin-scope',
      });

      await accounts.signOut(employeeId, as(fx.users.hrA!));
      await accounts
        .unlock(employeeId, as(fx.users.hrB!))
        .catch(() => undefined);
      await accounts.requirePasswordChange(
        employeeId,
        { signOut: false },
        as(fx.users.hrB!),
      );
      await accounts.signOut(employeeId, as(fx.users.hrBoth!));
      await accounts.signOut(employeeId, as(sysOwner));
      // The employee's own sign-in concerns the whole account: both organizations see it.
      await tx.user.update({
        where: { id: shared.id },
        data: { mustChangePassword: false },
      });
      await auth.login(shared.email, PASSWORD, META);

      const actorsOf = async (
        reader: string,
        query: { organizationId?: string; scope?: 'system' },
        action: string,
      ) =>
        (await viewer.list(reader, { ...query, action, limit: 200 })).items
          .filter((item) => item.entityId === shared.id)
          .map((item) => item.actor?.userId ?? null);

      // Organization A: only A's administrator and the administrator of both.
      expect(
        new Set(
          await actorsOf(
            fx.users.auditorA!,
            { organizationId: fx.orgA },
            'EMPLOYEE_ACCOUNT_SESSIONS_REVOKED',
          ),
        ),
      ).toEqual(new Set([fx.users.hrA!, fx.users.hrBoth!]));
      // Organization B never sees what A's administrator did, and vice versa.
      expect(
        new Set(
          await actorsOf(
            fx.users.auditorB!,
            { organizationId: fx.orgB },
            'EMPLOYEE_ACCOUNT_SESSIONS_REVOKED',
          ),
        ),
      ).toEqual(new Set([fx.users.hrBoth!]));
      expect(
        await actorsOf(
          fx.users.auditorB!,
          { organizationId: fx.orgB },
          'EMPLOYEE_ACCOUNT_PASSWORD_CHANGE_REQUIRED',
        ),
      ).toEqual([fx.users.hrB!]);
      expect(
        await actorsOf(
          fx.users.auditorA!,
          { organizationId: fx.orgA },
          'EMPLOYEE_ACCOUNT_PASSWORD_CHANGE_REQUIRED',
        ),
      ).toEqual([]);
      // A System-scope action belongs to no organization: the System view only.
      expect(
        await actorsOf(
          sysOwner,
          { scope: 'system' },
          'EMPLOYEE_ACCOUNT_SESSIONS_REVOKED',
        ),
      ).toEqual([sysOwner]);
      for (const [reader, organizationId] of [
        [fx.users.auditorA!, fx.orgA],
        [fx.users.auditorB!, fx.orgB],
      ] as const) {
        expect(
          await actorsOf(
            reader,
            { organizationId },
            'EMPLOYEE_ACCOUNT_SESSIONS_REVOKED',
          ),
        ).not.toContain(sysOwner);
        expect(
          await actorsOf(reader, { organizationId }, 'AUTH_LOGIN_SUCCESS'),
        ).toEqual([shared.id]);
      }
      // Each copy is tagged with exactly one organization.
      const rows = await tx.auditLog.findMany({
        where: {
          action: 'EMPLOYEE_ACCOUNT_SESSIONS_REVOKED',
          entityId: shared.id,
        },
      });
      expect(rows).toHaveLength(4);
    });
  });
});
