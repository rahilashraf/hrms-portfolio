import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import {
  AccountEmailService,
  accountEmailDeliveryFailed,
  accountEmailUnavailable,
  type AccountEmailMessage,
} from '../src/auth/account-email.service.js';
import type { AccountRecoveryQueue } from '../src/auth/account-recovery-queue.service.js';
import { AccountTokenService } from '../src/auth/account-token.service.js';
import type { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import type { LoginRateLimiterService } from '../src/auth/login-rate-limiter.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeAccountService } from '../src/employee/employee-account.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { AttendanceCredentialService } from '../src/kiosk/attendance-credential.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { UsersService } from '../src/users/users.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import { RecordingRecoveryQueue } from './support/auth-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const MANAGE = 'employee.account.manage';
const USERS = {
  hrA: [
    { permissions: [MANAGE, 'time.credential.manage'], scope: 'org' as const },
  ],
  teamAHr: [{ permissions: [MANAGE], scope: 'teamA' as const }],
  hrB: [{ permissions: [MANAGE], scope: 'orgB' as const }],
  noAccess: [{ permissions: ['employee.read'], scope: 'org' as const }],
  // Employee 1's own login, holding the permission: it still may not manage itself.
  self1: [{ permissions: [MANAGE, 'time.clock'], scope: 'org' as const }],
  roleAdmin: [
    { permissions: ['role.assign', 'time.clock'], scope: 'org' as const },
  ],
};
const PASSWORD = 'Correct-Horse-Battery-42!';

const testConfig = {
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`${key} missing`);
    return key.startsWith('ARGON2_') ? Number(value) : value;
  },
} as unknown as ConfigService;

const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();

/** Records what would have been emailed; can be told to fail or be unconfigured. */
class RecordingEmails extends AccountEmailService {
  sent: AccountEmailMessage[] = [];
  mode: 'ok' | 'fail' | 'unavailable' = 'ok';
  assertAvailable() {
    if (this.mode === 'unavailable') throw accountEmailUnavailable();
  }
  /** Runs before one invitation is "delivered"; it may hold the send open or fail it. */
  onInvitation?: (message: AccountEmailMessage) => Promise<void>;
  async sendInvitation(message: AccountEmailMessage) {
    if (this.mode === 'fail') throw accountEmailDeliveryFailed();
    const hook = this.onInvitation;
    if (hook) {
      this.onInvitation = undefined;
      await hook(message);
    }
    this.sent.push(message);
  }
  async sendPasswordReset(message: AccountEmailMessage) {
    if (this.mode === 'fail') throw accountEmailDeliveryFailed();
    this.sent.push(message);
  }
  async sendVerification(message: AccountEmailMessage) {
    this.sent.push(message);
  }
  last() {
    return this.sent.at(-1)!;
  }
}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  client: PrismaService;
  emails: RecordingEmails;
  accounts: EmployeeAccountService;
  auth: AuthService;
  authorization: AuthorizationService;
  recovery: RecordingRecoveryQueue;
}

const hasher = new PasswordHasherService(testConfig);

function services(client: PrismaService) {
  const authorization = new AuthorizationService(client);
  const audit = new AuditService(client);
  const tokens = new AccountTokenService(client, audit);
  const emails = new RecordingEmails();
  const recovery = new RecordingRecoveryQueue();
  const accounts = new EmployeeAccountService(
    client,
    authorization,
    new PositionAuthorizationTargetResolver(client),
    audit,
    tokens,
    emails,
  );
  const auth = new AuthService(
    client,
    audit,
    new UsersService(client),
    new SessionsService(client),
    hasher,
    {} as AccessTokenService,
    tokens,
    emails,
    {
      assertLoginAllowed: async () => undefined,
    } as unknown as LoginRateLimiterService,
    recovery as unknown as AccountRecoveryQueue,
  );
  return { authorization, audit, emails, accounts, auth, recovery };
}

