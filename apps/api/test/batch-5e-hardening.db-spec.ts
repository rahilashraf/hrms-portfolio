import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import {
  acceptedOffer,
  FixedRecruitmentClock,
  RECRUITMENT_USERS,
  recruitmentServices,
  vacantPosition,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const GRANTS_FROM = new Date('2026-01-01T00:00:00.000Z');
const MANAGE = ['employee.manage', 'employee.read'];
const ROLES = ['role.read', 'role.assign'];
const USERS: Record<string, UserSpec[]> = {
  hr: [{ permissions: [...MANAGE, ...ROLES], scope: 'org' }],
  // Employee 2's own login, an HR administrator of Organization A (manages roles too).
  self2: [{ permissions: [...MANAGE, ...ROLES, 'time.clock'], scope: 'org' }],
};

const statusOf = (error: unknown) => (error as HttpException).getStatus?.();
const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;

function lifecycleServices(client: PrismaService) {
  const authorization = new AuthorizationService(client);
  const audit = new AuditService(client);
  const access = new EmployeeAccessService(
    client,
    authorization,
    new PositionAuthorizationTargetResolver(client),
    audit,
  );
  const roles = new RoleManagementService(client, authorization, audit);
  const lifecycle = new EmployeeLifecycleService(
    client,
    new EmployeeDomainService(client, audit),
    access,
    authorization,
    audit,
    roles,
  );
  return { lifecycle, roles };
}

/** A role with `keys` granted to `userId`: organization-scoped, or SYSTEM with `system`. */
async function grant(
  tx: Tx,
  userId: string,
  organizationId: string | null,
  keys: string[],
  code: string,
) {
  // SYSTEM scope: the System Owner singleton role (the only organization-less role).
  const role = organizationId
    ? await tx.role.create({ data: { organizationId, code, name: code } })
    : ((await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
      (await tx.role.create({
        data: {
          organizationId: null,
          code: 'SYSTEM_OWNER',
          name: 'System Owner',
          isSystemOwner: true,
        },
      })));
  for (const key of keys) {
    const permission = await tx.permission.upsert({
      where: { key },
      create: { key, name: key, isActive: true },
      update: {},
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      create: { roleId: role.id, permissionId: permission.id },
      update: {},
    });
  }
  return tx.roleAssignment.create({
    data: organizationId
      ? {
          userId,
          roleId: role.id,
          roleOrganizationId: organizationId,
          scopeType: 'ORGANIZATION',
          organizationId,
          startsAt: GRANTS_FROM,
        }
      : { userId, roleId: role.id, scopeType: 'SYSTEM', startsAt: GRANTS_FROM },
  });
}

/**
 * Batch 5E — security and lifecycle hardening (database, rolled back). Self-revocation follows the
 * lifecycle self-target rule (E-2); already-revoked grants are reported apart (E-4); recruitment's
 * duplicate-person check never reveals another organization's employees (E-5); the access review
 * marks grants that authorize nothing because their organization or role is archived (E-6).
 * Atomicity and races of revocation are in `batch-5e-revocation-concurrency.db-spec.ts`.
 */
describe('Batch 5E hardening (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    users: Record<string, UserSpec[]>,
    run: (h: {
      tx: Tx;
      fx: SchedulingFixtures;
      client: PrismaService;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, users, [], {
            grantsStartAt: GRANTS_FROM,
          });
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

  const revocationAudits = (tx: Tx, ids: string[]) =>
    tx.auditLog.count({
      where: { action: 'ROLE_ASSIGNMENT_REVOKED', entityId: { in: ids } },
    });
  const live = async (tx: Tx, ids: string[]) =>
    (
      await tx.roleAssignment.findMany({
        where: { id: { in: ids }, revokedAt: null },
      })
    ).length;

  it('E-2: revoking grants on one’s own employment is refused, including the grant that gives role.assign; a System employee.manage holder may, audited', async () => {
    await scenario(USERS, async ({ tx, fx, client }) => {
      const { lifecycle } = lifecycleServices(client);
      const self = fx.selfUser2;
      const own = await tx.roleAssignment.findMany({
        where: { userId: self, revokedAt: null },
      });
      expect(own).toHaveLength(1); // the role that also gives role.assign
      const extra = await grant(
        tx,
        self,
        fx.orgA,
        ['time.clock'],
        `5E-X-${fx.suffix}`,
      );
      const ids = [own[0]!.id, extra.id];

      const refused = await violation(tx, () =>
        lifecycle.revokeGrants(
          fx.employee2,
          { roleAssignmentIds: ids },
          ctx(self),
        ),
      );
      expect(statusOf(refused)).toBe(403);
      expect(codeOf(refused)).toBe('LIFECYCLE_SELF_TARGET');
      expect(await live(tx, ids)).toBe(2);
      expect(await revocationAudits(tx, ids)).toBe(0);
      // One grant at a time is refused just the same.
      const single = await violation(tx, () =>
        lifecycle.revokeGrants(
          fx.employee2,
          { roleAssignmentIds: [extra.id] },
          ctx(self),
        ),
      );
      expect(codeOf(single)).toBe('LIFECYCLE_SELF_TARGET');
      expect(await live(tx, ids)).toBe(2);

      // Another administrator may revoke them.
      const byHr = await lifecycle.revokeGrants(
        fx.employee2,
        { roleAssignmentIds: [extra.id] },
        ctx(fx.users.hr!),
      );
      expect(byHr.revoked).toEqual([extra.id]);

      // With System employee.manage (and role.assign), one's own grants: allowed and audited.
      await grant(tx, self, null, [...MANAGE, ...ROLES], `5E-SYS-${fx.suffix}`);
      const overridden = await lifecycle.revokeGrants(
        fx.employee2,
        { roleAssignmentIds: [own[0]!.id] },
        ctx(self),
      );
      expect(overridden.revoked).toEqual([own[0]!.id]);
      expect(
        await tx.auditLog.count({
          where: {
            action: 'LIFECYCLE_SELF_TARGET_OVERRIDE',
            entityId: fx.employee2,
            actorUserId: self,
          },
        }),
      ).toBe(1);
    });
  });

  it('E-4: grants already revoked are reported apart and never audited again', async () => {
    await scenario(USERS, async ({ tx, fx, client }) => {
      const { lifecycle } = lifecycleServices(client);
      const hr = ctx(fx.users.hr!);
      const a = await grant(
        tx,
        fx.selfUser2,
        fx.orgA,
        ['time.clock'],
        `5E-A-${fx.suffix}`,
      );
      const b = await grant(
        tx,
        fx.selfUser2,
        fx.orgA,
        ['time.clock'],
        `5E-B-${fx.suffix}`,
      );
      const first = await lifecycle.revokeGrants(
        fx.employee2,
        { roleAssignmentIds: [a.id] },
        hr,
      );
      expect(first).toMatchObject({ revoked: [a.id], alreadyRevoked: [] });
      const second = await lifecycle.revokeGrants(
        fx.employee2,
        { roleAssignmentIds: [a.id, b.id] },
        hr,
      );
      expect(second).toMatchObject({ revoked: [b.id], alreadyRevoked: [a.id] });
      expect(await revocationAudits(tx, [a.id])).toBe(1);
      expect(await revocationAudits(tx, [b.id])).toBe(1);
      // The first revoker is kept.
      expect(
        (await tx.roleAssignment.findUniqueOrThrow({ where: { id: a.id } }))
          .revokedByUserId,
      ).toBe(fx.users.hr);
      // An already-revoked grant the caller could not revoke is still refused (no oracle).
      const foreign = await grant(
        tx,
        fx.selfUser2,
        fx.orgB,
        ['time.clock'],
        `5E-F-${fx.suffix}`,
      );
      await tx.roleAssignment.update({
        where: { id: foreign.id },
        data: { revokedAt: new Date() },
      });
      const hidden = await rejection(
        lifecycle.revokeGrants(
          fx.employee2,
          { roleAssignmentIds: [foreign.id] },
          hr,
        ),
      );
      expect(statusOf(hidden)).toBe(404);
    });
  });

  it('E-6: the access review marks a grant whose role is archived; live grants are not marked', async () => {
    await scenario(USERS, async ({ tx, fx, client }) => {
      const { lifecycle } = lifecycleServices(client);
      const liveGrant = await grant(
        tx,
        fx.selfUser2,
        fx.orgA,
        ['time.clock'],
        `5E-L-${fx.suffix}`,
      );
      const roleArchived = await grant(
        tx,
        fx.selfUser2,
        fx.orgA,
        ['time.clock'],
        `5E-R-${fx.suffix}`,
      );
      await tx.role.update({
        where: { id: roleArchived.roleId },
        data: { archivedAt: new Date() },
      });
      const review = await lifecycle.accessReview(fx.employee2, fx.users.hr!);
      const byId = new Map(
        (review.access?.grants ?? []).map((g) => [g.roleAssignmentId, g]),
      );
      expect(byId.get(liveGrant.id)?.inactiveReason).toBeNull();
      expect(byId.get(roleArchived.id)?.inactiveReason).toBe('ROLE_ARCHIVED');
    });
  });

  it('E-6: a System reviewer sees the archived-organization grant marked inactive', async () => {
    await scenario(USERS, async ({ tx, fx, client }) => {
      const { lifecycle } = lifecycleServices(client);
      const reviewer = fx.users.hr!;
      await grant(
        tx,
        reviewer,
        null,
        ['employee.read', 'role.read'],
        `5E-SR-${fx.suffix}`,
      );
      const orgArchived = await grant(
        tx,
        fx.selfUser2,
        fx.orgB,
        ['time.clock'],
        `5E-O2-${fx.suffix}`,
      );
      await tx.organization.update({
        where: { id: fx.orgB },
        data: { archivedAt: new Date() },
      });
      const review = await lifecycle.accessReview(fx.employee2, reviewer);
      const entry = (review.access?.grants ?? []).find(
        (g) => g.roleAssignmentId === orgArchived.id,
      );
      expect(entry?.inactiveReason).toBe('ORGANIZATION_ARCHIVED');
    });
  });

  it('E-5: hire conversion never reveals that another organization employs someone with the candidate’s email; matches in the hiring organization still need a choice', async () => {
    await scenario(RECRUITMENT_USERS, async ({ tx, fx, client }) => {
      const svc = recruitmentServices(client, new FixedRecruitmentClock());
      const admin = ctx(fx.users.hiringAdmin!);
      // An employee of Organization B only, invisible to Organization A's hiring administrator.
      const jobTitleB = await tx.jobTitle.create({
        data: {
          organizationId: fx.orgB,
          name: '5E B',
          code: `5E-JB-${fx.suffix}`,
        },
      });
      const positionB = await tx.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: jobTitleB.id,
          name: '5E B',
          code: `5E-PB-${fx.suffix}`,
        },
      });
      const hiddenEmail = `hidden-${fx.suffix.toLowerCase()}@example.com`;
      const personB = await tx.person.create({
        data: {
          firstName: 'Hidden',
          lastName: 'Elsewhere',
          personalEmail: hiddenEmail,
        },
      });
      const employeeB = await tx.employee.create({
        data: {
          personId: personB.id,
          employeeNumber: `5E-B-${fx.suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: employeeB.id,
          positionId: positionB.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const position = await vacantPosition(tx, fx);
      const hidden = await acceptedOffer(svc, fx, {
        positionId: position,
        candidate: { email: hiddenEmail, firstName: 'Hidden' },
      });
      // Nothing observable: no conflict, a separate person in Organization A.
      const converted = await svc.hires.convert(
        hidden.applicationId,
        {},
        admin,
      );
      expect(converted).toMatchObject({ createdEmployee: true });
      expect(converted.employeeId).not.toBe(employeeB.id);

      // In the hiring organization a match still needs an explicit choice (and is listed).
      const known = await tx.user.findUniqueOrThrow({
        where: { id: fx.selfUser1 },
      });
      const position2 = await vacantPosition(tx, fx);
      const inOrg = await acceptedOffer(svc, fx, {
        positionId: position2,
        openingOverrides: { code: `REQ-5E-${fx.suffix}` },
        candidate: { email: known.email, firstName: 'Employee1' },
      });
      const conflict = await violation(tx, () =>
        svc.hires.convert(inOrg.applicationId, {}, admin),
      );
      expect(codeOf(conflict)).toBe('RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE');
      expect(
        (
          (conflict as HttpException).getResponse() as {
            matches?: Array<{ employeeId: string }>;
          }
        ).matches?.map((m) => m.employeeId),
      ).toEqual([fx.employee1]);
    });
  });
});
