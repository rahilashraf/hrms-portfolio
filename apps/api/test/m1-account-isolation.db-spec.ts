import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import {
  AccountEmailService,
  type AccountEmailMessage,
} from '../src/auth/account-email.service.js';
import { AccountTokenService } from '../src/auth/account-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccountAlertService } from '../src/employee/employee-account-alerts.service.js';
import { EmployeeAccountService } from '../src/employee/employee-account.service.js';
import type { NotificationService } from '../src/notifications/notification.service.js';
import { NotificationDeliveryLogService } from '../src/notifications/notification-delivery-log.service.js';
import { notificationServices } from '../src/notifications/notifications-producers.js';
import { ALERTS_PER_ACTOR_PER_HOUR } from '../src/employee/employee-account-policy.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const MANAGE = 'employee.account.manage';
const AUDIT_READ = 'audit.read';
const REFUSED = 'EMPLOYEE_ACCOUNT_ACTION_REFUSED';
const ALERT = 'security.account-action-refused';

const USERS = {
  hrA: [{ permissions: [MANAGE], scope: 'org' as const }],
  hrB: [{ permissions: [MANAGE], scope: 'orgB' as const }],
  hrAB: [
    { permissions: [MANAGE], scope: 'org' as const },
    { permissions: [MANAGE], scope: 'orgB' as const },
  ],
  teamAHr: [{ permissions: [MANAGE], scope: 'teamA' as const }],
  unitHr: [{ permissions: [MANAGE], scope: 'unitChild' as const }],
  auditA: [{ permissions: [AUDIT_READ], scope: 'org' as const }],
  // Reads organization A's delivery log and edits its notification templates.
  notifyA: [
    {
      permissions: [
        'notification.delivery.read',
        'notification.template.manage',
      ],
      scope: 'org' as const,
    },
  ],
  // Employee 1's own login, holding the permission: it still may not manage itself.
  self1: [{ permissions: [MANAGE], scope: 'org' as const }],
};

const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const reasonOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { reason?: string } | undefined)
    ?.reason;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();

/** Records what would have been emailed. */
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

/** The account service with a fixed business instant for the 90-day protective window. */
class ClockedAccounts extends EmployeeAccountService {
  at: Date | undefined;
  protected override businessNow(): Date {
    return this.at ?? new Date();
  }
}

type ScopeSpec =
  | { type: 'SYSTEM' }
  | { type: 'ORGANIZATION'; organizationId: string }
  | { type: 'ORGANIZATIONAL_UNIT'; organizationId: string; unitId: string }
  | { type: 'DEPARTMENT'; organizationId: string; departmentId: string }
  | { type: 'TEAM'; organizationId: string; teamId: string };

interface GrantSpec {
  /** SYSTEM: the reserved System Owner role (the schema allows no other SYSTEM grant). */
  scope: ScopeSpec;
  permissions?: string[];
  revoked?: boolean;
  expired?: boolean;
  /** Starts a week from now. */
  future?: boolean;
  /** A role name that must never leak into a refusal, an audit entry or an alert. */
  roleName?: string;
}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  orgBPosition: string;
  accounts: ClockedAccounts;
  emails: RecordingEmails;
  /** Makes a target employee with assignments, an optional login and grants. */
  target: (spec: {
    assignments: Array<{
      positionId: string;
      status: 'ACTIVE' | 'PLANNED' | 'ENDED' | 'CANCELLED';
      endDate?: string;
    }>;
    login?: 'ACTIVE' | 'INVITED' | 'DISABLED' | null;
    grants?: GrantSpec[];
  }) => Promise<{ employeeId: string; userId: string | null }>;
  /** A System Owner login (SYSTEM scope) with no employment. */
  systemUser: (permissions: string[]) => Promise<string>;
}

async function permissionIdOf(tx: Tx, key: string) {
  return (
    await tx.permission.upsert({
      where: { key },
      create: { key, name: key, isActive: true },
      update: { isActive: true },
    })
  ).id;
}

/**
 * The reserved System Owner role (a singleton): the only role the schema allows at SYSTEM scope.
 * Found or created inside the rolled-back scenario.
 */
async function systemOwnerRole(tx: Tx) {
  const existing = await tx.role.findFirst({ where: { isSystemOwner: true } });
  if (existing) return existing.id;
  return (
    await tx.role.create({
      data: {
        organizationId: null,
        code: 'SYSTEM_OWNER',
        name: 'System Owner',
        isSystemOwner: true,
      },
    })
  ).id;
}

async function grantRole(
  tx: Tx,
  suffix: string,
  userId: string,
  spec: GrantSpec,
) {
  const scope = spec.scope;
  const organizationId = scope.type === 'SYSTEM' ? null : scope.organizationId;
  const roleId =
    scope.type === 'SYSTEM'
      ? await systemOwnerRole(tx)
      : (
          await tx.role.create({
            data: {
              organizationId,
              code: `M1-${crypto.randomUUID().slice(0, 8)}-${suffix}`,
              name: spec.roleName ?? 'M1 role',
            },
          })
        ).id;
  for (const key of spec.permissions ?? ['employee.read']) {
    const permissionId = await permissionIdOf(tx, key);
    await tx.rolePermission.upsert({
      where: { roleId_permissionId: { roleId, permissionId } },
      create: { roleId, permissionId },
      update: {},
    });
  }
  const now = Date.now();
  await tx.roleAssignment.create({
    data: {
      userId,
      roleId,
      roleOrganizationId: organizationId,
      scopeType: scope.type,
      organizationId,
      organizationalUnitId:
        scope.type === 'ORGANIZATIONAL_UNIT' ? scope.unitId : null,
      departmentId: scope.type === 'DEPARTMENT' ? scope.departmentId : null,
      teamId: scope.type === 'TEAM' ? scope.teamId : null,
      startsAt: new Date(
        spec.future ? now + 86_400_000 * 7 : now - 86_400_000 * 30,
      ),
      ...(spec.expired ? { expiresAt: new Date(now - 86_400_000) } : {}),
      ...(spec.revoked ? { revokedAt: new Date(now - 86_400_000) } : {}),
    },
  });
}