/** A new employee (with no login) on a position, with a personal email unless told otherwise. */
async function employeeWithoutLogin(
  tx: Tx,
  fx: SchedulingFixtures,
  label: string,
  positionId: string,
  personalEmail:
    string | null = `${label}-${fx.suffix.toLowerCase()}@example.com`,
) {
  const person = await tx.person.create({
    data: { firstName: label, lastName: fx.suffix, personalEmail },
  });
  const employee = await tx.employee.create({
    data: {
      personId: person.id,
      employeeNumber: `AC-${label}-${fx.suffix}`,
      hireDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await tx.employmentAssignment.create({
    data: {
      employeeId: employee.id,
      positionId,
      employmentType: 'PART_TIME',
      status: 'ACTIVE',
      isPrimary: true,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  return { employeeId: employee.id, personId: person.id, email: personalEmail };
}

const audits = (tx: Tx, action: string, userId: string) =>
  tx.auditLog.findMany({ where: { action, entityId: userId } });

describe('Employee account management (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            MANAGE,
            ...TIME_PERMISSIONS,
          ]);
          const client = rollbackClient(tx);
          const { authorization, emails, accounts, auth, recovery } =
            services(client);
          await run({
            tx,
            fx,
            client,
            emails,
            accounts,
            auth,
            authorization,
            recovery,
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('invites by linking a login to the existing Person, never duplicating Person, Employee or the login', async () => {
    await scenario(async ({ tx, fx, emails, accounts }) => {
      const hire = await employeeWithoutLogin(tx, fx, 'ada', fx.positionTeamA);
      const people = await tx.person.count({ where: { lastName: fx.suffix } });
      const employees = await tx.employee.count({
        where: { person: { lastName: fx.suffix } },
      });

      expect(
        await accounts.account(hire.employeeId, ctx(fx.users.hrA!)),
      ).toMatchObject({
        status: 'NOT_INVITED',
        email: hire.email,
        actions: { invite: true, resend: false, disable: false },
      });
      const invited = await accounts.invite(
        hire.employeeId,
        {},
        ctx(fx.users.hrA!),
      );
      expect(invited).toMatchObject({
        status: 'INVITED',
        email: hire.email,
        actions: { invite: false, resend: true, cancel: true, disable: false },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { personId: hire.personId },
      });
      expect(user).toMatchObject({
        status: 'INVITED',
        passwordHash: null,
        email: hire.email,
      });
      expect(await tx.person.count({ where: { lastName: fx.suffix } })).toBe(
        people,
      );
      expect(
        await tx.employee.count({ where: { person: { lastName: fx.suffix } } }),
      ).toBe(employees);
      // Emailed once, routed through the organization the administrator manages it in.
      expect(emails.sent).toHaveLength(1);
      expect(emails.last()).toMatchObject({
        email: hire.email,
        userId: user.id,
        organizationIds: [fx.orgA],
      });
      // The token is stored only as a hash.
      const token = await tx.accountToken.findFirstOrThrow({
        where: { userId: user.id, type: 'INVITATION' },
      });
      expect(token.tokenHash).not.toBe(emails.last().token);
      // No role is granted by an invitation.
      expect(
        await tx.roleAssignment.count({ where: { userId: user.id } }),
      ).toBe(0);
      // Audited without the address.
      const [audit] = await audits(tx, 'EMPLOYEE_ACCOUNT_INVITED', user.id);
      expect(audit).toMatchObject({
        actorUserId: fx.users.hrA,
        entityType: 'User',
      });
      expect(JSON.stringify(audit!.metadata)).not.toContain('@');

      // Repeating, or inviting an employee with a login, is refused.
      expect(
        codeOf(
          await violation(tx, () =>
            accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!)),
          ),
        ),
      ).toBe('EMPLOYEE_ACCOUNT_ALREADY_INVITED');
      expect(
        codeOf(
          await violation(tx, () =>
            accounts.invite(fx.employee2, {}, ctx(fx.users.hrA!)),
          ),
        ),
      ).toBe('EMPLOYEE_ACCOUNT_ALREADY_ACTIVE');
      // An address another login uses is refused; an employee without one needs an address.
      const other = await employeeWithoutLogin(
        tx,
        fx,
        'bob',
        fx.positionTeamA,
        null,
      );
      expect(
        codeOf(
          await violation(tx, () =>
            accounts.invite(other.employeeId, {}, ctx(fx.users.hrA!)),
          ),
        ),
      ).toBe('EMPLOYEE_ACCOUNT_EMAIL_REQUIRED');
      expect(
        codeOf(
          await violation(tx, () =>
            accounts.invite(
              other.employeeId,
              { email: hire.email!.toUpperCase() },
              ctx(fx.users.hrA!),
            ),
          ),
        ),
      ).toBe('EMPLOYEE_ACCOUNT_EMAIL_IN_USE');
      expect(await tx.user.count({ where: { personId: other.personId } })).toBe(
        0,
      );
    });
  });

  it('activates through the single-use invitation; replayed, superseded and expired links are refused', async () => {
    await scenario(async ({ tx, fx, emails, accounts, auth }) => {
      const hire = await employeeWithoutLogin(tx, fx, 'cy', fx.positionTeamA);
      await accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!));
      const first = emails.last().token;
      // Resending supersedes the earlier link.
      await accounts.resend(hire.employeeId, {}, ctx(fx.users.hrA!));
      const second = emails.last().token;
      expect(second).not.toBe(first);
      expect(
        await rejection(auth.acceptInvitation(first, PASSWORD, {})),
      ).toBeInstanceOf(UnauthorizedException);

      // An expired link is refused, and the status says so.
      await tx.accountToken.updateMany({
        where: { user: { personId: hire.personId }, usedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        await rejection(auth.acceptInvitation(second, PASSWORD, {})),
      ).toBeInstanceOf(UnauthorizedException);
      expect(
        await accounts.account(hire.employeeId, ctx(fx.users.hrA!)),
      ).toMatchObject({
        status: 'INVITATION_EXPIRED',
        actions: { resend: true, cancel: true },
      });

      await accounts.resend(hire.employeeId, {}, ctx(fx.users.hrA!));
      const third = emails.last().token;
      await expect(auth.acceptInvitation(third, PASSWORD, {})).resolves.toEqual(
        { success: true },
      );
      const user = await tx.user.findUniqueOrThrow({
        where: { personId: hire.personId },
      });
      expect(user.status).toBe('ACTIVE');
      expect(user.passwordHash).not.toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      // Replay of the used link is refused.
      expect(
        await rejection(auth.acceptInvitation(third, 'Another-Pass-77!', {})),
      ).toBeInstanceOf(UnauthorizedException);
      expect(
        await accounts.account(hire.employeeId, ctx(fx.users.hrA!)),
      ).toMatchObject({
        status: 'ACTIVE',
        actions: { invite: false, resend: false, disable: true },
      });
      expect(await tx.user.count({ where: { personId: hire.personId } })).toBe(
        1,
      );
    });
  });

  it('never leaves an unusable account or a misleading status when email fails or is not configured', async () => {
    await scenario(async ({ tx, fx, emails, accounts }) => {
      const hire = await employeeWithoutLogin(tx, fx, 'dee', fx.positionTeamA);

      // Not configured: refused before anything is created.
      emails.mode = 'unavailable';
      const unavailable = await rejection(
        accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!)),
      );
      expect([statusOf(unavailable), codeOf(unavailable)]).toEqual([
        503,
        'ACCOUNT_EMAIL_UNAVAILABLE',
      ]);
      expect(await tx.user.count({ where: { personId: hire.personId } })).toBe(
        0,
      );

      // Delivery fails: the login is undone and the link withdrawn.
      emails.mode = 'fail';
      const failed = await rejection(
        accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!)),
      );
      expect(codeOf(failed)).toBe('ACCOUNT_EMAIL_DELIVERY_FAILED');
      const undone = await tx.user.findUniqueOrThrow({
        where: { personId: hire.personId },
      });
      expect(undone).toMatchObject({ status: 'ARCHIVED', passwordHash: null });
      expect(
        await tx.accountToken.count({
          where: { userId: undone.id, usedAt: null },
        }),
      ).toBe(0);
      expect(
        await audits(tx, 'EMPLOYEE_ACCOUNT_INVITATION_FAILED', undone.id),
      ).toHaveLength(1);
      expect(
        await accounts.account(hire.employeeId, ctx(fx.users.hrA!)),
      ).toMatchObject({
        status: 'NOT_INVITED',
        actions: { invite: true },
      });

      // Retrying reuses the same login row (one login per Person).
      emails.mode = 'ok';
      await accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!));
      const revived = await tx.user.findUniqueOrThrow({
        where: { personId: hire.personId },
      });
      expect(revived.id).toBe(undone.id);
      expect(revived).toMatchObject({ status: 'INVITED', archivedAt: null });

      // A failed resend keeps the invitation but reports it as not delivered.
      emails.mode = 'fail';
      expect(
        codeOf(
          await rejection(
            accounts.resend(hire.employeeId, {}, ctx(fx.users.hrA!)),
          ),
        ),
      ).toBe('ACCOUNT_EMAIL_DELIVERY_FAILED');
      expect(
        await accounts.account(hire.employeeId, ctx(fx.users.hrA!)),
      ).toMatchObject({
        status: 'INVITATION_EXPIRED',
      });
    });
  });

  it('stays usable without any email provider; email actions answer a clear 503 and change nothing', async () => {
    await scenario(async ({ tx, fx, emails, accounts, auth, recovery }) => {
      const login = fx.users.self1!; // employee 1's ACTIVE login
      const hr = ctx(fx.users.hrA!);
      await tx.user.update({
        where: { id: login },
        data: { passwordHash: await hasher.hashPassword(PASSWORD) },
      });
      const { email } = await tx.user.findUniqueOrThrow({
        where: { id: login },
      });
      // An invitation sent while a provider existed.
      const hire = await employeeWithoutLogin(
        tx,
        fx,
        'nomail',
        fx.positionTeamA,
      );
      await accounts.invite(hire.employeeId, {}, hr);
      const usableLinks = () =>
        tx.accountToken.count({
          where: {
            user: { personId: { in: [hire.personId] } },
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
      const resetLinks = () =>
        tx.accountToken.count({
          where: { userId: login, type: 'PASSWORD_RESET' },
        });
      expect(await usableLinks()).toBe(1);
      const sent = emails.sent.length;

      emails.mode = 'unavailable';
      const unavailable = (error: unknown) => [
        statusOf(error),
        codeOf(error),
        (error as { getResponse(): { message: string } }).getResponse().message,
      ];
      const expected = [
        503,
        'ACCOUNT_EMAIL_UNAVAILABLE',
        expect.stringContaining('configure the deployment SMTP server'),
      ];
      expect(
        unavailable(
          await rejection(accounts.sendPasswordReset(fx.employee1, hr)),
        ),
      ).toEqual(expected);
      expect(
        unavailable(await rejection(accounts.resend(hire.employeeId, {}, hr))),
      ).toEqual(expected);
      // Nothing was issued, withdrawn or sent; the invitation stays as it was.
      expect(await resetLinks()).toBe(0);
      expect(await usableLinks()).toBe(1);
      expect(emails.sent).toHaveLength(sent);
      expect(await accounts.account(hire.employeeId, hr)).toMatchObject({
        status: 'INVITED',
      });
      expect(
        await tx.auditLog.count({
          where: {
            action: {
              in: [
                'EMPLOYEE_ACCOUNT_PASSWORD_RESET_SENT',
                'EMPLOYEE_ACCOUNT_PASSWORD_RESET_FAILED',
              ],
            },
            entityId: login,
          },
        }),
      ).toBe(0);
      // Self-service recovery refuses the same way for every address, before queuing anything.
      for (const address of [email, `nobody-${fx.suffix}@example.com`])
        expect(
          unavailable(await rejection(auth.forgotPassword(address))),
        ).toEqual(expected);
      expect(recovery.jobs).toHaveLength(0);

      // Everything that needs no email keeps working.
      // (Sign-in needs no email; its own suite covers it end to end.)
      const stored = await tx.user.findUniqueOrThrow({ where: { id: login } });
      expect(await hasher.verifyPassword(stored.passwordHash!, PASSWORD)).toBe(
        true,
      );
      await accounts.requirePasswordChange(fx.employee1, { signOut: true }, hr);
      await accounts.signOut(fx.employee1, hr);
      await tx.user.update({
        where: { id: login },
        data: { lockedUntil: new Date(Date.now() + 600_000) },
      });
      await accounts.unlock(fx.employee1, hr);
      expect(
        await tx.user.findUniqueOrThrow({ where: { id: login } }),
      ).toMatchObject({
        status: 'ACTIVE',
        mustChangePassword: true,
        lockedUntil: null,
      });
    });
  });

  it('keeps a newer invitation valid when an earlier first invitation fails after a concurrent resend', async () => {
    await scenario(async ({ tx, fx, emails, accounts, auth }) => {
      const hire = await employeeWithoutLogin(tx, fx, 'hal', fx.positionTeamA);
      // Administrator 1's first invitation: its email is held open, then fails.
      let failFirst!: (error: unknown) => void;
      let firstInFlight!: () => void;
      const inFlight = new Promise<void>(
        (resolve) => (firstInFlight = resolve),
      );
      emails.onInvitation = () =>
        new Promise<void>((_resolve, reject) => {
          failFirst = reject;
          firstInFlight();
        });
      const first = rejection(
        accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!)),
      );
      await inFlight;

      // Administrator 2 resends meanwhile, and that email is delivered.
      await accounts.resend(hire.employeeId, {}, ctx(fx.users.teamAHr!));
      const newer = emails.last().token;

      failFirst(accountEmailDeliveryFailed());
      expect(codeOf(await first)).toBe('ACCOUNT_EMAIL_DELIVERY_FAILED');

      // The failed attempt was superseded: the login is not undone and the newer link works.
      const user = await tx.user.findUniqueOrThrow({
        where: { personId: hire.personId },
      });
      expect(user).toMatchObject({ status: 'INVITED', archivedAt: null });
      expect(
        await accounts.account(hire.employeeId, ctx(fx.users.hrA!)),
      ).toMatchObject({ status: 'INVITED' });
      const [failure] = await audits(
        tx,
        'EMPLOYEE_ACCOUNT_INVITATION_FAILED',
        user.id,
      );
      expect(failure!.metadata).toMatchObject({
        employeeId: hire.employeeId,
        undone: false,
        superseded: true,
      });
      // Exactly one usable invitation link: the newer one, still single-use.
      expect(
        await tx.accountToken.count({
          where: { userId: user.id, type: 'INVITATION', usedAt: null },
        }),
      ).toBe(1);
      await expect(auth.acceptInvitation(newer, PASSWORD, {})).resolves.toEqual(
        { success: true },
      );
      expect(
        await rejection(auth.acceptInvitation(newer, PASSWORD, {})),
      ).toBeInstanceOf(UnauthorizedException);
      expect(await tx.user.count({ where: { personId: hire.personId } })).toBe(
        1,
      );
    });
  });

  it('requires the permission in the employee’s scope: team scope, other organizations, no permission and self', async () => {
    await scenario(async ({ tx, fx, accounts }) => {
      const inTeam = await employeeWithoutLogin(
        tx,
        fx,
        'eve',
        fx.positionTeamA,
      );
      const inDeptB = await employeeWithoutLogin(
        tx,
        fx,
        'fay',
        fx.positionDeptB,
      );

      await expect(
        accounts.invite(inTeam.employeeId, {}, ctx(fx.users.teamAHr!)),
      ).resolves.toMatchObject({ status: 'INVITED' });
      for (const [actor, employeeId] of [
        [fx.users.teamAHr!, inDeptB.employeeId], // outside the team
        [fx.users.hrB!, inTeam.employeeId], // another organization
        [fx.users.noAccess!, inTeam.employeeId], // no permission
      ] as const) {
        expect(
          statusOf(
            await violation(tx, () => accounts.account(employeeId, ctx(actor))),
          ),
        ).toBe(403);
        expect(
          statusOf(
            await violation(tx, () =>
              accounts.invite(employeeId, {}, ctx(actor)),
            ),
          ),
        ).toBe(403);
      }
      expect(
        statusOf(
          await violation(tx, () =>
            accounts.cancel(inTeam.employeeId, ctx(fx.users.hrB!)),
          ),
        ),
      ).toBe(403);
      // Nobody disables their own login, whatever they hold.
      expect(
        statusOf(
          await violation(tx, () =>
            accounts.disable(fx.employee1, {}, ctx(fx.users.self1!)),
          ),
        ),
      ).toBe(403);
      expect(
        await tx.user.findUniqueOrThrow({ where: { id: fx.users.self1! } }),
      ).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        await tx.user.count({ where: { personId: inDeptB.personId } }),
      ).toBe(0);
    });
  });

  it('lets roles be prepared for an invited login that grant nothing until activation, and revokes them on cancel', async () => {
    await scenario(
      async ({ tx, fx, client, emails, accounts, auth, authorization }) => {
        const hire = await employeeWithoutLogin(
          tx,
          fx,
          'gus',
          fx.positionTeamA,
        );
        await accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!));
        const user = await tx.user.findUniqueOrThrow({
          where: { personId: hire.personId },
        });
        const permission = await tx.permission.findUniqueOrThrow({
          where: { key: 'time.clock' },
        });
        const role = await tx.role.create({
          data: {
            organizationId: fx.orgA,
            code: `EMP-${fx.suffix}`,
            name: 'Employee',
          },
        });
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
        const roles = new RoleManagementService(
          client,
          authorization,
          new AuditService(client),
        );
        const scope = { type: 'ORGANIZATION' as const, id: fx.orgA };

        // The selector finds invited users by name, email or employee number.
        for (const term of ['gus', `AC-gus-${fx.suffix}`, user.email]) {
          const found = await roles.searchActiveUsers(
            fx.users.roleAdmin!,
            fx.orgA,
            term,
          );
          expect(found.items).toContainEqual(
            expect.objectContaining({ id: user.id, status: 'INVITED' }),
          );
        }
        await roles.createAssignment(
          fx.users.roleAdmin!,
          { userId: user.id, roleId: role.id, scope },
          ctx(fx.users.roleAdmin!),
        );
        const orgScope = {
          type: 'ORGANIZATION' as const,
          id: fx.orgA,
          organizationId: fx.orgA,
        };
        expect(await authorization.can(user.id, 'time.clock', orgScope)).toBe(
          false,
        );

        // Cancelling revokes the prepared role; a later invitation does not bring it back.
        await accounts.cancel(hire.employeeId, ctx(fx.users.hrA!));
        expect(
          await tx.roleAssignment.count({
            where: { userId: user.id, revokedAt: null },
          }),
        ).toBe(0);
        await accounts.invite(hire.employeeId, {}, ctx(fx.users.hrA!));
        await roles.createAssignment(
          fx.users.roleAdmin!,
          { userId: user.id, roleId: role.id, scope },
          ctx(fx.users.roleAdmin!),
        );
        expect(await authorization.can(user.id, 'time.clock', orgScope)).toBe(
          false,
        );
        await auth.acceptInvitation(emails.last().token, PASSWORD, {});
        expect(await authorization.can(user.id, 'time.clock', orgScope)).toBe(
          true,
        );
        // Delegation still applies: nobody hands out what they do not hold.
        const admin = await tx.permission.findUniqueOrThrow({
          where: { key: MANAGE },
        });
        const adminRole = await tx.role.create({
          data: {
            organizationId: fx.orgA,
            code: `ADM-${fx.suffix}`,
            name: 'Admin',
          },
        });
        await tx.rolePermission.create({
          data: { roleId: adminRole.id, permissionId: admin.id },
        });
        expect(
          statusOf(
            await violation(tx, () =>
              roles.createAssignment(
                fx.users.roleAdmin!,
                { userId: user.id, roleId: adminRole.id, scope },
                ctx(fx.users.roleAdmin!),
              ),
            ),
          ),
        ).toBe(403);
      },
    );
  });

  it('disables access immediately (sessions and links), keeps employment and the kiosk PIN, and re-enables', async () => {
    await scenario(
      async ({ tx, fx, client, emails, accounts, auth, recovery }) => {
        const sessions = new SessionsService(client);
        const login = fx.users.self1!; // employee 1's ACTIVE login
        const session = await tx.authSession.create({
          data: {
            userId: login,
            refreshTokenHash: `hash-${fx.suffix}`,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        expect(
          await sessions.findActiveByIdAndUser(session.id, login, new Date()),
        ).not.toBeNull();
        await tx.user.update({
          where: { id: login },
          data: { passwordHash: await hasher.hashPassword(PASSWORD) },
        });
        await auth.forgotPassword(
          (await tx.user.findUniqueOrThrow({ where: { id: login } })).email,
        );
        await recovery.deliver(client, emails);
        const resetToken = emails.last().token;

        // A kiosk PIN, issued independently of the login.
        await seedTimePolicy(tx, fx.orgA);
        const svc = timeServices(client, new FixedClock());
        const credentials = new AttendanceCredentialService(
          client,
          svc.authorization,
          svc.targets,
          svc.audit,
          hasher,
        );
        const { pin } = await credentials.issuePin(
          fx.users.hrA!,
          fx.employee1,
          ctx(fx.users.hrA!),
        );
        const employeeNumber = (
          await tx.employee.findUniqueOrThrow({ where: { id: fx.employee1 } })
        ).employeeNumber;
        const assignmentsBefore = await tx.employmentAssignment.findMany({
          where: { employeeId: fx.employee1 },
          orderBy: { id: 'asc' },
        });

        const disabled = await accounts.disable(
          fx.employee1,
          { reason: 'Extended leave' },
          ctx(fx.users.hrA!),
        );
        expect(disabled).toMatchObject({
          status: 'DISABLED',
          actions: { enable: true, disable: false },
        });
        // Every request checks its session against an ACTIVE user: an unexpired access token is dead.
        expect(
          await sessions.findActiveByIdAndUser(session.id, login, new Date()),
        ).toBeNull();
        expect(
          await tx.authSession.findUniqueOrThrow({ where: { id: session.id } }),
        ).toMatchObject({
          revokedReason: 'access_disabled',
        });
        expect(
          await rejection(auth.resetPassword(resetToken, PASSWORD, {})),
        ).toBeInstanceOf(UnauthorizedException);
        const [audit] = await audits(tx, 'EMPLOYEE_ACCOUNT_DISABLED', login);
        expect(audit!.metadata).toMatchObject({
          revokedSessionCount: 1,
          reason: 'Extended leave',
        });

        // Employment and the kiosk PIN are untouched; the kiosk still works.
        expect(
          await tx.employmentAssignment.findMany({
            where: { employeeId: fx.employee1 },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(assignmentsBefore);
        expect(
          await credentials.verifyPin(employeeNumber, pin, fx.orgA, {
            userAgent: 'kiosk',
          }),
        ).toMatchObject({ employeeId: fx.employee1 });
        // Disabling twice, or an invitation for a disabled login, is refused.
        expect(
          codeOf(
            await violation(tx, () =>
              accounts.disable(fx.employee1, {}, ctx(fx.users.hrA!)),
            ),
          ),
        ).toBe('EMPLOYEE_ACCOUNT_NOT_ACTIVE');
        expect(
          codeOf(
            await violation(tx, () =>
              accounts.invite(fx.employee1, {}, ctx(fx.users.hrA!)),
            ),
          ),
        ).toBe('EMPLOYEE_ACCOUNT_DISABLED');

        const enabled = await accounts.enable(fx.employee1, ctx(fx.users.hrA!));
        expect(enabled).toMatchObject({ status: 'ACTIVE' });
        expect(
          await audits(tx, 'EMPLOYEE_ACCOUNT_ENABLED', login),
        ).toHaveLength(1);
        // Old sessions stay ended: the employee signs in again.
        expect(
          await sessions.findActiveByIdAndUser(session.id, login, new Date()),
        ).toBeNull();
        expect(
          await credentials.verifyPin(employeeNumber, pin, fx.orgA, {
            userAgent: 'kiosk',
          }),
        ).toMatchObject({ employeeId: fx.employee1 });
      },
    );
  });

  it('requires a password change, signs the login out, sends a reset link and unlocks, within scope only', async () => {
    await scenario(async ({ tx, fx, client, emails, accounts, auth }) => {
      const sessions = new SessionsService(client);
      const login = fx.users.self1!; // employee 1's ACTIVE login
      const hr = ctx(fx.users.hrA!);
      await tx.user.update({
        where: { id: login },
        data: { passwordHash: await hasher.hashPassword(PASSWORD) },
      });
      const openSession = (label: string) =>
        tx.authSession.create({
          data: {
            userId: login,
            refreshTokenHash: `${label}-${fx.suffix}`,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
      const live = (id: string) =>
        sessions.findActiveByIdAndUser(id, login, new Date());
      const first = await openSession('first');
      await openSession('second');

      expect(await accounts.account(fx.employee1, hr)).toMatchObject({
        status: 'ACTIVE',
        mustChangePassword: false,
        lockedUntil: null,
        activeSessionCount: 2,
        actions: {
          requirePasswordChange: true,
          sendPasswordReset: true,
          signOut: true,
          unlock: false,
        },
      });

      // Without signing out: the open sessions are confined to the password change.
      const kept = await accounts.requirePasswordChange(
        fx.employee1,
        { signOut: false },
        hr,
      );
      expect(kept).toMatchObject({
        mustChangePassword: true,
        activeSessionCount: 2,
        actions: { requirePasswordChange: false },
      });
      expect(await live(first.id)).toEqual({
        id: first.id,
        mustChangePassword: true,
      });
      // The employee meets the requirement from that session.
      await auth.changePassword(
        { userId: login, sessionId: first.id },
        PASSWORD,
        'A-Brand-New-Passphrase-9',
        {},
      );
      expect(await live(first.id)).toEqual({
        id: first.id,
        mustChangePassword: false,
      });

      // The default also signs out every session now.
      const signedOut = await accounts.requirePasswordChange(
        fx.employee1,
        {},
        hr,
      );
      expect(signedOut).toMatchObject({
        mustChangePassword: true,
        activeSessionCount: 0,
      });
      expect(await live(first.id)).toBeNull();
      // Both entries, in either order: they can share a timestamp, and the query has no order.
      const required = (
        await audits(tx, 'EMPLOYEE_ACCOUNT_PASSWORD_CHANGE_REQUIRED', login)
      ).map((entry) => entry.metadata);
      expect(required).toHaveLength(2);
      expect(required).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ signedOut: false, revokedSessionCount: 0 }),
          expect.objectContaining({ signedOut: true, revokedSessionCount: 1 }),
        ]),
      );

      // Sign-out alone.
      const third = await openSession('third');
      expect(await accounts.signOut(fx.employee1, hr)).toMatchObject({
        activeSessionCount: 0,
      });
      expect(
        await tx.authSession.findUniqueOrThrow({ where: { id: third.id } }),
      ).toMatchObject({ revokedReason: 'admin_revoked' });
      expect(
        await audits(tx, 'EMPLOYEE_ACCOUNT_SESSIONS_REVOKED', login),
      ).toHaveLength(1);

      // A reset link: the employee chooses the password, which also clears the requirement.
      await accounts.sendPasswordReset(fx.employee1, hr);
      expect(emails.last().userId).toBe(login);
      expect(emails.last().organizationIds).toEqual([fx.orgA]);
      await auth.resetPassword(
        emails.last().token,
        'Chosen-By-The-Employee-3',
        {},
      );
      expect(
        await tx.user.findUniqueOrThrow({ where: { id: login } }),
      ).toMatchObject({ mustChangePassword: false });
      expect(
        await audits(tx, 'EMPLOYEE_ACCOUNT_PASSWORD_RESET_SENT', login),
      ).toHaveLength(1);
      // A failed delivery withdraws the link and is audited.
      emails.mode = 'fail';
      const failed = await rejection(
        accounts.sendPasswordReset(fx.employee1, hr),
      );
      expect(codeOf(failed)).toBe('ACCOUNT_EMAIL_DELIVERY_FAILED');
      emails.mode = 'ok';
      expect(
        await tx.accountToken.count({
          where: {
            userId: login,
            type: 'PASSWORD_RESET',
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
        }),
      ).toBe(0);
      expect(
        await audits(tx, 'EMPLOYEE_ACCOUNT_PASSWORD_RESET_FAILED', login),
      ).toHaveLength(1);

      // Unlock lifts a temporary lock only.
      expect(
        codeOf(await violation(tx, () => accounts.unlock(fx.employee1, hr))),
      ).toBe('EMPLOYEE_ACCOUNT_NOT_LOCKED');
      await tx.user.update({
        where: { id: login },
        data: {
          failedLoginAttempts: 5,
          lockedUntil: new Date(Date.now() + 600_000),
        },
      });
      expect(await accounts.account(fx.employee1, hr)).toMatchObject({
        lockedUntil: expect.any(String),
        actions: { unlock: true },
      });
      expect(await accounts.unlock(fx.employee1, hr)).toMatchObject({
        lockedUntil: null,
        actions: { unlock: false },
      });
      expect(
        await tx.user.findUniqueOrThrow({ where: { id: login } }),
      ).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
      expect(await audits(tx, 'EMPLOYEE_ACCOUNT_UNLOCKED', login)).toHaveLength(
        1,
      );

      // Never for an organization the actor does not manage, never on one's own login.
      for (const actor of [fx.users.hrB!, fx.users.self1!]) {
        for (const action of [
          () => accounts.requirePasswordChange(fx.employee1, {}, ctx(actor)),
          () => accounts.signOut(fx.employee1, ctx(actor)),
          () => accounts.sendPasswordReset(fx.employee1, ctx(actor)),
          () => accounts.unlock(fx.employee1, ctx(actor)),
        ]) {
          expect(statusOf(await violation(tx, action))).toBe(403);
        }
      }
      // An invited login has no password to change or reset.
      const hire = await employeeWithoutLogin(tx, fx, 'gus', fx.positionTeamA);
      await accounts.invite(hire.employeeId, {}, hr);
      for (const action of [
        () => accounts.requirePasswordChange(hire.employeeId, {}, hr),
        () => accounts.sendPasswordReset(hire.employeeId, hr),
      ]) {
        expect(codeOf(await violation(tx, action))).toBe(
          'EMPLOYEE_ACCOUNT_NOT_ACTIVE',
        );
      }
    });
  });

  it('keeps kiosk clocking for an employee whose login is disabled while KIOSK_ONLY still refuses self-service', async () => {
    await scenario(async ({ tx, fx, client, accounts }) => {
      await seedTimePolicy(tx, fx.orgA);
      const clock = new FixedClock();
      clock.value = toronto('2027-03-02T09:00');
      const svc = timeServices(client, clock);
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: { attendance: { captureMode: 'KIOSK_ONLY' } },
        },
      });
      // KIOSK_ONLY is enforced on the server for the personal login.
      expect(
        codeOf(
          await violation(tx, () =>
            svc.time.clockIn(
              fx.selfUser1,
              fx.assignmentTeamA,
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toBe('ATTENDANCE_CAPTURE_KIOSK_ONLY');

      await accounts.disable(fx.employee1, {}, ctx(fx.users.hrA!));
      const device = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: 'Front desk',
          credentialHash: `hash-${fx.suffix}`,
          credentialIssuedAt: new Date(),
        },
      });
      await svc.time.kioskClockIn(
        {
          id: device.id,
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
        },
        fx.employee1,
        fx.assignmentTeamA,
        { userAgent: 'kiosk' },
      );
      expect(
        await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        }),
      ).toMatchObject({ source: 'KIOSK', status: 'OPEN' });
      // The policy itself was not changed by any account action.
      expect(
        await tx.timeAttendancePolicy.count({
          where: { employmentAssignmentId: fx.assignmentTeamA },
        }),
      ).toBe(1);
    });
  });

  it('serves /employees/me from the signed-in login only', async () => {
    await scenario(async ({ fx, client }) => {
      const authorization = new AuthorizationService(client);
      const audit = new AuditService(client);
      const targets = new PositionAuthorizationTargetResolver(client);
      const employees = new EmployeeService(
        client,
        new EmployeeDomainService(client, audit),
        new EmployeeAccessService(client, authorization, targets),
        authorization,
        targets,
        audit,
        new EmployeeLifecycleService(
          client,
          new EmployeeDomainService(client, audit),
          new EmployeeAccessService(client, authorization, targets, audit),
          authorization,
          audit,
        ),
      );
      const mine = await employees.me(fx.selfUser1);
      expect(mine.id).toBe(fx.employee1);
      expect(
        mine.assignments.current
          .map((a) => a.id)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([fx.assignmentTeamA, fx.assignmentDeptB].sort());
      expect(JSON.stringify(mine)).not.toContain(fx.employee2);
      // A login without an employee record has nothing to show.
      expect(statusOf(await rejection(employees.me(fx.users.hrA!)))).toBe(404);
    });
  });
});
