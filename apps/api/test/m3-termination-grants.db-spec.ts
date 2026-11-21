import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PayrollAccessService } from '../src/payroll/payroll-access.service.js';
import { PayrollSeparationService } from '../src/payroll/payroll-separation.service.js';
import { PayrollReadService } from '../src/payroll/payroll-read.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const ADMIN = ['employee.manage', 'employee.read', 'role.read', 'role.assign'];
/** The permissions the test roles grant; a full delegator holds them all. */
const ROLE_KEYS = ['time.clock', 'payroll.read', 'payroll.calculate'];
const USERS = {
  hrA: [{ permissions: [...ADMIN, ...ROLE_KEYS], scope: 'org' as const }],
  hrA2: [{ permissions: [...ADMIN, ...ROLE_KEYS], scope: 'org' as const }],
  hrB: [{ permissions: ADMIN, scope: 'orgB' as const }],
  // M3 decision C: role.assign over the organization, but not the roles' permissions.
  hrAssignOnly: [{ permissions: ADMIN, scope: 'org' as const }],
  // Only part of a custom role's permissions.
  hrClockOnly: [
    { permissions: [...ADMIN, 'time.clock'], scope: 'org' as const },
  ],
  // Every permission, but only over team A (narrower than the organization).
  hrTeam: [{ permissions: [...ADMIN, ...ROLE_KEYS], scope: 'teamA' as const }],
};
const GRANTS_FROM = new Date('2026-01-01T00:00:00.000Z');
const DAY = 86_400_000;
const CONFIDENTIAL = 'Confidential-misconduct-finding-7731';

const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();
/** A calendar date `days` from today (UTC), as YYYY-MM-DD. */
const day = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
/** Noon UTC on that date: past the date's end in every time zone from UTC−12. */
const after = (date: string, days = 1) =>
  new Date(new Date(`${date}T12:00:00.000Z`).getTime() + days * DAY);

function services(client: PrismaService) {
  const authorization = new AuthorizationService(client);
  const audit = new AuditService(client);
  const access = new EmployeeAccessService(
    client,
    authorization,
    new PositionAuthorizationTargetResolver(client),
    audit,
  );
  return {
    lifecycle: new EmployeeLifecycleService(
      client,
      new EmployeeDomainService(client, audit),
      access,
      authorization,
      audit,
      new RoleManagementService(client, authorization, audit),
    ),
    // The worker composes the lifecycle without the Roles API (employee-jobs.ts).
    workerLifecycle: new EmployeeLifecycleService(
      client,
      new EmployeeDomainService(client, audit),
      access,
      authorization,
      audit,
    ),
    roles: new RoleManagementService(client, authorization, audit),
  };
}

type Scope =
  | { type: 'SYSTEM' }
  | { type: 'ORGANIZATION'; organizationId: string }
  | {
      type: 'TEAM' | 'DEPARTMENT' | 'ORGANIZATIONAL_UNIT';
      organizationId: string;
      id: string;
    };

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  orgBPosition: string;
  orgC: string;
  lifecycle: EmployeeLifecycleService;
  workerLifecycle: EmployeeLifecycleService;
  roles: RoleManagementService;
  owner1: string;
  owner2: string;
  target: (spec: {
    inB?: boolean;
    grants?: Array<{
      scope: Scope;
      permissions?: string[];
      expiresAt?: Date;
    }>;
  }) => Promise<{ employeeId: string; userId: string; grants: string[] }>;
  grant: (
    userId: string,
    scope: Scope,
    permissions?: string[],
    expiresAt?: Date,
  ) => Promise<string>;
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
 * Security remediation M3 — role grants at termination: revoked when the termination applies,
 * within the organizations it ends, except separately approved, expiring keeps; SYSTEM (System
 * Owner) grants need an explicit decision; manual and automatic application are the same.
 */