describe('Security remediation M1: cross-organization account administration (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: Harness) => Promise<void>,
    options: { notifications?: NotificationService | 'real' } = {},
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            MANAGE,
            AUDIT_READ,
            'employee.read',
          ]);
          await tx.organization.update({
            where: { id: fx.orgB },
            data: { timezone: 'Asia/Kolkata' },
          });
          const jobTitle = await tx.jobTitle.create({
            data: {
              organizationId: fx.orgB,
              name: 'B Associate',
              code: `M1JB-${fx.suffix}`,
            },
          });
          const orgBPosition = (
            await tx.position.create({
              data: {
                organizationId: fx.orgB,
                jobTitleId: jobTitle.id,
                name: 'B Associate',
                code: `M1PB-${fx.suffix}`,
              },
            })
          ).id;
          const client = rollbackClient(tx);
          const authorization = new AuthorizationService(client);
          const audit = new AuditService(client);
          const emails = new RecordingEmails();
          const notifications =
            options.notifications && options.notifications !== 'real'
              ? options.notifications
              : notificationServices(client).notifications;
          const accounts = new ClockedAccounts(
            client,
            authorization,
            new PositionAuthorizationTargetResolver(client),
            audit,
            new AccountTokenService(client, audit),
            emails,
            new EmployeeAccountAlertService(
              client,
              authorization,
              notifications,
            ),
          );
          let count = 0;
          const target: Harness['target'] = async (spec) => {
            count += 1;
            const person = await tx.person.create({
              data: {
                firstName: `M1Target${count}`,
                lastName: fx.suffix,
                personalEmail: `m1-${count}-${fx.suffix.toLowerCase()}@example.com`,
              },
            });
            const employee = await tx.employee.create({
              data: {
                personId: person.id,
                employeeNumber: `M1-${count}-${fx.suffix}`,
                hireDate: new Date('2026-01-01T00:00:00.000Z'),
              },
            });
            for (const [index, a] of spec.assignments.entries()) {
              await tx.employmentAssignment.create({
                data: {
                  employeeId: employee.id,
                  positionId: a.positionId,
                  employmentType: 'FULL_TIME',
                  status: a.status,
                  isPrimary: index === 0,
                  startDate: new Date('2026-01-01T00:00:00.000Z'),
                  ...(a.endDate
                    ? { endDate: new Date(`${a.endDate}T00:00:00.000Z`) }
                    : {}),
                },
              });
            }
            let userId: string | null = null;
            const login = spec.login === undefined ? 'ACTIVE' : spec.login;
            if (login) {
              userId = (
                await tx.user.create({
                  data: {
                    personId: person.id,
                    email: `m1-login-${count}-${fx.suffix.toLowerCase()}@example.com`,
                    status: login,
                    passwordHash:
                      login === 'INVITED' ? null : 'not-a-real-hash',
                  },
                })
              ).id;
              if (login === 'INVITED') {
                await tx.accountToken.create({
                  data: {
                    userId,
                    type: 'INVITATION',
                    tokenHash: `m1-${crypto.randomUUID()}`,
                    expiresAt: new Date(Date.now() + 86_400_000),
                  },
                });
              }
              for (const grant of spec.grants ?? [])
                await grantRole(tx, fx.suffix, userId, grant);
            }
            return { employeeId: employee.id, userId };
          };
          const systemUser: Harness['systemUser'] = async (permissions) => {
            count += 1;
            const person = await tx.person.create({ data: {} });
            const id = (
              await tx.user.create({
                data: {
                  personId: person.id,
                  email: `m1-sys-${count}-${fx.suffix.toLowerCase()}@example.com`,
                  status: 'ACTIVE',
                },
              })
            ).id;
            await grantRole(tx, fx.suffix, id, {
              scope: { type: 'SYSTEM' },
              permissions,
            });
            return id;
          };
          await run({
            tx,
            fx,
            orgBPosition,
            accounts,
            emails,
            target,
            systemUser,
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** A 403 policy refusal with the M1 code and the given reason. */
  async function outsideScope(promise: Promise<unknown>, reason: string) {
    const error = await rejection(promise);
    expect(statusOf(error)).toBe(403);
    expect(codeOf(error)).toBe('ACCOUNT_OUTSIDE_SCOPE');
    expect(reasonOf(error)).toBe(reason);
    return error;
  }

  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  it('(1) lets an organization administrator manage an ordinary current employee', async () => {
    await scenario(async ({ tx, fx, accounts, emails, target }) => {
      const t = await target({
        assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
      });
      const hrA = ctx(fx.users.hrA!);
      expect(await accounts.account(t.employeeId, hrA)).toMatchObject({
        status: 'ACTIVE',
        actions: {
          disable: true,
          sendPasswordReset: true,
          requirePasswordChange: true,
        },
        capabilities: {
          disable: { allowed: true, reason: null },
          sendPasswordReset: { allowed: true, reason: null },
          requirePasswordChange: { allowed: true, reason: null },
          enable: { allowed: false, reason: null },
        },
      });
      await accounts.requirePasswordChange(t.employeeId, {}, hrA);
      await accounts.sendPasswordReset(t.employeeId, hrA);
      expect(emails.sent).toHaveLength(1);
      await accounts.disable(t.employeeId, {}, hrA);
      expect(await accounts.enable(t.employeeId, hrA)).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        await tx.auditLog.count({
          where: { action: REFUSED, entityId: t.userId! },
        }),
      ).toBe(0);
    });
  });

  it('(2, 4, 15) lets an ended assignment protect for 90 days but restore nothing; PLANNED and ACTIVE restore', async () => {
    await scenario(async ({ tx, fx, accounts, emails, target }) => {
      const hrA = ctx(fx.users.hrA!);
      const former = await target({
        assignments: [
          {
            positionId: fx.positionTeamA,
            status: 'ENDED',
            endDate: daysAgo(10),
          },
        ],
      });
      // Restorative and credential actions need a current assignment.
      expect(await accounts.account(former.employeeId, hrA)).toMatchObject({
        capabilities: {
          disable: { allowed: true, reason: null },
          signOut: { allowed: false, reason: null },
          sendPasswordReset: {
            allowed: false,
            reason: 'NO_CURRENT_ASSIGNMENT',
          },
          requirePasswordChange: {
            allowed: false,
            reason: 'NO_CURRENT_ASSIGNMENT',
          },
        },
        actions: { sendPasswordReset: false, requirePasswordChange: false },
      });
      await outsideScope(
        accounts.requirePasswordChange(former.employeeId, {}, hrA),
        'NO_CURRENT_ASSIGNMENT',
      );
      await outsideScope(
        accounts.sendPasswordReset(former.employeeId, hrA),
        'NO_CURRENT_ASSIGNMENT',
      );
      expect(emails.sent).toHaveLength(0);
      // Protective actions still work: offboarding a former employee.
      await accounts.signOut(former.employeeId, hrA);
      await accounts.disable(former.employeeId, {}, hrA);
      await outsideScope(
        accounts.enable(former.employeeId, hrA),
        'NO_CURRENT_ASSIGNMENT',
      );
      await outsideScope(
        accounts.unlock(former.employeeId, hrA),
        'NO_CURRENT_ASSIGNMENT',
      );
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: former.userId! } }))
          .status,
      ).toBe('DISABLED');

      // A pending invitation of a former employee: cancel (protective) yes, resend no.
      const invited = await target({
        assignments: [
          {
            positionId: fx.positionTeamA,
            status: 'ENDED',
            endDate: daysAgo(5),
          },
        ],
        login: 'INVITED',
      });
      await outsideScope(
        accounts.resend(invited.employeeId, {}, hrA),
        'NO_CURRENT_ASSIGNMENT',
      );
      await accounts.cancel(invited.employeeId, hrA);

      // A former employee without a login cannot be invited from the ended assignment.
      const neverInvited = await target({
        assignments: [
          {
            positionId: fx.positionTeamA,
            status: 'ENDED',
            endDate: daysAgo(5),
          },
        ],
        login: null,
      });
      await outsideScope(
        accounts.invite(neverInvited.employeeId, {}, hrA),
        'NO_CURRENT_ASSIGNMENT',
      );

      // PLANNED and ACTIVE assignments authorize restorative actions.
      for (const status of ['PLANNED', 'ACTIVE'] as const) {
        const current = await target({
          assignments: [{ positionId: fx.positionTeamA, status }],
          login: 'DISABLED',
        });
        expect(await accounts.enable(current.employeeId, hrA)).toMatchObject({
          status: 'ACTIVE',
        });
      }
    });
  });

  it('(3, 14) ends protective authority after 90 days, on the assignment business date', async () => {
    await scenario(async ({ fx, orgBPosition, accounts, target }) => {
      // Ended 2026-01-31: the last protective day is 2026-05-01.
      const toronto = await target({
        assignments: [
          {
            positionId: fx.positionTeamA, // Toronto work location
            status: 'ENDED',
            endDate: '2026-01-31',
          },
        ],
      });
      const kolkata = await target({
        assignments: [
          {
            positionId: orgBPosition, // organization time zone Asia/Kolkata
            status: 'ENDED',
            endDate: '2026-01-31',
          },
        ],
      });
      const hrA = ctx(fx.users.hrA!);
      const hrB = ctx(fx.users.hrB!);
      // 23:30 on 2026-05-01 in Toronto; 09:00 on 2026-05-02 in Kolkata.
      accounts.at = new Date('2026-05-02T03:30:00.000Z');
      expect(await accounts.account(toronto.employeeId, hrA)).toMatchObject({
        capabilities: { disable: { allowed: true, reason: null } },
      });
      expect(await accounts.account(kolkata.employeeId, hrB)).toMatchObject({
        capabilities: {
          disable: { allowed: false, reason: 'PROTECTIVE_WINDOW_ENDED' },
        },
      });
      await outsideScope(
        accounts.disable(kolkata.employeeId, {}, hrB),
        'PROTECTIVE_WINDOW_ENDED',
      );
      await accounts
        .signOut(toronto.employeeId, hrA)
        .catch((error: unknown) => {
          // No session to end is a state conflict, never a policy refusal.
          expect(statusOf(error)).toBe(409);
        });
      // One day later in Toronto too.
      accounts.at = new Date('2026-05-02T04:00:00.000Z');
      await outsideScope(
        accounts.disable(toronto.employeeId, {}, hrA),
        'PROTECTIVE_WINDOW_ENDED',
      );
      // Within the window the same action succeeds.
      accounts.at = new Date('2026-05-01T12:00:00.000Z');
      await accounts.disable(kolkata.employeeId, {}, hrB);
      accounts.at = undefined;
      // Real time: long past the window.
      await outsideScope(
        accounts.disable(toronto.employeeId, {}, hrA),
        'PROTECTIVE_WINDOW_ENDED',
      );
    });
  });

  it('(5, 6) keeps an administrator of A away from people with access outside A', async () => {
    await scenario(
      async ({ tx, fx, orgBPosition, accounts, emails, target }) => {
        const hrA = ctx(fx.users.hrA!);
        // A B administrator who once worked in A (ended within the window).
        const bAdmin = await target({
          assignments: [
            {
              positionId: fx.positionTeamA,
              status: 'ENDED',
              endDate: daysAgo(20),
            },
            { positionId: orgBPosition, status: 'ACTIVE' },
          ],
          login: 'DISABLED',
          grants: [
            {
              scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
              permissions: [MANAGE],
              roleName: 'Secret B Payroll Lead',
            },
          ],
        });
        // Read access is unchanged.
        expect(await accounts.account(bAdmin.employeeId, hrA)).toMatchObject({
          status: 'DISABLED',
          capabilities: {
            enable: { allowed: false, reason: 'NO_CURRENT_ASSIGNMENT' },
          },
        });
        const refused = await outsideScope(
          accounts.enable(bAdmin.employeeId, hrA),
          'NO_CURRENT_ASSIGNMENT',
        );
        // Nothing about B is disclosed.
        const body = JSON.stringify((refused as HttpException).getResponse());
        expect(body).not.toContain(fx.orgB);
        expect(body).not.toContain('Org B');
        expect(body).not.toContain('Secret B');
        expect(
          (await tx.user.findUniqueOrThrow({ where: { id: bAdmin.userId! } }))
            .status,
        ).toBe('DISABLED');

        // The same person still current in A: grant coverage decides (even while DISABLED, whose
        // grants authorize nothing until re-enabled).
        const dual = await target({
          assignments: [
            { positionId: fx.positionTeamA, status: 'ACTIVE' },
            { positionId: orgBPosition, status: 'ACTIVE' },
          ],
          login: 'DISABLED',
          grants: [
            {
              scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
              permissions: [MANAGE],
              roleName: 'Secret B Payroll Lead',
            },
          ],
        });
        expect(await accounts.account(dual.employeeId, hrA)).toMatchObject({
          capabilities: {
            enable: { allowed: false, reason: 'ACCESS_OUTSIDE_SCOPE' },
          },
          actions: { enable: false },
        });
        await outsideScope(
          accounts.enable(dual.employeeId, hrA),
          'ACCESS_OUTSIDE_SCOPE',
        );
        // An active login with access in B: no reset, unlock, password change, or disable.
        const activeDual = await target({
          assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
          grants: [
            {
              scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
              permissions: ['employee.read'],
            },
          ],
        });
        for (const attempt of [
          () => accounts.sendPasswordReset(activeDual.employeeId, hrA),
          () => accounts.unlock(activeDual.employeeId, hrA),
          () => accounts.requirePasswordChange(activeDual.employeeId, {}, hrA),
          () => accounts.disable(activeDual.employeeId, {}, hrA),
          () => accounts.signOut(activeDual.employeeId, hrA),
        ])
          await outsideScope(attempt(), 'ACCESS_OUTSIDE_SCOPE');
        expect(emails.sent).toHaveLength(0);
        const after = await tx.user.findUniqueOrThrow({
          where: { id: activeDual.userId! },
        });
        expect(after).toMatchObject({
          status: 'ACTIVE',
          mustChangePassword: false,
        });
        expect(
          await tx.accountToken.count({
            where: { userId: activeDual.userId! },
          }),
        ).toBe(0);

        // An invitation carrying a role in B is not A's to cancel (cancelling revokes it).
        const invitedDual = await target({
          assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
          login: 'INVITED',
          grants: [
            { scope: { type: 'ORGANIZATION', organizationId: fx.orgB } },
          ],
        });
        await outsideScope(
          accounts.cancel(invitedDual.employeeId, hrA),
          'ACCESS_OUTSIDE_SCOPE',
        );
        expect(
          await tx.roleAssignment.count({
            where: { userId: invitedDual.userId!, revokedAt: null },
          }),
        ).toBe(1);
      },
    );
  });

  it('(7, 8, 12) reserves System Owners (the only SYSTEM-scope grants) for System Owners, who may manage anyone else', async () => {
    await scenario(
      async ({ tx, fx, orgBPosition, accounts, target, systemUser }) => {
        const hrA = ctx(fx.users.hrA!);
        const owner = ctx(await systemUser([MANAGE]));
        const ownerTarget = await target({
          assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
          grants: [{ scope: { type: 'SYSTEM' }, permissions: [MANAGE] }],
        });
        // An organization administrator: refused (reads too, as before), audited as high-risk.
        for (const attempt of [
          () => accounts.disable(ownerTarget.employeeId, {}, hrA),
          () => accounts.sendPasswordReset(ownerTarget.employeeId, hrA),
          () => accounts.account(ownerTarget.employeeId, hrA),
        ]) {
          const error = await rejection(attempt());
          expect(statusOf(error)).toBe(403);
          expect(codeOf(error)).toBeUndefined();
        }
        const refusals = await tx.auditLog.findMany({
          where: { action: REFUSED, entityId: ownerTarget.userId! },
          orderBy: { occurredAt: 'asc' },
        });
        // Organization A's copies carry no risk; the System view's copies classify it.
        expect(
          refusals.filter(
            (r) =>
              (r.metadata as Record<string, unknown>).organizationId ===
              fx.orgA,
          ),
        ).toHaveLength(2);
        expect(
          refusals
            .filter((r) => !('organizationId' in (r.metadata as object)))
            .map((r) => r.metadata),
        ).toEqual([
          expect.objectContaining({
            refusedAction: 'disable',
            refusalReason: 'SYSTEM_OWNER_PROTECTED',
            highRisk: true,
            riskCategory: 'SYSTEM_PRIVILEGED_TARGET',
          }),
          expect.objectContaining({
            refusedAction: 'sendPasswordReset',
            refusalReason: 'SYSTEM_OWNER_PROTECTED',
            highRisk: true,
          }),
        ]);
        // A System Owner may manage another System Owner …
        await accounts.disable(ownerTarget.employeeId, {}, owner);
        // … and, with global authority, any eligible account: no assignment or coverage limit.
        const bAdmin = await target({
          assignments: [
            {
              positionId: orgBPosition,
              status: 'ENDED',
              endDate: daysAgo(200),
            },
          ],
          login: 'DISABLED',
          grants: [
            {
              scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
              permissions: [MANAGE],
            },
          ],
        });
        expect(await accounts.account(bAdmin.employeeId, owner)).toMatchObject({
          capabilities: { enable: { allowed: true, reason: null } },
        });
        expect(await accounts.enable(bAdmin.employeeId, owner)).toMatchObject({
          status: 'ACTIVE',
        });
      },
    );
  });

  it('(9) enforces unit, department and team containment', async () => {
    await scenario(async ({ fx, accounts, target }) => {
      const unitHr = ctx(fx.users.unitHr!);
      const teamAHr = ctx(fx.users.teamAHr!);
      const withGrant = (scope: ScopeSpec) =>
        target({
          assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
          grants: [{ scope }],
        });
      // Dept A sits in the child unit; Team A in Dept A; Dept B outside the unit.
      const deptA = await withGrant({
        type: 'DEPARTMENT',
        organizationId: fx.orgA,
        departmentId: fx.deptA,
      });
      const deptB = await withGrant({
        type: 'DEPARTMENT',
        organizationId: fx.orgA,
        departmentId: fx.deptB,
      });
      const teamA = await withGrant({
        type: 'TEAM',
        organizationId: fx.orgA,
        teamId: fx.teamA,
      });
      const orgWide = await withGrant({
        type: 'ORGANIZATION',
        organizationId: fx.orgA,
      });
      const rootUnit = await withGrant({
        type: 'ORGANIZATIONAL_UNIT',
        organizationId: fx.orgA,
        unitId: fx.unitRoot,
      });
      await accounts.requirePasswordChange(deptA.employeeId, {}, unitHr);
      await accounts.requirePasswordChange(teamA.employeeId, {}, unitHr);
      for (const t of [deptB, orgWide, rootUnit])
        await outsideScope(
          accounts.requirePasswordChange(t.employeeId, {}, unitHr),
          'ACCESS_OUTSIDE_SCOPE',
        );
      await accounts.disable(teamA.employeeId, {}, teamAHr);
      for (const t of [deptA, orgWide])
        await outsideScope(
          accounts.disable(t.employeeId, {}, teamAHr),
          'ACCESS_OUTSIDE_SCOPE',
        );
    });
  });

  it('(10, 13) lets an actor covering every grant act, and ignores revoked and expired grants', async () => {
    await scenario(async ({ fx, orgBPosition, accounts, target }) => {
      const both = await target({
        assignments: [
          { positionId: fx.positionTeamA, status: 'ACTIVE' },
          { positionId: orgBPosition, status: 'ACTIVE' },
        ],
        grants: [
          { scope: { type: 'ORGANIZATION', organizationId: fx.orgA } },
          { scope: { type: 'ORGANIZATION', organizationId: fx.orgB } },
        ],
      });
      await outsideScope(
        accounts.requirePasswordChange(both.employeeId, {}, ctx(fx.users.hrA!)),
        'ACCESS_OUTSIDE_SCOPE',
      );
      await accounts.requirePasswordChange(
        both.employeeId,
        {},
        ctx(fx.users.hrAB!),
      );

      const lapsed = await target({
        assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
        grants: [
          {
            scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
            revoked: true,
          },
          {
            scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
            expired: true,
          },
        ],
      });
      await accounts.disable(lapsed.employeeId, {}, ctx(fx.users.hrA!));
    });
  });

  it('(11) still refuses one’s own login, and audits the attempt', async () => {
    await scenario(async ({ tx, fx, accounts }) => {
      const error = await rejection(
        accounts.disable(fx.employee1, {}, ctx(fx.users.self1!)),
      );
      expect(statusOf(error)).toBe(403);
      const [entry] = await tx.auditLog.findMany({
        where: { action: REFUSED, actorUserId: fx.users.self1 },
      });
      expect(entry?.metadata).toMatchObject({
        organizationId: fx.orgA,
        refusedAction: 'disable',
        refusalReason: 'SELF_MANAGEMENT',
      });
      expect(entry?.metadata).not.toHaveProperty('highRisk');
    });
  });

  it('audits refusals in the actor’s organizations only, without disclosing the other organization', async () => {
    await scenario(async ({ tx, fx, orgBPosition, accounts, target }) => {
      const dual = await target({
        assignments: [
          { positionId: fx.positionTeamA, status: 'ACTIVE' },
          { positionId: orgBPosition, status: 'ACTIVE' },
        ],
        grants: [
          {
            scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
            roleName: 'Secret B Payroll Lead',
          },
        ],
      });
      await outsideScope(
        accounts.sendPasswordReset(dual.employeeId, ctx(fx.users.hrA!)),
        'ACCESS_OUTSIDE_SCOPE',
      );
      const entries = await tx.auditLog.findMany({
        where: { action: REFUSED, entityId: dual.userId! },
      });
      expect(entries).toHaveLength(2);
      const orgCopy = entries.find(
        (e) =>
          (e.metadata as Record<string, unknown>).organizationId === fx.orgA,
      )!;
      const systemCopy = entries.find((e) => e !== orgCopy)!;
      expect(orgCopy).toMatchObject({
        actorUserId: fx.users.hrA,
        entityType: 'User',
        correlationId: 'phase7-db-spec',
        metadata: {
          organizationId: fx.orgA,
          employeeId: dual.employeeId,
          refusedAction: 'sendPasswordReset',
          actionClass: 'RESTORATIVE',
          refusalReason: 'ACCESS_OUTSIDE_SCOPE',
        },
      });
      // The organization's copy does not say why it is high-risk (privilege, another
      // organization); only the System view's copy, for the same attempt, does.
      expect(orgCopy.metadata).not.toHaveProperty('highRisk');
      expect(orgCopy.metadata).not.toHaveProperty('riskCategory');
      expect(systemCopy.metadata).not.toHaveProperty('organizationId');
      expect(systemCopy.metadata).toMatchObject({
        attemptId: (orgCopy.metadata as Record<string, unknown>).attemptId,
        highRisk: true,
        riskCategory: 'CROSS_ORGANIZATION',
      });
      const text = JSON.stringify(entries);
      expect(text).not.toContain(fx.orgB);
      expect(text).not.toContain('Secret B');
      expect(text).not.toContain('@');
    });
  });

  describe('high-risk alerts', () => {
    it('alerts SYSTEM security administrators only, once per hour, without hidden details', async () => {
      await scenario(
        async ({ tx, fx, orgBPosition, accounts, target, systemUser }) => {
          const securityAdmin = await systemUser([AUDIT_READ]);
          const dual = await target({
            assignments: [
              { positionId: fx.positionTeamA, status: 'ACTIVE' },
              { positionId: orgBPosition, status: 'ACTIVE' },
            ],
            grants: [
              {
                scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
                roleName: 'Secret B Payroll Lead',
              },
            ],
          });
          const hrA = ctx(fx.users.hrA!);
          await outsideScope(
            accounts.disable(dual.employeeId, {}, hrA),
            'ACCESS_OUTSIDE_SCOPE',
          );
          await outsideScope(
            accounts.disable(dual.employeeId, {}, hrA),
            'ACCESS_OUTSIDE_SCOPE',
          );
          const alerts = await tx.notification.findMany({
            where: { type: ALERT, recipientUserId: securityAdmin },
          });
          expect(alerts).toHaveLength(1);
          expect(alerts[0]).toMatchObject({
            category: 'SECURITY',
            mandatory: true,
            organizationId: fx.orgA,
            link: '/admin/audit',
          });
          const text = `${alerts[0]!.title} ${alerts[0]!.body}`;
          expect(text).not.toContain(fx.orgB);
          expect(text).not.toContain('Org B');
          expect(text).not.toContain('Secret B');
          // Never the organization's own auditor, nor the actor.
          for (const other of [fx.users.auditA!, fx.users.hrA!])
            expect(
              await tx.notification.count({
                where: { type: ALERT, recipientUserId: other },
              }),
            ).toBe(0);
          // Both refusals are audited (two attempts) even though one alert was sent.
          const attempts = new Set(
            (
              await tx.auditLog.findMany({
                where: { action: REFUSED, entityId: dual.userId! },
              })
            ).map((r) => (r.metadata as Record<string, unknown>).attemptId),
          );
          expect(attempts.size).toBe(2);
        },
        { notifications: 'real' },
      );
    });

    it('alerts on SYSTEM-privileged targets and on repeated restorative refusals, not on ordinary refusals', async () => {
      await scenario(
        async ({ tx, fx, accounts, target, systemUser }) => {
          const securityAdmin = await systemUser([AUDIT_READ]);
          const alerts = () =>
            tx.notification.findMany({
              where: { type: ALERT, recipientUserId: securityAdmin },
              orderBy: { createdAt: 'asc' },
            });
          // An ordinary refusal inside A (team administrator, department grant): no alert.
          const deptGrant = await target({
            assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
            grants: [
              {
                scope: {
                  type: 'DEPARTMENT',
                  organizationId: fx.orgA,
                  departmentId: fx.deptA,
                },
              },
            ],
            login: 'DISABLED',
          });
          const teamAHr = ctx(fx.users.teamAHr!);
          await outsideScope(
            accounts.disable(deptGrant.employeeId, {}, teamAHr),
            'ACCESS_OUTSIDE_SCOPE',
          );
          await outsideScope(
            accounts.enable(deptGrant.employeeId, teamAHr),
            'ACCESS_OUTSIDE_SCOPE',
          );
          await outsideScope(
            accounts.enable(deptGrant.employeeId, teamAHr),
            'ACCESS_OUTSIDE_SCOPE',
          );
          expect(await alerts()).toHaveLength(0);
          // The third refused restorative attempt in 24 hours is repeated.
          await outsideScope(
            accounts.enable(deptGrant.employeeId, teamAHr),
            'ACCESS_OUTSIDE_SCOPE',
          );
          expect(await alerts()).toHaveLength(1);

          const ownerTarget = await target({
            assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
            grants: [{ scope: { type: 'SYSTEM' } }],
          });
          const ownerRefusal = await rejection(
            accounts.signOut(ownerTarget.employeeId, ctx(fx.users.hrA!)),
          );
          expect(statusOf(ownerRefusal)).toBe(403);
          const all = await alerts();
          expect(all).toHaveLength(2);
          expect(all.map((row) => row.dedupeKey)).toEqual([
            expect.stringContaining('REPEATED_REFUSALS'),
            expect.stringContaining('SYSTEM_PRIVILEGED_TARGET'),
          ]);
          expect(all[1]!.body).not.toContain('employee.read');
        },
        { notifications: 'real' },
      );
    });

    it('keeps alerts out of organization delivery logs and templates', async () => {
      await scenario(
        async ({ tx, fx, orgBPosition, accounts, target, systemUser }) => {
          const securityAdmin = await systemUser([
            AUDIT_READ,
            'notification.delivery.read',
          ]);
          const dual = await target({
            assignments: [
              { positionId: fx.positionTeamA, status: 'ACTIVE' },
              { positionId: orgBPosition, status: 'ACTIVE' },
            ],
            grants: [
              { scope: { type: 'ORGANIZATION', organizationId: fx.orgB } },
            ],
          });
          await outsideScope(
            accounts.disable(dual.employeeId, {}, ctx(fx.users.hrA!)),
            'ACCESS_OUTSIDE_SCOPE',
          );
          const [alert] = await tx.notification.findMany({
            where: { type: ALERT, recipientUserId: securityAdmin },
            include: { deliveries: true },
          });
          expect(alert?.organizationId).toBe(fx.orgA);
          const services = notificationServices(rollbackClient(tx));
          const log = new NotificationDeliveryLogService(
            rollbackClient(tx),
            services.access,
          );
          // Organization A's delivery-log reader sees neither the delivery nor the type …
          const listed = await log.list(fx.users.notifyA!, {
            organizationId: fx.orgA,
          });
          expect(listed.items.map((item) => item.type)).not.toContain(ALERT);
          expect(listed.types.map((type) => type.key)).not.toContain(ALERT);
          expect(
            (
              await log.list(fx.users.notifyA!, {
                organizationId: fx.orgA,
                type: ALERT,
              })
            ).items,
          ).toHaveLength(0);
          for (const delivery of alert!.deliveries) {
            const error = await rejection(
              log.detail(fx.users.notifyA!, delivery.id),
            );
            expect(statusOf(error)).toBe(404);
          }
          // … a SYSTEM reader does.
          expect(
            (
              await log.list(securityAdmin, {
                organizationId: fx.orgA,
                type: ALERT,
              })
            ).items.length,
          ).toBeGreaterThan(0);
          // The template cannot be overridden or even listed by the organization.
          const templates = await services.templates.list(
            fx.users.notifyA!,
            fx.orgA,
          );
          expect(templates.items.map((item) => item.key)).not.toContain(ALERT);
          const override = await rejection(
            services.templates.create(
              {
                organizationId: fx.orgA,
                key: ALERT,
                subjectTemplate: 'Weekly digest ready',
                bodyTemplate: 'Nothing to see.',
              },
              ctx(fx.users.notifyA!),
            ),
          );
          expect(statusOf(override)).toBe(400);
          const preview = await rejection(
            services.templates.preview(fx.users.notifyA!, {
              organizationId: fx.orgA,
              key: ALERT,
            }),
          );
          expect(statusOf(preview)).toBe(400);
          // The System audit view shows what was refused and why (code-valued keys only).
          const { projectAuditMetadata } =
            await import('../src/audit/audit-viewer-domain.js');
          const systemCopy = (
            await tx.auditLog.findMany({
              where: { action: REFUSED, entityId: dual.userId! },
            })
          ).find((row) => !('organizationId' in (row.metadata as object)));
          expect(projectAuditMetadata(systemCopy!.metadata)).toMatchObject({
            refusedAction: 'disable',
            refusalReason: 'ACCESS_OUTSIDE_SCOPE',
            actionClass: 'PROTECTIVE',
            highRisk: true,
            riskCategory: 'CROSS_ORGANIZATION',
          });
        },
        { notifications: 'real' },
      );
    });

    it('caps alerts per administrator per hour, then sends one summary', async () => {
      await scenario(
        async ({ tx, fx, orgBPosition, accounts, target, systemUser }) => {
          const securityAdmin = await systemUser([AUDIT_READ]);
          const hrA = ctx(fx.users.hrA!);
          for (let i = 0; i < ALERTS_PER_ACTOR_PER_HOUR + 3; i += 1) {
            const dual = await target({
              assignments: [
                { positionId: fx.positionTeamA, status: 'ACTIVE' },
                { positionId: orgBPosition, status: 'ACTIVE' },
              ],
              grants: [
                { scope: { type: 'ORGANIZATION', organizationId: fx.orgB } },
              ],
            });
            await outsideScope(
              accounts.disable(dual.employeeId, {}, hrA),
              'ACCESS_OUTSIDE_SCOPE',
            );
          }
          const alerts = await tx.notification.findMany({
            where: { type: ALERT, recipientUserId: securityAdmin },
          });
          expect(alerts).toHaveLength(ALERTS_PER_ACTOR_PER_HOUR + 1);
          expect(
            alerts.filter((a) => a.dedupeKey.includes(':CAPPED:')),
          ).toHaveLength(1);
        },
        { notifications: 'real' },
      );
    });

    it('keeps the refusal when the alert cannot be delivered', async () => {
      const failing = {
        publish: () => Promise.reject(new Error('notification store down')),
      } as unknown as NotificationService;
      await scenario(
        async ({ tx, fx, accounts, target, systemUser }) => {
          await systemUser([AUDIT_READ]);
          const ownerTarget = await target({
            assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
            grants: [{ scope: { type: 'SYSTEM' } }],
          });
          const error = await rejection(
            accounts.disable(ownerTarget.employeeId, {}, ctx(fx.users.hrA!)),
          );
          expect(statusOf(error)).toBe(403);
          expect(
            (
              await tx.user.findUniqueOrThrow({
                where: { id: ownerTarget.userId! },
              })
            ).status,
          ).toBe('ACTIVE');
          // One attempt: organization A's copy and the System view's copy.
          expect(
            await tx.auditLog.count({
              where: { action: REFUSED, entityId: ownerTarget.userId! },
            }),
          ).toBe(2);
        },
        { notifications: failing },
      );
    });
  });

  it('keeps reads, and the existing employee-without-access refusal, unchanged', async () => {
    await scenario(async ({ fx, accounts, target }) => {
      const t = await target({
        assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
        grants: [{ scope: { type: 'ORGANIZATION', organizationId: fx.orgB } }],
      });
      // Reading the login of someone with access elsewhere is still allowed …
      expect(
        await accounts.account(t.employeeId, ctx(fx.users.hrA!)),
      ).toMatchObject({
        status: 'ACTIVE',
        capabilities: {
          disable: { allowed: false, reason: 'ACCESS_OUTSIDE_SCOPE' },
          signOut: { allowed: false, reason: null },
        },
      });
      // … and an administrator with no authority over the employee is refused as before.
      const error = await rejection(
        accounts.account(t.employeeId, ctx(fx.users.hrB!)),
      );
      expect(statusOf(error)).toBe(403);
      expect(codeOf(error)).toBeUndefined();
    });
  });

  it('(13) ignores a grant whose start lies ahead', async () => {
    await scenario(async ({ fx, accounts, target }) => {
      const t = await target({
        assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
        grants: [
          {
            scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
            future: true,
          },
        ],
      });
      await accounts.requirePasswordChange(
        t.employeeId,
        {},
        ctx(fx.users.hrA!),
      );
    });
  });

  it('writes nothing for an ordinary user’s refused request, and flags an administrator from an unrelated organization', async () => {
    await scenario(
      async ({ tx, fx, accounts, target, systemUser }) => {
        const securityAdmin = await systemUser([AUDIT_READ]);
        const t = await target({
          assignments: [{ positionId: fx.positionTeamA, status: 'ACTIVE' }],
        });
        // auditA holds no employee.account.manage anywhere: the earlier refusal, unaudited.
        const plain = await rejection(
          accounts.disable(t.employeeId, {}, ctx(fx.users.auditA!)),
        );
        expect(statusOf(plain)).toBe(403);
        expect(
          await tx.auditLog.count({
            where: { action: REFUSED, actorUserId: fx.users.auditA },
          }),
        ).toBe(0);
        // hrB administers logins in B only: refused, audited in the System view, alerted.
        const crossed = await rejection(
          accounts.disable(t.employeeId, {}, ctx(fx.users.hrB!)),
        );
        expect(statusOf(crossed)).toBe(403);
        expect(codeOf(crossed)).toBeUndefined();
        const [entry, ...more] = await tx.auditLog.findMany({
          where: { action: REFUSED, actorUserId: fx.users.hrB },
        });
        expect(more).toHaveLength(0);
        expect(entry!.metadata).toMatchObject({
          refusalReason: 'NO_ACCOUNT_AUTHORITY',
          highRisk: true,
          riskCategory: 'CROSS_ORGANIZATION',
        });
        expect(entry!.metadata).not.toHaveProperty('organizationId');
        const [alert] = await tx.notification.findMany({
          where: { type: ALERT, recipientUserId: securityAdmin },
        });
        // Filed under organization B (the actor's own), never A's.
        expect(alert).toMatchObject({ organizationId: fx.orgB });
      },
      { notifications: 'real' },
    );
  });
});