describe('Security remediation M3: grants at termination (database)', () => {
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
          const fx = await createSchedulingFixtures(
            tx,
            USERS,
            [...ADMIN, 'time.clock', 'payroll.read', 'payroll.calculate'],
            { grantsStartAt: GRANTS_FROM },
          );
          await tx.organization.update({
            where: { id: fx.orgB },
            data: { timezone: 'Asia/Kolkata' },
          });
          const jobTitle = await tx.jobTitle.create({
            data: {
              organizationId: fx.orgB,
              name: 'B Associate',
              code: `M3JB-${fx.suffix}`,
            },
          });
          const orgBPosition = (
            await tx.position.create({
              data: {
                organizationId: fx.orgB,
                jobTitleId: jobTitle.id,
                name: 'B Associate',
                code: `M3PB-${fx.suffix}`,
              },
            })
          ).id;
          const orgC = (
            await tx.organization.create({
              data: { name: 'M3 Org C', code: `M3C-${fx.suffix}` },
            })
          ).id;
          const client = rollbackClient(tx);
          const { lifecycle, workerLifecycle, roles } = services(client);

          let ownerRole = (
            await tx.role.findFirst({ where: { isSystemOwner: true } })
          )?.id;
          ownerRole ??= (
            await tx.role.create({
              data: {
                organizationId: null,
                code: 'SYSTEM_OWNER',
                name: 'System Owner',
                isSystemOwner: true,
              },
            })
          ).id;
          for (const key of ADMIN)
            await tx.rolePermission.upsert({
              where: {
                roleId_permissionId: {
                  roleId: ownerRole,
                  permissionId: await permissionIdOf(tx, key),
                },
              },
              create: {
                roleId: ownerRole,
                permissionId: await permissionIdOf(tx, key),
              },
              update: {},
            });

          const grant: Harness['grant'] = async (
            userId,
            scope,
            permissions = ['time.clock'],
            expiresAt,
          ) => {
            const organizationId =
              scope.type === 'SYSTEM' ? null : scope.organizationId;
            const roleId =
              scope.type === 'SYSTEM'
                ? ownerRole
                : (
                    await tx.role.create({
                      data: {
                        organizationId,
                        code: `M3-${randomUUID().slice(0, 8)}`,
                        name: `M3 role ${permissions.join('+')}`,
                      },
                    })
                  ).id;
            if (scope.type !== 'SYSTEM')
              for (const key of permissions)
                await tx.rolePermission.create({
                  data: { roleId, permissionId: await permissionIdOf(tx, key) },
                });
            return (
              await tx.roleAssignment.create({
                data: {
                  userId,
                  roleId,
                  roleOrganizationId: organizationId,
                  scopeType: scope.type,
                  organizationId,
                  ...(scope.type === 'TEAM' ? { teamId: scope.id } : {}),
                  ...(scope.type === 'DEPARTMENT'
                    ? { departmentId: scope.id }
                    : {}),
                  ...(scope.type === 'ORGANIZATIONAL_UNIT'
                    ? { organizationalUnitId: scope.id }
                    : {}),
                  startsAt: GRANTS_FROM,
                  ...(expiresAt ? { expiresAt } : {}),
                },
              })
            ).id;
          };

          let count = 0;
          const login = async (personId: string) =>
            (
              await tx.user.create({
                data: {
                  personId,
                  email: `m3-${count}-${fx.suffix.toLowerCase()}@example.com`,
                  status: 'ACTIVE',
                  passwordHash: 'not-a-real-hash',
                },
              })
            ).id;
          const target: Harness['target'] = async (spec) => {
            count += 1;
            const person = await tx.person.create({
              data: { firstName: `M3Target${count}`, lastName: fx.suffix },
            });
            const employee = await tx.employee.create({
              data: {
                personId: person.id,
                employeeNumber: `M3-${count}-${fx.suffix}`,
                hireDate: new Date('2026-01-01T00:00:00.000Z'),
              },
            });
            const positions = [
              fx.positionTeamA,
              ...(spec.inB ? [orgBPosition] : []),
            ];
            for (const [index, positionId] of positions.entries())
              await tx.employmentAssignment.create({
                data: {
                  employeeId: employee.id,
                  positionId,
                  employmentType: 'FULL_TIME',
                  status: 'ACTIVE',
                  isPrimary: index === 0,
                  startDate: new Date('2026-01-01T00:00:00.000Z'),
                },
              });
            const userId = await login(person.id);
            await tx.authSession.create({
              data: {
                userId,
                refreshTokenHash: randomUUID(),
                expiresAt: new Date(Date.now() + 30 * DAY),
              },
            });
            const grants: string[] = [];
            for (const g of spec.grants ?? [])
              grants.push(
                await grant(userId, g.scope, g.permissions, g.expiresAt),
              );
            return { employeeId: employee.id, userId, grants };
          };
          const owner = async () => {
            count += 1;
            const person = await tx.person.create({ data: {} });
            const id = await login(person.id);
            await grant(id, { type: 'SYSTEM' });
            return id;
          };
          const owner1 = await owner();
          const owner2 = await owner();
          await run({
            tx,
            fx,
            orgBPosition,
            orgC,
            lifecycle,
            workerLifecycle,
            roles,
            owner1,
            owner2,
            target,
            grant,
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

  const A = (fx: SchedulingFixtures): Scope => ({
    type: 'ORGANIZATION',
    organizationId: fx.orgA,
  });
  const revokedState = (tx: Tx, id: string) =>
    tx.roleAssignment.findUniqueOrThrow({ where: { id } });

  it('(1, 2, 3, 22) revokes HR, payroll and self-service grants when an immediate termination applies, and disables the login', async () => {
    await scenario(async ({ tx, fx, lifecycle, target }) => {
      const t = await target({
        grants: [
          { scope: A(fx), permissions: ['employee.manage', 'employee.read'] },
          { scope: A(fx), permissions: ['payroll.read', 'payroll.calculate'] },
          { scope: A(fx), permissions: ['time.clock'] },
        ],
      });
      const result = await lifecycle.terminate(
        t.employeeId,
        { terminationDate: day(-3), reason: CONFIDENTIAL },
        ctx(fx.users.hrA!),
      );
      expect(result.termination.status).toBe('APPLIED');
      expect(result.grants).toMatchObject({ revoked: 3, retained: 0 });
      for (const id of t.grants) {
        expect(await revokedState(tx, id)).toMatchObject({
          revokedByUserId: fx.users.hrA,
          revocationReason: 'employment_terminated',
        });
        expect((await revokedState(tx, id)).revokedAt).not.toBeNull();
      }
      const user = await tx.user.findUniqueOrThrow({ where: { id: t.userId } });
      expect(user.status).toBe('DISABLED');
      expect(
        await tx.authSession.count({
          where: { userId: t.userId, revokedAt: null },
        }),
      ).toBe(0);
      // One revocation audit entry per grant, tied to the termination, never with its reason.
      const audits = await tx.auditLog.findMany({
        where: {
          action: 'ROLE_ASSIGNMENT_REVOKED',
          entityId: { in: t.grants },
        },
      });
      expect(audits).toHaveLength(3);
      for (const entry of audits)
        expect(entry.metadata).toMatchObject({
          terminationId: result.termination.id,
          reasonCode: 'EMPLOYMENT_TERMINATED',
          source: 'IMMEDIATE',
        });
      const decisions = await tx.employeeTerminationGrantDecision.findMany({
        where: { terminationId: result.termination.id },
      });
      expect(JSON.stringify([audits, decisions])).not.toContain(CONFIDENTIAL);
    });
  });

  it('(4) revokes only within the organizations the termination ends, keeping other access and the login', async () => {
    await scenario(async ({ tx, fx, orgC, lifecycle, target }) => {
      const t = await target({
        inB: true,
        grants: [
          { scope: A(fx) },
          { scope: { type: 'ORGANIZATION', organizationId: fx.orgB } },
          { scope: { type: 'ORGANIZATION', organizationId: orgC } },
        ],
      });
      // hrA manages A only: the employee-wide termination needs both organizations' authority.
      const partial = await rejection(
        lifecycle.terminate(
          t.employeeId,
          { terminationDate: day(-3) },
          ctx(fx.users.hrA!),
        ),
      );
      expect(statusOf(partial)).toBe(403);
      // An administrator of both organizations terminates: A and B end, C has no employment.
      const hrAB = fx.users.hrA!;
      await tx.roleAssignment.create({
        data: {
          userId: hrAB,
          roleId: (
            await tx.roleAssignment.findFirstOrThrow({
              where: { userId: fx.users.hrB! },
            })
          ).roleId,
          roleOrganizationId: fx.orgB,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgB,
          startsAt: GRANTS_FROM,
        },
      });
      const result = await lifecycle.terminate(
        t.employeeId,
        { terminationDate: day(-3) },
        ctx(hrAB),
      );
      expect(result.grants).toMatchObject({ revoked: 2, retained: 0 });
      const [inA, inB, inC] = await Promise.all(
        t.grants.map((id) => revokedState(tx, id)),
      );
      expect(inA!.revokedAt).not.toBeNull();
      expect(inB!.revokedAt).not.toBeNull();
      expect(inC!.revokedAt).toBeNull();
      // C still authorizes something: the shared login stays enabled.
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('ACTIVE');
    });
  });

  it('(5, 7) requires an explicit decision for each SYSTEM grant; the acknowledgement alone keeps nothing', async () => {
    await scenario(async ({ tx, fx, lifecycle, target, owner1 }) => {
      const t = await target({ grants: [{ scope: { type: 'SYSTEM' } }] });
      const systemGrant = t.grants[0]!;
      // An organization administrator cannot terminate a System Owner at all (as before).
      expect(
        codeOf(
          await violation(tx, () =>
            lifecycle.terminate(
              t.employeeId,
              { terminationDate: day(-3) },
              ctx(fx.users.hrA!),
            ),
          ),
        ),
      ).toBe('TERMINATION_SYSTEM_ACTOR_REQUIRED');
      // The legacy acknowledgement no longer means "keep all": a decision per grant is required.
      for (const input of [
        { terminationDate: day(-3) },
        { terminationDate: day(-3), acknowledgeSystemGrants: true },
      ]) {
        // Each refused request runs in a savepoint, as its own transaction would roll back.
        const error = await violation(tx, () =>
          lifecycle.terminate(t.employeeId, input, ctx(owner1)),
        );
        expect(statusOf(error)).toBe(400);
        expect(codeOf(error)).toBe('TERMINATION_GRANT_DECISION_REQUIRED');
      }
      // An explicit REVOKE.
      const result = await lifecycle.terminate(
        t.employeeId,
        {
          terminationDate: day(-3),
          grantDecisions: [
            { roleAssignmentId: systemGrant, decision: 'REVOKE' },
          ],
        },
        ctx(owner1),
      );
      expect(result.termination.status).toBe('APPLIED');
      expect(await revokedState(tx, systemGrant)).toMatchObject({
        revokedByUserId: owner1,
        revocationReason: 'employment_terminated',
      });
    });
  });

  it('(6, 11) keeps a SYSTEM grant only with an independent approval, as an expiring replacement', async () => {
    await scenario(async ({ tx, lifecycle, target, owner1, owner2 }) => {
      const t = await target({ grants: [{ scope: { type: 'SYSTEM' } }] });
      const date = day(5);
      const keepUntil = after(date, 10).toISOString();
      const scheduled = await lifecycle.terminate(
        t.employeeId,
        {
          terminationDate: date,
          grantDecisions: [
            {
              roleAssignmentId: t.grants[0]!,
              decision: 'KEEP',
              reason: 'Handover of the payroll provider integration',
              keepUntil,
            },
          ],
        },
        ctx(owner1),
      );
      const terminationId = scheduled.termination.id;
      // The result says the termination cannot apply until the keep is reviewed.
      expect(scheduled.applyBlockedBy).toEqual({
        code: 'TERMINATION_KEEP_APPROVAL_REQUIRED',
        roleAssignmentIds: [t.grants[0]],
      });
      const listing = await lifecycle.terminationGrants(
        t.employeeId,
        terminationId,
        owner2,
      );
      const decision = listing.grants[0]!.decision!;
      expect(listing.grants[0]).toMatchObject({
        system: true,
        outcome: 'KEEP_PENDING',
      });
      expect(decision).toMatchObject({
        decision: 'KEEP',
        status: 'REQUESTED',
        requestedByUserId: owner1,
      });
      // Applying with the keep still pending is blocked, and nothing changes.
      const blocked = await rejection(
        lifecycle.applyTermination(
          t.employeeId,
          terminationId,
          ctx(owner2),
          after(date),
        ),
      );
      expect(codeOf(blocked)).toBe('TERMINATION_KEEP_APPROVAL_REQUIRED');
      // The requester cannot approve their own exception.
      expect(
        codeOf(
          await rejection(
            lifecycle.approveGrantKeep(
              t.employeeId,
              terminationId,
              decision.id,
              {},
              ctx(owner1),
            ),
          ),
        ),
      ).toBe('TERMINATION_KEEP_SELF_APPROVAL');
      await lifecycle.approveGrantKeep(
        t.employeeId,
        terminationId,
        decision.id,
        {},
        ctx(owner2),
      );
      const applied = await lifecycle.applyTermination(
        t.employeeId,
        terminationId,
        ctx(owner2),
        after(date),
      );
      expect(applied.grants).toMatchObject({ revoked: 0, retained: 1 });
      const original = await revokedState(tx, t.grants[0]!);
      expect(original.revokedAt).not.toBeNull();
      const row = await tx.employeeTerminationGrantDecision.findUniqueOrThrow({
        where: { id: decision.id },
      });
      expect(row).toMatchObject({
        status: 'APPROVED',
        requestedByUserId: owner1,
        reviewedByUserId: owner2,
        outcome: 'RETAINED',
      });
      const replacement = await revokedState(tx, row.retainedRoleAssignmentId!);
      expect(replacement).toMatchObject({
        scopeType: 'SYSTEM',
        revokedAt: null,
      });
      expect(replacement.expiresAt?.toISOString()).toBe(keepUntil);
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('ACTIVE');
      // The access review shows the retained grant with its expiry and approval, and the
      // original as revoked by the termination.
      const review = await lifecycle.accessReview(
        t.employeeId,
        owner2,
        after(date),
      );
      expect(review.access!.loginStatus).toBe('ACTIVE');
      const kept = review.access!.grants.find(
        (g) => g.roleAssignmentId === row.retainedRoleAssignmentId,
      );
      expect(kept?.retention).toMatchObject({
        terminationId,
        keepUntil,
        approvalStatus: 'APPROVED',
        requestedByUserId: owner1,
        approvedByUserId: owner2,
      });
      expect(review.access!.revokedByTermination).toEqual([
        expect.objectContaining({
          roleAssignmentId: t.grants[0],
          scopeType: 'SYSTEM',
        }),
      ]);
    });
  });

  it('(8, 9) refuses a keep without a reason or beyond 30 days, and a grant outside the termination', async () => {
    await scenario(async ({ tx, fx, orgC, lifecycle, target }) => {
      const t = await target({
        grants: [
          { scope: A(fx) },
          { scope: { type: 'ORGANIZATION', organizationId: orgC } },
        ],
      });
      const date = day(5);
      const hrA = ctx(fx.users.hrA!);
      const keep = (extra: Record<string, unknown>) => ({
        roleAssignmentId: t.grants[0]!,
        decision: 'KEEP' as const,
        reason: 'Closing the quarter-end reports',
        keepUntil: after(date, 10).toISOString(),
        ...extra,
      });
      for (const decision of [
        keep({ reason: undefined }),
        keep({ reason: '   ' }),
        keep({ keepUntil: after(date, 32).toISOString() }),
        keep({ keepUntil: new Date(Date.now() - DAY).toISOString() }),
        keep({ keepUntil: 'not-a-date' }),
      ]) {
        const error = await violation(tx, () =>
          lifecycle.terminate(
            t.employeeId,
            { terminationDate: date, grantDecisions: [decision] },
            hrA,
          ),
        );
        expect(statusOf(error)).toBe(400);
        expect(codeOf(error)).toBe('TERMINATION_KEEP_INVALID');
      }
      const outside = await violation(tx, () =>
        lifecycle.terminate(
          t.employeeId,
          {
            terminationDate: date,
            grantDecisions: [keep({ roleAssignmentId: t.grants[1]! })],
          },
          hrA,
        ),
      );
      expect(codeOf(outside)).toBe('TERMINATION_KEEP_OUTSIDE_SCOPE');
      // 30 days after the last day is the limit, inclusive.
      const ok = await lifecycle.terminate(
        t.employeeId,
        {
          terminationDate: date,
          grantDecisions: [
            keep({
              keepUntil: new Date(`${day(35)}T03:00:00.000Z`).toISOString(),
            }),
          ],
        },
        hrA,
      );
      expect(ok.termination.status).toBe('SCHEDULED');
    });
  });

  it('(10, 12) revokes an unapproved keep at application, and never extends a grant that expires sooner', async () => {
    await scenario(async ({ tx, fx, lifecycle, target }) => {
      const date = day(5);
      const soon = after(date, 3);
      const t = await target({
        grants: [{ scope: A(fx) }, { scope: A(fx), expiresAt: soon }],
      });
      const hrA = ctx(fx.users.hrA!);
      const scheduled = await lifecycle.terminate(
        t.employeeId,
        {
          terminationDate: date,
          grantDecisions: t.grants.map((id) => ({
            roleAssignmentId: id,
            decision: 'KEEP' as const,
            reason: 'Supervising the transition period',
            keepUntil: after(date, 20).toISOString(),
          })),
        },
        hrA,
      );
      const terminationId = scheduled.termination.id;
      const listing = await lifecycle.terminationGrants(
        t.employeeId,
        terminationId,
        fx.users.hrA2!,
      );
      const second = listing.grants.find(
        (g) => g.roleAssignmentId === t.grants[1],
      )!;
      // Only the second keep is approved, by another administrator.
      await lifecycle.approveGrantKeep(
        t.employeeId,
        terminationId,
        second.decision!.id,
        {},
        ctx(fx.users.hrA2!),
      );
      const applied = await lifecycle.applyTermination(
        t.employeeId,
        terminationId,
        hrA,
        after(date),
      );
      expect(applied.grants).toMatchObject({ revoked: 1, retained: 1 });
      expect((await revokedState(tx, t.grants[0]!)).revokedAt).not.toBeNull();
      const decisions = await tx.employeeTerminationGrantDecision.findMany({
        where: { terminationId },
        orderBy: { createdAt: 'asc' },
      });
      const unapproved = decisions.find(
        (d) => d.roleAssignmentId === t.grants[0],
      )!;
      expect(unapproved).toMatchObject({
        status: 'REQUESTED',
        outcome: 'REVOKED',
      });
      const kept = decisions.find((d) => d.roleAssignmentId === t.grants[1])!;
      const replacement = await revokedState(
        tx,
        kept.retainedRoleAssignmentId!,
      );
      // The earlier expiry of the original grant wins over the requested one.
      expect(replacement.expiresAt?.toISOString()).toBe(soon.toISOString());
    });
  });

  it('(13, 14) revokes a grant added after scheduling, and leaves one revoked earlier as it was', async () => {
    await scenario(async ({ tx, fx, lifecycle, roles, target, grant }) => {
      const date = day(5);
      const t = await target({ grants: [{ scope: A(fx) }] });
      const hrA = ctx(fx.users.hrA!);
      const scheduled = await lifecycle.terminate(
        t.employeeId,
        { terminationDate: date },
        hrA,
      );
      const added = await grant(t.userId, A(fx));
      await roles.revokeAssignment(
        fx.users.hrA2!,
        t.grants[0]!,
        'Moved away',
        {},
      );
      const applied = await lifecycle.applyTermination(
        t.employeeId,
        scheduled.termination.id,
        hrA,
        after(date),
      );
      expect(applied.grants).toMatchObject({ revoked: 1, retained: 0 });
      expect(await revokedState(tx, added)).toMatchObject({
        revocationReason: 'employment_terminated',
      });
      expect(await revokedState(tx, t.grants[0]!)).toMatchObject({
        revokedByUserId: fx.users.hrA2,
        revocationReason: 'Moved away',
      });
    });
  });

  it('(15, 16) revokes nothing when cancelled or rescheduled; a reschedule needs the approval again', async () => {
    await scenario(async ({ tx, fx, lifecycle, target }) => {
      const date = day(5);
      const t = await target({ grants: [{ scope: A(fx) }] });
      const hrA = ctx(fx.users.hrA!);
      const keep = {
        roleAssignmentId: t.grants[0]!,
        decision: 'KEEP' as const,
        reason: 'Finishing the annual audit file',
        keepUntil: after(date, 20).toISOString(),
      };
      const first = await lifecycle.terminate(
        t.employeeId,
        { terminationDate: date, grantDecisions: [keep] },
        hrA,
      );
      const [pending] = (
        await lifecycle.terminationGrants(
          t.employeeId,
          first.termination.id,
          fx.users.hrA2!,
        )
      ).grants;
      await lifecycle.approveGrantKeep(
        t.employeeId,
        first.termination.id,
        pending!.decision!.id,
        {},
        ctx(fx.users.hrA2!),
      );
      const moved = await lifecycle.rescheduleTermination(
        t.employeeId,
        first.termination.id,
        { terminationDate: day(6) },
        hrA,
      );
      const [carried] = (
        await lifecycle.terminationGrants(
          t.employeeId,
          moved.termination.id,
          fx.users.hrA2!,
        )
      ).grants;
      expect(carried!.decision).toMatchObject({
        decision: 'KEEP',
        status: 'REQUESTED',
      });
      await lifecycle.cancelTermination(
        t.employeeId,
        moved.termination.id,
        {},
        hrA,
      );
      expect((await revokedState(tx, t.grants[0]!)).revokedAt).toBeNull();
      expect(
        await tx.employeeTerminationGrantDecision.count({
          where: { terminationId: moved.termination.id, status: 'CANCELLED' },
        }),
      ).toBe(1);
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('ACTIVE');
    });
  });

  it('(17, 18) applies through the worker with the same policy, attributed to the worker, idempotently', async () => {
    await scenario(async ({ tx, fx, workerLifecycle, lifecycle, target }) => {
      const date = day(5);
      const t = await target({ grants: [{ scope: A(fx) }] });
      const scheduled = await lifecycle.terminate(
        t.employeeId,
        { terminationDate: date },
        ctx(fx.users.hrA!),
      );
      const first = await workerLifecycle.processDueTerminations(after(date));
      expect(first.completed).toContain(scheduled.termination.id);
      expect(await revokedState(tx, t.grants[0]!)).toMatchObject({
        revokedByUserId: null,
        revocationReason: 'employment_terminated',
      });
      const [entry] = await tx.auditLog.findMany({
        where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: t.grants[0]! },
      });
      expect(entry).toMatchObject({
        actorUserId: null,
        userAgent: 'hrms-worker',
      });
      expect(entry!.metadata).toMatchObject({
        source: 'AUTOMATIC',
        terminationId: scheduled.termination.id,
        scheduledByUserId: fx.users.hrA,
      });
      const second = await workerLifecycle.processDueTerminations(
        after(date, 2),
      );
      expect(second.completed).not.toContain(scheduled.termination.id);
      expect(
        await tx.auditLog.count({
          where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: t.grants[0]! },
        }),
      ).toBe(1);
      // A manual apply afterwards is a no-op as well.
      await lifecycle.applyTermination(
        t.employeeId,
        scheduled.termination.id,
        ctx(fx.users.hrA!),
        after(date, 3),
      );
      expect(
        await tx.employeeTerminationGrantDecision.count({
          where: { terminationId: scheduled.termination.id },
        }),
      ).toBe(1);
    });
  });

  it('(19, 20) disables the login once the last retained grant expires; a rehire restores nothing', async () => {
    await scenario(async ({ tx, fx, workerLifecycle, lifecycle, target }) => {
      const date = day(1);
      const keepUntil = after(date, 4);
      const t = await target({ grants: [{ scope: A(fx) }, { scope: A(fx) }] });
      const hrA = ctx(fx.users.hrA!);
      const scheduled = await lifecycle.terminate(
        t.employeeId,
        {
          terminationDate: date,
          grantDecisions: [
            {
              roleAssignmentId: t.grants[0]!,
              decision: 'KEEP',
              reason: 'Training the replacement',
              keepUntil: keepUntil.toISOString(),
            },
          ],
        },
        hrA,
      );
      const [pending] = (
        await lifecycle.terminationGrants(
          t.employeeId,
          scheduled.termination.id,
          fx.users.hrA2!,
        )
      ).grants.filter((g) => g.decision);
      await lifecycle.approveGrantKeep(
        t.employeeId,
        scheduled.termination.id,
        pending!.decision!.id,
        {},
        ctx(fx.users.hrA2!),
      );
      await workerLifecycle.processDueTerminations(after(date));
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('ACTIVE');
      // Before the expiry nothing happens; after it, the login is disabled exactly once.
      const early = await workerLifecycle.processDueTerminations(
        after(date, 2),
      );
      expect(early.retentionsExpired).toHaveLength(0);
      const late = await workerLifecycle.processDueTerminations(
        new Date(keepUntil.getTime() + 60_000),
      );
      expect(late.retentionsExpired).toEqual([t.employeeId]);
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('DISABLED');
      const again = await workerLifecycle.processDueTerminations(
        new Date(keepUntil.getTime() + 120_000),
      );
      expect(again.retentionsExpired).toHaveLength(0);

      // Rehire: a new assignment; no grant comes back.
      const jobTitle = await tx.jobTitle.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      const rehirePosition = await tx.position.create({
        data: {
          organizationId: fx.orgA,
          jobTitleId: jobTitle.id,
          name: 'M3 rehire',
          code: `M3RH-${fx.suffix}`,
          workLocationId: fx.workLocationToronto,
        },
      });
      await lifecycle.rehire(
        t.employeeId,
        {
          assignment: {
            positionId: rehirePosition.id,
            employmentType: 'FULL_TIME',
            startDate: day(30),
          },
        },
        hrA,
      );
      expect(
        await tx.roleAssignment.count({
          where: {
            userId: t.userId,
            revokedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date(keepUntil.getTime() + 60_000) } },
            ],
          },
        }),
      ).toBe(0);
    });
  });

  it('(21) keeps payroll history: a pay statement survives the termination, an administrator still reads it, and the former employee cannot sign in to self-service (decision B)', async () => {
    await scenario(async ({ tx, fx, lifecycle, target }) => {
      const t = await target({ grants: [{ scope: A(fx) }] });
      const payGroup = await tx.payGroup.create({
        data: {
          organizationId: fx.orgA,
          code: `M3PG-${fx.suffix}`,
          name: 'PG',
        },
      });
      const calendar = await tx.payrollCalendar.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          cadence: 'BIWEEKLY',
          timezone: 'America/Toronto',
          anchorDate: new Date('2026-02-02T00:00:00.000Z'),
          payDateOffsetDays: 6,
          processingCutoffOffsetDays: 3,
          effectiveFrom: new Date('2026-02-02T00:00:00.000Z'),
        },
      });
      const timePeriod = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: new Date('2026-02-02T00:00:00.000Z'),
          endDate: new Date('2026-02-15T00:00:00.000Z'),
          status: 'OPEN',
          openedAt: new Date('2026-02-01T00:00:00.000Z'),
        },
      });
      const period = await tx.payrollPeriod.create({
        data: {
          timePeriodId: timePeriod.id,
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          payrollCalendarId: calendar.id,
          periodStart: new Date('2026-02-02T00:00:00.000Z'),
          periodEnd: new Date('2026-02-15T00:00:00.000Z'),
          payDate: new Date('2026-02-21T00:00:00.000Z'),
          processingCutoffAt: new Date('2026-02-18T22:00:00.000Z'),
          timezone: 'America/Toronto',
        },
      });
      const run = await tx.payrollRun.create({
        data: {
          organizationId: fx.orgA,
          payGroupId: payGroup.id,
          payrollPeriodId: period.id,
          currency: 'CAD',
          createdByUserId: fx.users.hrA!,
        },
      });
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: t.employeeId },
      });
      const statement = await tx.payrollRunEmployee.create({
        data: {
          payrollRunId: run.id,
          employeeId: t.employeeId,
          employeeNumber: employee.employeeNumber,
          displayName: 'M3 target',
        },
      });
      await lifecycle.terminate(
        t.employeeId,
        { terminationDate: day(-3) },
        ctx(fx.users.hrA!),
      );
      expect(
        await tx.payrollRunEmployee.findUnique({ where: { id: statement.id } }),
      ).not.toBeNull();
      expect(
        await tx.payrollRun.findUnique({ where: { id: run.id } }),
      ).not.toBeNull();
      // Decision B: an authorized payroll administrator still reads the statement (the
      // administrator-mediated delivery path) ...
      const client = rollbackClient(tx);
      const reads = new PayrollReadService(
        client,
        new PayrollAccessService(client, new AuthorizationService(client)),
        new PayrollSeparationService(client),
      );
      const detail = await reads.runEmployee(
        fx.users.hrA!,
        run.id,
        statement.id,
      );
      expect(detail).toMatchObject({
        id: statement.id,
        employeeId: t.employeeId,
      });
      // ... while the former employee's login is disabled and their session no longer
      // authenticates, so /payroll/me/pay (identity-only) is unreachable for them.
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('DISABLED');
      const session = await tx.authSession.findFirstOrThrow({
        where: { userId: t.userId },
      });
      expect(
        await new SessionsService(client).findActiveByIdAndUser(
          session.id,
          t.userId,
          new Date(),
        ),
      ).toBeNull();
    });
  });

  it('lists only the termination’s grants, with the outcome and whether the login will be disabled', async () => {
    await scenario(async ({ fx, orgC, lifecycle, target }) => {
      const t = await target({
        grants: [
          { scope: A(fx) },
          { scope: { type: 'ORGANIZATION', organizationId: orgC } },
        ],
      });
      const preview = await lifecycle.terminationPreview(
        t.employeeId,
        day(5),
        fx.users.hrA!,
      );
      expect(preview.grantChanges).toMatchObject({
        loginWillBeDisabled: false,
        otherAccessRemains: true,
        decisionsRequired: [],
      });
      expect(preview.grantChanges.grants).toHaveLength(1);
      expect(preview.grantChanges.grants[0]).toMatchObject({
        roleAssignmentId: t.grants[0],
        outcome: 'REVOKE',
      });
      expect(JSON.stringify(preview.grantChanges)).not.toContain(orgC);
      // Someone without authority over the employee cannot list or decide.
      const scheduled = await lifecycle.terminate(
        t.employeeId,
        { terminationDate: day(5) },
        ctx(fx.users.hrA!),
      );
      const refused = await rejection(
        lifecycle.terminationGrants(
          t.employeeId,
          scheduled.termination.id,
          fx.users.hrB!,
        ),
      );
      expect([403, 404]).toContain(statusOf(refused));
      const decide = await rejection(
        lifecycle.recordGrantDecisions(
          t.employeeId,
          scheduled.termination.id,
          {
            decisions: [
              {
                roleAssignmentId: t.grants[0]!,
                decision: 'KEEP',
                reason: 'Not my organization',
                keepUntil: after(day(5), 3).toISOString(),
              },
            ],
          },
          ctx(fx.users.hrB!),
        ),
      );
      expect([403, 404]).toContain(statusOf(decide));
    });
  });

  it('refuses a late approval once the termination has applied, and an expired keep', async () => {
    await scenario(async ({ tx, fx, lifecycle, target }) => {
      const date = day(1);
      const t = await target({ grants: [{ scope: A(fx) }] });
      const hrA = ctx(fx.users.hrA!);
      const scheduled = await lifecycle.terminate(
        t.employeeId,
        {
          terminationDate: date,
          grantDecisions: [
            {
              roleAssignmentId: t.grants[0]!,
              decision: 'KEEP',
              reason: 'Clearing the open approvals',
              keepUntil: after(date, 2).toISOString(),
            },
          ],
        },
        hrA,
      );
      const [pending] = (
        await lifecycle.terminationGrants(
          t.employeeId,
          scheduled.termination.id,
          fx.users.hrA2!,
        )
      ).grants;
      // Expired before approval: refused.
      const expired = await rejection(
        lifecycle.approveGrantKeep(
          t.employeeId,
          scheduled.termination.id,
          pending!.decision!.id,
          {},
          ctx(fx.users.hrA2!),
          after(date, 3),
        ),
      );
      expect(codeOf(expired)).toBe('TERMINATION_KEEP_EXPIRED');
      await lifecycle.applyTermination(
        t.employeeId,
        scheduled.termination.id,
        hrA,
        after(date),
      );
      const late = await rejection(
        lifecycle.approveGrantKeep(
          t.employeeId,
          scheduled.termination.id,
          pending!.decision!.id,
          {},
          ctx(fx.users.hrA2!),
          after(date),
        ),
      );
      expect(statusOf(late)).toBe(409);
      expect(codeOf(late)).toBe('TERMINATION_NOT_SCHEDULED');
      // The grant stays revoked; nothing was resurrected.
      expect((await revokedState(tx, t.grants[0]!)).revokedAt).not.toBeNull();
      expect(
        await tx.roleAssignment.count({
          where: { userId: t.userId, revokedAt: null },
        }),
      ).toBe(0);
    });
  });

  // ─── Decision C: approving a keep needs the ordinary role-delegation authority ──────────

  /** Terminates `employeeId` with a KEEP request (by hrA) for `grantId`; returns the ids. */
  async function requestKeep(
    h: Harness,
    employeeId: string,
    grantId: string,
    requester = h.fx.users.hrA!,
  ) {
    const date = day(5);
    const scheduled = await h.lifecycle.terminate(
      employeeId,
      {
        terminationDate: date,
        grantDecisions: [
          {
            roleAssignmentId: grantId,
            decision: 'KEEP',
            reason: 'Handover of the payroll provider integration',
            keepUntil: after(date, 10).toISOString(),
          },
        ],
      },
      ctx(requester),
    );
    const decision =
      await h.tx.employeeTerminationGrantDecision.findFirstOrThrow({
        where: { terminationId: scheduled.termination.id, decision: 'KEEP' },
      });
    return { terminationId: scheduled.termination.id, decisionId: decision.id };
  }
  const approve = (
    h: Harness,
    employeeId: string,
    keep: { terminationId: string; decisionId: string },
    approver: string,
  ) =>
    h.lifecycle.approveGrantKeep(
      employeeId,
      keep.terminationId,
      keep.decisionId,
      {},
      ctx(approver),
    );
  const statusOfDecision = async (tx: Tx, id: string) =>
    (
      await tx.employeeTerminationGrantDecision.findUniqueOrThrow({
        where: { id },
      })
    ).status;
  const refusals = (tx: Tx, employeeId: string) =>
    tx.auditLog.findMany({
      where: {
        action: 'EMPLOYEE_TERMINATION_GRANT_KEEP_REVIEW_REFUSED',
        entityId: employeeId,
      },
    });

  it('C1, C3, C12: role.assign alone cannot approve a keep; the decision is unchanged and the refusal audited; a full delegator can', async () => {
    await scenario(async (h) => {
      const { tx, fx, target } = h;
      const t = await target({ grants: [{ scope: A(fx) }] });
      const keep = await requestKeep(h, t.employeeId, t.grants[0]!);
      const refused = await rejection(
        approve(h, t.employeeId, keep, fx.users.hrAssignOnly!),
      );
      expect(statusOf(refused)).toBe(403);
      expect(codeOf(refused)).toBe('TERMINATION_KEEP_NOT_AUTHORIZED');
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('REQUESTED');
      const [audit] = await refusals(tx, t.employeeId);
      expect(audit).toMatchObject({ actorUserId: fx.users.hrAssignOnly });
      expect(audit!.metadata).toMatchObject({
        terminationId: keep.terminationId,
        decisionId: keep.decisionId,
        action: 'APPROVE',
        code: 'TERMINATION_KEEP_NOT_AUTHORIZED',
      });
      expect(JSON.stringify(audit!.metadata)).not.toContain('Handover');
      await approve(h, t.employeeId, keep, fx.users.hrA2!);
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('APPROVED');
    });
  });

  it('C2: the requester still cannot approve their own keep, even as a full delegator', async () => {
    await scenario(async (h) => {
      const t = await h.target({ grants: [{ scope: A(h.fx) }] });
      const keep = await requestKeep(h, t.employeeId, t.grants[0]!);
      const refused = await rejection(
        approve(h, t.employeeId, keep, h.fx.users.hrA!),
      );
      expect(codeOf(refused)).toBe('TERMINATION_KEEP_SELF_APPROVAL');
      expect(await statusOfDecision(h.tx, keep.decisionId)).toBe('REQUESTED');
    });
  });

  it('C4: every permission but too narrow a scope is refused; the same approver may approve a grant within their scope (team, department)', async () => {
    await scenario(async (h) => {
      const { tx, fx, target } = h;
      // An organization-wide grant: a team-scoped delegator cannot keep it.
      const orgWide = await target({ grants: [{ scope: A(fx) }] });
      const orgKeep = await requestKeep(
        h,
        orgWide.employeeId,
        orgWide.grants[0]!,
      );
      expect(
        codeOf(
          await rejection(
            approve(h, orgWide.employeeId, orgKeep, fx.users.hrTeam!),
          ),
        ),
      ).toBe('TERMINATION_KEEP_NOT_AUTHORIZED');
      expect(await statusOfDecision(tx, orgKeep.decisionId)).toBe('REQUESTED');
      // A team-scoped grant inside the approver's team: allowed.
      const teamScoped = await target({
        grants: [
          {
            scope: { type: 'TEAM', organizationId: fx.orgA, id: fx.teamA },
          },
        ],
      });
      const teamKeep = await requestKeep(
        h,
        teamScoped.employeeId,
        teamScoped.grants[0]!,
      );
      await approve(h, teamScoped.employeeId, teamKeep, fx.users.hrTeam!);
      expect(await statusOfDecision(tx, teamKeep.decisionId)).toBe('APPROVED');
      // A department-wide grant (the team's department) is wider than the approver's team: refused.
      const deptScoped = await target({
        grants: [
          {
            scope: {
              type: 'DEPARTMENT',
              organizationId: fx.orgA,
              id: fx.deptA,
            },
          },
        ],
      });
      const deptKeep = await requestKeep(
        h,
        deptScoped.employeeId,
        deptScoped.grants[0]!,
      );
      expect(
        codeOf(
          await rejection(
            approve(h, deptScoped.employeeId, deptKeep, fx.users.hrTeam!),
          ),
        ),
      ).toBe('TERMINATION_KEEP_NOT_AUTHORIZED');
    });
  });

  it('C4b: a unit-scoped grant: a team-scoped delegator is refused, an organization-wide delegator may approve', async () => {
    await scenario(async (h) => {
      const { tx, fx, target } = h;
      const t = await target({
        grants: [
          {
            scope: {
              type: 'ORGANIZATIONAL_UNIT',
              organizationId: fx.orgA,
              id: fx.unitChild,
            },
          },
        ],
      });
      const keep = await requestKeep(h, t.employeeId, t.grants[0]!);
      expect(
        codeOf(
          await rejection(approve(h, t.employeeId, keep, fx.users.hrTeam!)),
        ),
      ).toBe('TERMINATION_KEEP_NOT_AUTHORIZED');
      await approve(h, t.employeeId, keep, fx.users.hrA2!);
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('APPROVED');
    });
  });

  it('C5, C6: an organization administrator cannot approve a SYSTEM keep; another System Owner can', async () => {
    await scenario(async (h) => {
      const { tx, fx, target, owner1, owner2 } = h;
      const t = await target({ grants: [{ scope: { type: 'SYSTEM' } }] });
      const keep = await requestKeep(h, t.employeeId, t.grants[0]!, owner1);
      const refused = await rejection(
        approve(h, t.employeeId, keep, fx.users.hrA2!),
      );
      expect(statusOf(refused)).toBe(403);
      expect(codeOf(refused)).toBe('TERMINATION_SYSTEM_ACTOR_REQUIRED');
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('REQUESTED');
      await approve(h, t.employeeId, keep, owner2);
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('APPROVED');
    });
  });

  it('C7, C8: an archived role, or a grant revoked since the request, cannot be kept', async () => {
    await scenario(async (h) => {
      const { tx, fx, target } = h;
      const archived = await target({ grants: [{ scope: A(fx) }] });
      const keepArchived = await requestKeep(
        h,
        archived.employeeId,
        archived.grants[0]!,
      );
      const grant = await tx.roleAssignment.findUniqueOrThrow({
        where: { id: archived.grants[0]! },
      });
      await tx.role.update({
        where: { id: grant.roleId },
        data: { archivedAt: new Date() },
      });
      const refusedArchived = await rejection(
        approve(h, archived.employeeId, keepArchived, fx.users.hrA2!),
      );
      expect(statusOf(refusedArchived)).toBe(409);
      expect(codeOf(refusedArchived)).toBe('TERMINATION_KEEP_INVALID');
      expect(await statusOfDecision(tx, keepArchived.decisionId)).toBe(
        'REQUESTED',
      );

      const revoked = await target({ grants: [{ scope: A(fx) }] });
      const keepRevoked = await requestKeep(
        h,
        revoked.employeeId,
        revoked.grants[0]!,
      );
      await tx.roleAssignment.update({
        where: { id: revoked.grants[0]! },
        data: { revokedAt: new Date() },
      });
      const refusedRevoked = await rejection(
        approve(h, revoked.employeeId, keepRevoked, fx.users.hrA2!),
      );
      expect(codeOf(refusedRevoked)).toBe('TERMINATION_KEEP_INVALID');
    });
  });

  it('C9: a custom role needs every one of its permissions to be delegable by the approver', async () => {
    await scenario(async (h) => {
      const { tx, fx, target } = h;
      const t = await target({
        grants: [
          { scope: A(fx), permissions: ['time.clock', 'payroll.calculate'] },
        ],
      });
      const keep = await requestKeep(h, t.employeeId, t.grants[0]!);
      expect(
        codeOf(
          await rejection(
            approve(h, t.employeeId, keep, fx.users.hrClockOnly!),
          ),
        ),
      ).toBe('TERMINATION_KEEP_NOT_AUTHORIZED');
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('REQUESTED');
      await approve(h, t.employeeId, keep, fx.users.hrA2!);
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('APPROVED');
    });
  });

  it('C10: authority is checked when the approval runs: an approver who lost a permission since is refused', async () => {
    await scenario(async (h) => {
      const { tx, fx, target } = h;
      const t = await target({ grants: [{ scope: A(fx) }] });
      const keep = await requestKeep(h, t.employeeId, t.grants[0]!);
      // hrA2's own role loses time.clock (the kept role's permission) before they approve.
      const approverGrant = await tx.roleAssignment.findFirstOrThrow({
        where: { userId: fx.users.hrA2!, revokedAt: null },
      });
      await tx.rolePermission.deleteMany({
        where: {
          roleId: approverGrant.roleId,
          permission: { key: 'time.clock' },
        },
      });
      expect(
        codeOf(await rejection(approve(h, t.employeeId, keep, fx.users.hrA2!))),
      ).toBe('TERMINATION_KEEP_NOT_AUTHORIZED');
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('REQUESTED');
    });
  });

  // ─── Final M3 change: KEEP approvals revalidated when the termination applies ─────────────

  const APPROVER = [...ADMIN, ...ROLE_KEYS];
  /** An approver of their own (an employee of A), the target, and an approved KEEP. */
  async function approvedKeep(
    h: Harness,
    options: {
      approverGrants?: Array<{
        scope: Scope;
        permissions?: string[];
        expiresAt?: Date;
      }>;
      keptPermissions?: string[];
      targetExtra?: Array<{ scope: Scope; permissions?: string[] }>;
    } = {},
  ) {
    const approver = await h.target({
      grants: options.approverGrants ?? [
        { scope: A(h.fx), permissions: APPROVER },
      ],
    });
    const t = await h.target({
      grants: [
        {
          scope: A(h.fx),
          permissions: options.keptPermissions ?? ['time.clock'],
        },
        ...(options.targetExtra ?? []),
      ],
    });
    const keep = await requestKeep(h, t.employeeId, t.grants[0]!);
    await approve(h, t.employeeId, keep, approver.userId);
    expect(await statusOfDecision(h.tx, keep.decisionId)).toBe('APPROVED');
    return { approver, t, keep, date: day(5) };
  }
  const applyAt = (
    h: Harness,
    t: { employeeId: string },
    keep: { terminationId: string },
    date: string,
  ) =>
    h.lifecycle.applyTermination(
      t.employeeId,
      keep.terminationId,
      ctx(h.fx.users.hrA!),
      after(date),
    );
  const revalidationAudits = (tx: Tx, employeeId: string) =>
    tx.auditLog.findMany({
      where: {
        action: 'EMPLOYEE_TERMINATION_GRANT_KEEP_REVALIDATION_FAILED',
        entityId: employeeId,
      },
    });
  /** The ordinary grant was revoked, not retained, and the failed revalidation recorded. */
  async function expectKeepInvalidated(
    tx: Tx,
    t: { employeeId: string; userId: string; grants: string[] },
    keep: { decisionId: string; terminationId: string },
    reason: string,
  ) {
    const decision =
      await tx.employeeTerminationGrantDecision.findUniqueOrThrow({
        where: { id: keep.decisionId },
      });
    expect(decision).toMatchObject({
      status: 'APPROVED',
      outcome: 'REVOKED',
      retainedRoleAssignmentId: null,
    });
    expect((await revokedState(tx, t.grants[0]!)).revokedAt).not.toBeNull();
    expect(
      await tx.roleAssignment.count({
        where: {
          userId: t.userId,
          revokedAt: null,
          roleId: (await revokedState(tx, t.grants[0]!)).roleId,
        },
      }),
    ).toBe(0);
    const audits = await revalidationAudits(tx, t.employeeId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      terminationId: keep.terminationId,
      decisionId: keep.decisionId,
      roleAssignmentId: t.grants[0],
      reason,
      system: false,
    });
    // Safe metadata: no role or organization names, no reasons.
    const text = JSON.stringify(audits[0]!.metadata);
    expect(text).not.toContain('Handover');
    expect(text).not.toContain('M3 role');
  }

  it('R1, R12: a valid approval still retains the grant, also after unrelated authorization changes', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { approver, t, keep, date } = await approvedKeep(h, {
        approverGrants: [
          { scope: A(fx), permissions: APPROVER },
          {
            scope: { type: 'ORGANIZATION', organizationId: fx.orgB },
            permissions: ['time.clock'],
          },
        ],
      });
      // Unrelated: the approver loses a grant in B.
      await tx.roleAssignment.update({
        where: { id: approver.grants[1]! },
        data: { revokedAt: new Date() },
      });
      const applied = await applyAt(h, t, keep, date);
      expect(applied.grants).toMatchObject({ retained: 1, revoked: 0 });
      expect(await revalidationAudits(tx, t.employeeId)).toHaveLength(0);
    });
  });

  it('R2, R7, R17: an ordinary keep is revoked at application once the approver lost their delegation authority; other organizations untouched', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { approver, t, keep, date } = await approvedKeep(h, {
        targetExtra: [
          { scope: { type: 'ORGANIZATION', organizationId: fx.orgB } },
        ],
      });
      await tx.roleAssignment.update({
        where: { id: approver.grants[0]! },
        data: { revokedAt: new Date() },
      });
      const applied = await applyAt(h, t, keep, date);
      expect(applied.termination.status).toBe('APPLIED');
      expect(applied.grants).toMatchObject({ retained: 0, revoked: 1 });
      await expectKeepInvalidated(tx, t, keep, 'APPROVER_NOT_AUTHORIZED');
      // The grant in B (outside the termination) is untouched and keeps the login.
      expect((await revokedState(tx, t.grants[1]!)).revokedAt).toBeNull();
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('ACTIVE');
    });
  });

  it('R3: an ordinary keep is revoked when the role gained a permission the approver cannot delegate', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { t, keep, date } = await approvedKeep(h, {
        approverGrants: [
          { scope: A(fx), permissions: [...ADMIN, 'time.clock'] },
        ],
      });
      const grant = await revokedState(tx, t.grants[0]!);
      await tx.rolePermission.create({
        data: {
          roleId: grant.roleId,
          permissionId: await permissionIdOf(tx, 'payroll.calculate'),
        },
      });
      await applyAt(h, t, keep, date);
      await expectKeepInvalidated(tx, t, keep, 'APPROVER_NOT_AUTHORIZED');
    });
  });

  it('R4: an ordinary keep is revoked when the approver’s authority shrank to a narrower scope', async () => {
    await scenario(async (h) => {
      const { tx, fx, grant } = h;
      const { approver, t, keep, date } = await approvedKeep(h);
      await tx.roleAssignment.update({
        where: { id: approver.grants[0]! },
        data: { revokedAt: new Date() },
      });
      await grant(
        approver.userId,
        { type: 'TEAM', organizationId: fx.orgA, id: fx.teamA },
        APPROVER,
      );
      await applyAt(h, t, keep, date);
      await expectKeepInvalidated(tx, t, keep, 'APPROVER_NOT_AUTHORIZED');
    });
  });

  it('R5: an ordinary keep is revoked when the approver’s authority expired before the application', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { t, keep, date } = await approvedKeep(h, {
        approverGrants: [
          {
            scope: A(fx),
            permissions: APPROVER,
            // Valid when approving now; expired when the termination applies.
            expiresAt: after(day(2)),
          },
        ],
      });
      await applyAt(h, t, keep, date);
      await expectKeepInvalidated(tx, t, keep, 'APPROVER_NOT_AUTHORIZED');
    });
  });

  it('R6: an ordinary keep is revoked when the role was archived since the approval', async () => {
    await scenario(async (h) => {
      const { tx } = h;
      const { t, keep, date } = await approvedKeep(h);
      const grant = await revokedState(tx, t.grants[0]!);
      await tx.role.update({
        where: { id: grant.roleId },
        data: { archivedAt: new Date() },
      });
      await applyAt(h, t, keep, date);
      await expectKeepInvalidated(tx, t, keep, 'ROLE_INELIGIBLE');
    });
  });

  it('R13: a role that lost permissions is checked against what it grants now', async () => {
    await scenario(async (h) => {
      const { tx } = h;
      const { approver, t, keep, date } = await approvedKeep(h, {
        keptPermissions: ['time.clock', 'payroll.calculate'],
      });
      // The role no longer grants payroll.calculate, and the approver no longer holds it:
      // the approver can still grant the role as it is now, so the keep stands.
      const grant = await revokedState(tx, t.grants[0]!);
      await tx.rolePermission.deleteMany({
        where: {
          roleId: grant.roleId,
          permission: { key: 'payroll.calculate' },
        },
      });
      const approverGrant = await revokedState(tx, approver.grants[0]!);
      await tx.rolePermission.deleteMany({
        where: {
          roleId: approverGrant.roleId,
          permission: { key: 'payroll.calculate' },
        },
      });
      const applied = await applyAt(h, t, keep, date);
      expect(applied.grants).toMatchObject({ retained: 1 });
      expect(await revalidationAudits(tx, t.employeeId)).toHaveLength(0);
    });
  });

  it('R15: a keep beyond the 30-day maximum (altered after approval) is not honoured', async () => {
    await scenario(async (h) => {
      const { tx } = h;
      const { t, keep, date } = await approvedKeep(h);
      await tx.employeeTerminationGrantDecision.update({
        where: { id: keep.decisionId },
        data: { keepUntil: after(date, 45) },
      });
      await applyAt(h, t, keep, date);
      await expectKeepInvalidated(tx, t, keep, 'KEEP_LIMIT_EXCEEDED');
    });
  });

  it('R11, R14: the requester can never be the approver (database check), and a rejected keep is not revived', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { t, keep } = await approvedKeep(h);
      const decision =
        await tx.employeeTerminationGrantDecision.findUniqueOrThrow({
          where: { id: keep.decisionId },
        });
      await violation(tx, () =>
        tx.employeeTerminationGrantDecision.update({
          where: { id: keep.decisionId },
          data: { reviewedByUserId: decision.requestedByUserId },
        }),
      );
      // A rejected keep: revoked at application, with no revalidation involved.
      const other = await h.target({ grants: [{ scope: A(fx) }] });
      const otherKeep = await requestKeep(
        h,
        other.employeeId,
        other.grants[0]!,
      );
      await h.lifecycle.rejectGrantKeep(
        other.employeeId,
        otherKeep.terminationId,
        otherKeep.decisionId,
        {},
        ctx(fx.users.hrA2!),
      );
      const applied = await applyAt(h, other, otherKeep, day(5));
      expect(applied.grants).toMatchObject({ retained: 0, revoked: 1 });
      expect(await statusOfDecision(tx, otherKeep.decisionId)).toBe('REJECTED');
      expect(await revalidationAudits(tx, other.employeeId)).toHaveLength(0);
      void t;
    });
  });

  it('R8, R9, R10, R16: an invalid SYSTEM keep blocks the application atomically; a fresh valid approval lets it apply; a rehire restores nothing', async () => {
    await scenario(async (h) => {
      const { tx, fx, owner1, owner2, target } = h;
      const t = await target({ grants: [{ scope: { type: 'SYSTEM' } }] });
      const keep = await requestKeep(h, t.employeeId, t.grants[0]!, owner1);
      await approve(h, t.employeeId, keep, owner2);
      // owner2 loses System authority.
      const ownerGrant = await tx.roleAssignment.findFirstOrThrow({
        where: { userId: owner2, revokedAt: null, scopeType: 'SYSTEM' },
      });
      await tx.roleAssignment.update({
        where: { id: ownerGrant.id },
        data: { revokedAt: new Date() },
      });
      const before = await tx.employmentAssignment.findMany({
        where: { employeeId: t.employeeId },
        select: { id: true, status: true, endDate: true },
        orderBy: { id: 'asc' },
      });
      const blocked = await rejection(applyAt(h, t, keep, day(5)));
      expect(statusOf(blocked)).toBe(409);
      expect(codeOf(blocked)).toBe('TERMINATION_KEEP_APPROVAL_INVALID');
      // Nothing changed.
      expect(
        await tx.employmentAssignment.findMany({
          where: { employeeId: t.employeeId },
          select: { id: true, status: true, endDate: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
      expect((await revokedState(tx, t.grants[0]!)).revokedAt).toBeNull();
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: t.userId } })).status,
      ).toBe('ACTIVE');
      expect(
        (
          await tx.employeeTermination.findUniqueOrThrow({
            where: { id: keep.terminationId },
          })
        ).status,
      ).toBe('SCHEDULED');
      // The listing and the termination result say why.
      const listing = await h.lifecycle.terminationGrants(
        t.employeeId,
        keep.terminationId,
        owner1,
      );
      expect(listing.blocking).toEqual([
        {
          roleAssignmentId: t.grants[0],
          code: 'TERMINATION_KEEP_APPROVAL_INVALID',
        },
      ]);
      expect(listing.grants[0]).toMatchObject({ outcome: 'KEEP_INVALID' });

      // A fresh request, approved by an eligible System administrator, lets it apply.
      const owner3 = (await target({ grants: [{ scope: { type: 'SYSTEM' } }] }))
        .userId;
      await h.lifecycle.recordGrantDecisions(
        t.employeeId,
        keep.terminationId,
        {
          decisions: [
            {
              roleAssignmentId: t.grants[0]!,
              decision: 'KEEP',
              reason: 'Handover of the payroll provider integration',
              keepUntil: after(day(5), 10).toISOString(),
            },
          ],
        },
        ctx(owner1),
      );
      expect(await statusOfDecision(tx, keep.decisionId)).toBe('REQUESTED');
      await approve(h, t.employeeId, keep, owner3);
      const applied = await applyAt(h, t, keep, day(5));
      expect(applied.grants).toMatchObject({ retained: 1 });

      // A rehire brings no revoked grant back.
      const jobTitle = await tx.jobTitle.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      const position = await tx.position.create({
        data: {
          organizationId: fx.orgA,
          jobTitleId: jobTitle.id,
          name: 'M3 final rehire',
          code: `M3FR-${fx.suffix}`,
          workLocationId: fx.workLocationToronto,
        },
      });
      const retained =
        await tx.employeeTerminationGrantDecision.findUniqueOrThrow({
          where: { id: keep.decisionId },
        });
      await tx.roleAssignment.update({
        where: { id: retained.retainedRoleAssignmentId! },
        data: { revokedAt: new Date() },
      });
      await h.lifecycle.rehire(
        t.employeeId,
        {
          assignment: {
            positionId: position.id,
            employmentType: 'FULL_TIME',
            startDate: day(30),
          },
        },
        ctx(fx.users.hrA!),
      );
      expect(
        await tx.roleAssignment.count({
          where: { userId: t.userId, revokedAt: null },
        }),
      ).toBe(0);
    });
  });

  it('R18 (review L2, L1): an approver who is the terminated employee is not accepted at application, and the listing afterwards says why the keep was not honoured', async () => {
    await scenario(async (h) => {
      const { tx } = h;
      const { t, keep, date } = await approvedKeep(h);
      // Only the requester is excluded by the database check; an approval recorded for the
      // terminated person themselves (e.g. a System administrator's own record) must not count.
      await tx.employeeTerminationGrantDecision.update({
        where: { id: keep.decisionId },
        data: { reviewedByUserId: t.userId },
      });
      await applyAt(h, t, keep, date);
      await expectKeepInvalidated(tx, t, keep, 'SELF_APPROVAL');
      const listing = await h.lifecycle.terminationGrants(
        t.employeeId,
        keep.terminationId,
        h.fx.users.hrA!,
      );
      expect(listing.grants[0]).toMatchObject({ outcome: 'REVOKED' });
      expect(listing.grants[0]!.decision).toMatchObject({
        revalidationFailure: 'SELF_APPROVAL',
      });
    });
  });
});
