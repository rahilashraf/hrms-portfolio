import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  PERMISSION_CATALOG,
  SYSTEM_OWNER_ROLE_CODE,
  SYSTEM_OWNER_ROLE_NAME,
} from './authorization-catalog.js';
import {
  activeRolePermissionKeys,
  AuthorizationService,
} from './authorization.service.js';
import { permissionMetadata } from './permission-metadata.js';
import { ROLE_TEMPLATES } from './role-templates.js';
import type {
  RequestAuditContext,
  RoleAssignmentRow,
  RoleRow,
  ScopeRef,
} from './authorization.types.js';

export interface RoleInput {
  code: string;
  name: string;
  description?: string | null;
  permissionKeys: string[];
}

export interface RoleUpdateInput {
  name?: string;
  description?: string | null;
}

export interface CreateAssignmentInput {
  userId: string;
  roleId: string;
  scope: ScopeRef;
  startsAt?: Date;
  expiresAt?: Date | null;
}

@Injectable()
export class RoleManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async listRoles(
    actorUserId: string,
    organizationId: string,
    includeArchived = false,
  ) {
    await this.assertActiveOrganization(organizationId);
    await this.authorization.assertCan(actorUserId, 'role.read', {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    return this.prisma.role.findMany({
      where: {
        organizationId,
        isSystemOwner: false,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        permissions: { include: { permission: true } },
      },
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getRole(actorUserId: string, roleId: string) {
    const role = await this.requireRole(roleId);
    if (role.isSystemOwner || !role.organizationId) {
      throw new NotFoundException('Role not found');
    }
    await this.assertOnEntity(
      actorUserId,
      'role.read',
      { type: 'ORGANIZATION', id: role.organizationId },
      'Role not found',
    );
    return this.prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: true } } },
    });
  }

  async listPermissions(actorUserId: string, organizationId: string) {
    await this.assertActiveOrganization(organizationId);
    await this.authorization.assertCan(actorUserId, 'role.read', {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const rows = await this.prisma.permission.findMany({
      where: { isActive: true },
      orderBy: { key: 'asc' },
    });
    // Phase 20: additive presentation fields (area, label) for grouping in the role editor.
    return rows.map((row) => ({ ...row, ...permissionMetadata(row.key) }));
  }

  /**
   * Phase 20 — the role templates (presets of permission keys). Readable by whoever may view
   * or manage roles: role.read or role.manage in the organization when one is given, otherwise
   * at any organization (or SYSTEM). With an organization, each template also lists the keys
   * the caller does not hold there (and so could not delegate into a role).
   */
  async listRoleTemplates(actorUserId: string, organizationId?: string) {
    const keys = ['role.read', 'role.manage'];
    let held: Set<string> | null = null;
    if (organizationId) {
      await this.assertActiveOrganization(organizationId);
      held = new Set(
        await this.authorization.effectivePermissionKeys(actorUserId, {
          type: 'ORGANIZATION',
          id: organizationId,
        }),
      );
      if (!keys.some((key) => held!.has(key)))
        throw new ForbiddenException(
          'Missing permission role.read for the requested scope.',
        );
    } else {
      const grants = await this.authorization.effectiveGrants(actorUserId);
      if (
        !grants.some(
          (grant) =>
            keys.includes(grant.permission) &&
            (grant.scope.type === 'SYSTEM' ||
              grant.scope.type === 'ORGANIZATION'),
        )
      )
        throw new ForbiddenException(
          'Missing permission role.read for the requested scope.',
        );
    }
    return {
      items: ROLE_TEMPLATES.map((template) => ({
        key: template.key,
        name: template.name,
        description: template.description,
        permissions: [...template.permissions].sort(),
        ...(held
          ? {
              missingPermissions: template.permissions
                .filter((key) => !held.has(key))
                .sort(),
            }
          : {}),
      })),
    };
  }

  async createRole(
    actorUserId: string,
    organizationId: string,
    input: RoleInput,
    context: RequestAuditContext = {},
  ) {
    await this.assertActiveOrganization(organizationId);
    await this.authorization.assertCan(actorUserId, 'role.manage', {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const code = normalizeRoleCode(input.code);
    if (!/^[A-Z0-9_-]+$/.test(code) || code === SYSTEM_OWNER_ROLE_CODE) {
      throw new BadRequestException('This role code is reserved.');
    }
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Role name is required.');
    const keys = normalizePermissionKeys(input.permissionKeys);

    return this.prisma.$transaction(async (tx) => {
      await this.assertPermissionDelegation(
        actorUserId,
        organizationId,
        keys,
        tx,
      );
      const role = await tx.role.create({
        data: {
          organizationId,
          code,
          name,
          description: normalizeDescription(input.description),
          isSystemOwner: false,
        },
      });
      await this.replacePermissions(tx, role.id, keys);
      await this.writeAudit(tx, 'ROLE_CREATED', 'Role', role.id, context, {
        organizationId,
        code,
        permissionKeys: keys,
      });
      return tx.role.findUnique({
        where: { id: role.id },
        include: { permissions: { include: { permission: true } } },
      });
    });
  }

  async updateRole(
    actorUserId: string,
    roleId: string,
    input: RoleUpdateInput,
    context: RequestAuditContext = {},
  ) {
    const role = await this.requireConfigurableRole(roleId);
    const organizationId = role.organizationId!;
    await this.assertOnEntity(
      actorUserId,
      'role.manage',
      { type: 'ORGANIZATION', id: organizationId },
      'Role not found',
    );
    if (role.archivedAt) {
      throw new ConflictException('Archived roles cannot be modified.');
    }

    const name = input.name?.trim();
    if (input.name !== undefined && !name) {
      throw new BadRequestException('Role name is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id: roleId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(input.description !== undefined
            ? { description: normalizeDescription(input.description) }
            : {}),
        },
      });
      await this.writeAudit(tx, 'ROLE_UPDATED', 'Role', roleId, context, {
        before: role,
        after: updated,
      });
      return tx.role.findUnique({
        where: { id: roleId },
        include: { permissions: { include: { permission: true } } },
      });
    });
  }

  async replaceRolePermissions(
    actorUserId: string,
    roleId: string,
    permissionKeys: string[],
    context: RequestAuditContext = {},
  ) {
    const role = await this.requireConfigurableRole(roleId);
    const organizationId = role.organizationId!;
    await this.assertOnEntity(
      actorUserId,
      'role.manage',
      { type: 'ORGANIZATION', id: organizationId },
      'Role not found',
    );
    if (role.archivedAt) {
      throw new ConflictException('Archived roles cannot be modified.');
    }
    const keys = normalizePermissionKeys(permissionKeys);

    return this.prisma.$transaction(
      async (tx) => {
        const before = await this.rolePermissionKeys(roleId, tx);
        await this.assertPermissionDelegation(
          actorUserId,
          organizationId,
          keys.filter((key) => !before.includes(key)),
          tx,
        );
        await this.replacePermissions(tx, roleId, keys);
        await this.writeAudit(
          tx,
          'ROLE_PERMISSIONS_CHANGED',
          'Role',
          roleId,
          context,
          {
            before,
            after: keys,
            added: keys.filter((key) => !before.includes(key)),
            removed: before.filter((key) => !keys.includes(key)),
          },
        );
        return tx.role.findUnique({
          where: { id: roleId },
          include: { permissions: { include: { permission: true } } },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async archiveRole(
    actorUserId: string,
    roleId: string,
    context: RequestAuditContext = {},
  ) {
    const role = await this.requireConfigurableRole(roleId);
    await this.assertOnEntity(
      actorUserId,
      'role.manage',
      { type: 'ORGANIZATION', id: role.organizationId! },
      'Role not found',
    );
    if (role.archivedAt) return { success: true };

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Batch 6A (N1): lock the role row FOR UPDATE first. That conflicts with the key-share
      // lock a concurrent role assignment's grant insert takes on the role row (its foreign-key
      // check), so an assignment that already inserted makes this wait and its grant is then
      // revoked below; one that inserts after this commits fails its Serializable transaction.
      // A plain row update (FOR NO KEY UPDATE) would not conflict, and a raced grant could stay
      // live on the archived role and authorize again once the role is reactivated.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Role" WHERE "id" = ${roleId}::uuid FOR UPDATE`,
      );
      // Batch 5E: archive once. A concurrent archive waits on the role row and then finds it
      // archived; its grants are revoked (and audited) by the first one only.
      const archivedNow = await tx.role.updateMany({
        where: { id: roleId, archivedAt: null },
        data: { archivedAt: now },
      });
      if (archivedNow.count !== 1) return { success: true };
      // The grants still live once locked, in id order (as every revocation path locks them).
      const ids = (
        await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "RoleAssignment" WHERE "roleId" = ${roleId}::uuid AND "revokedAt" IS NULL ORDER BY "id" FOR UPDATE`,
        )
      ).map((row) => row.id);
      const revoked: string[] = [];
      for (const id of ids) {
        const changed = await tx.roleAssignment.updateMany({
          where: { id, revokedAt: null },
          data: {
            revokedAt: now,
            revokedByUserId: actorUserId,
            revocationReason: 'Role archived',
          },
        });
        if (changed.count === 1) revoked.push(id);
      }
      for (const id of revoked) {
        await this.writeAudit(
          tx,
          'ROLE_ASSIGNMENT_REVOKED',
          'RoleAssignment',
          id,
          context,
          { roleId, reason: 'Role archived' },
        );
      }
      const archived = await tx.role.findUniqueOrThrow({
        where: { id: roleId },
      });
      await this.writeAudit(tx, 'ROLE_ARCHIVED', 'Role', roleId, context, {
        before: role,
        after: archived,
        revokedAssignmentCount: revoked.length,
      });
      return { success: true, role: archived };
    });
  }

  async reactivateRole(
    actorUserId: string,
    roleId: string,
    context: RequestAuditContext = {},
  ) {
    const role = await this.requireConfigurableRole(roleId);
    await this.assertOnEntity(
      actorUserId,
      'role.manage',
      { type: 'ORGANIZATION', id: role.organizationId! },
      'Role not found',
    );
    if (!role.archivedAt) return { success: true };
    const reactivated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id: roleId },
        data: { archivedAt: null },
      });
      await this.writeAudit(tx, 'ROLE_REACTIVATED', 'Role', roleId, context, {
        before: role,
        after: updated,
      });
      return updated;
    });
    return { success: true, role: reactivated };
  }

  async listAssignments(
    actorUserId: string,
    roleId: string,
    query: {
      includeRevoked?: 'true' | 'false';
      limit?: number;
      afterId?: string;
    } = {},
  ) {
    const role = await this.requireConfigurableRole(roleId);
    await this.assertOnEntity(
      actorUserId,
      'role.read',
      { type: 'ORGANIZATION', id: role.organizationId! },
      'Role not found',
    );
    const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 25)));
    const assignments = await this.prisma.roleAssignment.findMany({
      where: {
        roleId,
        ...(query.includeRevoked === 'true' ? {} : { revokedAt: null }),
        ...(query.afterId ? { id: { gt: query.afterId } } : {}),
      },
      include: { user: { select: { id: true, email: true } } },
      orderBy: [{ id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = assignments.length > limit;
    const items = assignments.slice(0, limit);
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async getAssignment(actorUserId: string, assignmentId: string) {
    const assignment = (await this.prisma.roleAssignment.findUnique({
      where: { id: assignmentId },
      include: { role: true },
    })) as (RoleAssignmentRow & { role: RoleRow }) | null;
    if (!assignment || assignment.role.isSystemOwner) {
      throw new NotFoundException('Role assignment not found');
    }
    const scope = assignmentScopeRef(assignment);
    await this.assertOnEntity(
      actorUserId,
      'role.read',
      scope,
      'Role assignment not found',
    );
    return assignment;
  }

  async createAssignment(
    actorUserId: string,
    input: CreateAssignmentInput,
    context: RequestAuditContext = {},
  ) {
    const startsAt = input.startsAt ?? new Date();
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('expiresAt must be later than startsAt.');
    }

    return this.prisma.$transaction(
      async (tx) => {
        const role = (await tx.role.findUnique({
          where: { id: input.roleId },
        })) as RoleRow | null;
        if (!role || role.isSystemOwner || !role.organizationId) {
          throw new NotFoundException('Role not found');
        }
        if (role.archivedAt) {
          throw new ConflictException('Archived roles cannot be assigned.');
        }
        const targetScope = await this.authorization.resolveAssignmentScope(
          input.scope,
          tx,
        );
        if (role.organizationId !== targetScope.organizationId) {
          throw new BadRequestException(
            'Role and assignment scope must share an organization.',
          );
        }
        const user = await tx.user.findUnique({
          where: { id: input.userId },
        });
        // An INVITED user may be given roles ahead of activation: authorization only ever
        // loads the assignments of ACTIVE users, so they grant nothing until the invitation is
        // accepted. Disabled, locked and archived accounts receive no new roles.
        if (
          !user ||
          (user.status !== 'ACTIVE' && user.status !== 'INVITED') ||
          user.archivedAt
        ) {
          throw new NotFoundException('Active or invited user not found');
        }
        const permissionKeys = await this.rolePermissionKeys(role.id, tx);
        await this.authorization.assertCanDelegate(
          actorUserId,
          permissionKeys,
          input.scope,
          tx,
        );
        // The same rule as the user search, enforced here so that knowing an account's id does
        // not reach past it; the same answer as an unknown account.
        if (
          (await tx.user.count({
            where: {
              id: user.id,
              ...(await this.assignableUsers(
                actorUserId,
                tx,
                targetScope.organizationId,
              )),
            },
          })) === 0
        ) {
          throw new NotFoundException('Active or invited user not found');
        }
        const existing = await tx.roleAssignment.findFirst({
          where: {
            userId: user.id,
            roleId: role.id,
            revokedAt: null,
            scopeType: input.scope.type,
            organizationId:
              input.scope.type === 'ORGANIZATION'
                ? input.scope.id
                : targetScope.organizationId,
            organizationalUnitId:
              input.scope.type === 'ORGANIZATIONAL_UNIT'
                ? input.scope.id
                : null,
            departmentId:
              input.scope.type === 'DEPARTMENT' ? input.scope.id : null,
            teamId: input.scope.type === 'TEAM' ? input.scope.id : null,
          },
        });
        if (existing) {
          throw new ConflictException(
            'A non-revoked assignment already exists for this user, role, and scope.',
          );
        }
        const assignment = await tx.roleAssignment.create({
          data: {
            userId: user.id,
            roleId: role.id,
            roleOrganizationId: role.organizationId,
            ...scopeColumns(input.scope, targetScope.organizationId),
            startsAt,
            expiresAt,
            createdByUserId: actorUserId,
          },
        });
        await this.writeAudit(
          tx,
          'ROLE_ASSIGNMENT_CREATED',
          'RoleAssignment',
          assignment.id,
          context,
          {
            userId: user.id,
            roleId: role.id,
            scope: input.scope,
            startsAt,
            expiresAt,
          },
        );
        return assignment;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /**
   * Batch 5D: the checks revokeAssignment makes before it changes anything (System Owner
   * assignments are never revoked here; role.assign over the assignment's scope, 404 when the
   * caller cannot see it at all). Callers revoking several assignments run it for each first, so a
   * refusal leaves every one of them in place.
   */
  /**
   * Whether the actor may revoke a grant (404 when they cannot see it, 403 for a System Owner
   * assignment or without role.assign over its scope). With `client` a transaction, the check
   * reads the transaction's view (Batch 5E).
   */
  async assertCanRevoke(
    actorUserId: string,
    assignmentId: string,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    const assignment = (await client.roleAssignment.findUnique({
      where: { id: assignmentId },
      include: { role: true },
    })) as (RoleAssignmentRow & { role: RoleRow }) | null;
    if (!assignment) throw new NotFoundException('Role assignment not found');
    if (assignment.role.isSystemOwner) {
      throw new ForbiddenException(
        'System Owner assignments are bootstrap-managed.',
      );
    }
    await this.assertOnEntity(
      actorUserId,
      'role.assign',
      assignmentScopeRef(assignment),
      'Role assignment not found',
      client,
    );
    return assignment;
  }

  async revokeAssignment(
    actorUserId: string,
    assignmentId: string,
    reason: string | undefined,
    context: RequestAuditContext = {},
  ) {
    // Statuses before any lock (unchanged); the transaction checks again on its own view.
    await this.assertCanRevoke(actorUserId, assignmentId);
    return this.prisma.$transaction(async (tx) => {
      await this.revokeAssignmentsInTx(
        tx,
        actorUserId,
        [assignmentId],
        reason,
        context,
      );
      return tx.roleAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
      });
    });
  }

  /**
   * Batch 5E — revokes grants inside the caller's transaction, all or none: the rows are locked
   * in id order (the order every revocation path uses, so concurrent revocations never
   * deadlock), every grant is authorized on the transaction's view before any is changed, and
   * each is revoked with a conditional update. A grant someone else already revoked is left as
   * it is (its revoker and audit entry stay the only ones) and reported in `alreadyRevoked`.
   * Any failure — a refusal, an audit write, the caller's next step — rolls everything back.
   */
  async revokeAssignmentsInTx(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    assignmentIds: readonly string[],
    reason: string | undefined,
    context: RequestAuditContext = {},
  ) {
    const ids = [...new Set(assignmentIds)].sort();
    await lockRoleAssignments(tx, ids);
    const assignments = [];
    for (const id of ids)
      assignments.push(await this.assertCanRevoke(actorUserId, id, tx));
    const revocationReason = reason?.trim() || null;
    const now = new Date();
    const revoked: string[] = [];
    const alreadyRevoked: string[] = [];
    for (const assignment of assignments) {
      const changed = await tx.roleAssignment.updateMany({
        where: { id: assignment.id, revokedAt: null },
        data: {
          revokedAt: now,
          revokedByUserId: actorUserId,
          revocationReason,
        },
      });
      if (changed.count !== 1) {
        alreadyRevoked.push(assignment.id);
        continue;
      }
      await this.writeAudit(
        tx,
        'ROLE_ASSIGNMENT_REVOKED',
        'RoleAssignment',
        assignment.id,
        context,
        // Phase 19: identifiers only; the reason stays on the assignment row.
        {
          userId: assignment.userId,
          roleId: assignment.roleId,
          scope: assignmentScopeRef(assignment),
          revokedAt: now,
          withReason: revocationReason !== null,
        },
      );
      revoked.push(assignment.id);
    }
    return { revoked, alreadyRevoked };
  }

  /**
   * Which accounts an actor may find and give roles to (tenant isolation). With `role.assign`
   * at System scope: every account. Otherwise only accounts connected to an organization where
   * the actor holds `role.assign` for the whole organization: a PLANNED or ACTIVE employment
   * assignment there, or a current or upcoming (not revoked, not expired) role there. This keeps
   * the usual workflows (an employee's login, invited or active, gets roles in their own
   * organization; an administrator of several organizations can appoint a person from one of
   * them in another) without revealing the people of organizations the actor does not
   * administer. A person outside them is connected first (hired or assigned there), or given
   * the role by a System-scope administrator. `alsoOrganizationId` adds the organization of a
   * role being assigned, where the caller has already checked the actor's authority (which may
   * be narrower than the whole organization, e.g. one department).
   */
  private async assignableUsers(
    actorUserId: string,
    client: Prisma.TransactionClient = this.prisma,
    alsoOrganizationId?: string,
  ): Promise<Prisma.UserWhereInput> {
    const now = new Date();
    const grants = (
      await this.authorization.effectiveGrants(actorUserId, now, client)
    ).filter((grant) => grant.permission === 'role.assign');
    if (grants.some((grant) => grant.scope.type === 'SYSTEM')) return {};
    const organizationIds = [
      ...new Set(
        grants.flatMap((grant) =>
          grant.scope.type === 'ORGANIZATION' && grant.scope.id
            ? [grant.scope.id]
            : [],
        ),
      ),
      ...(alsoOrganizationId ? [alsoOrganizationId] : []),
    ];
    return {
      OR: [
        {
          person: {
            employee: {
              assignments: {
                some: {
                  status: { in: ['PLANNED', 'ACTIVE'] },
                  position: { organizationId: { in: organizationIds } },
                },
              },
            },
          },
        },
        {
          roleAssignments: {
            some: {
              revokedAt: null,
              scopeType: { not: 'SYSTEM' },
              organizationId: { in: organizationIds },
              role: { archivedAt: null },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
          },
        },
      ],
    };
  }

  async searchActiveUsers(
    actorUserId: string,
    organizationId: string,
    query = '',
    limit = 25,
    afterId?: string,
  ) {
    await this.authorization.assertCan(actorUserId, 'role.assign', {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 25));
    const term = query.trim();
    const contains = { contains: term, mode: 'insensitive' as const };
    const users = await this.prisma.user.findMany({
      where: {
        // Active and invited accounts can receive roles (invited ones take effect on activation).
        status: { in: ['ACTIVE', 'INVITED'] },
        archivedAt: null,
        AND: [
          await this.assignableUsers(actorUserId),
          term
            ? {
                OR: [
                  { email: contains },
                  { person: { firstName: contains } },
                  { person: { lastName: contains } },
                  { person: { preferredName: contains } },
                  { person: { employee: { employeeNumber: contains } } },
                ],
              }
            : {},
        ],
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: {
        id: true,
        email: true,
        status: true,
        person: {
          select: {
            firstName: true,
            lastName: true,
            preferredName: true,
            employee: { select: { employeeNumber: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: safeLimit + 1,
    });
    const hasMore = users.length > safeLimit;
    const page = users.slice(0, safeLimit);
    return {
      items: page.map((user) => {
        const name = [
          user.person.preferredName ?? user.person.firstName,
          user.person.lastName,
        ]
          .filter(Boolean)
          .join(' ');
        return {
          id: user.id,
          email: user.email,
          status: user.status as 'ACTIVE' | 'INVITED',
          displayName: name || null,
          employeeNumber: user.person.employee?.employeeNumber ?? null,
        };
      }),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async bootstrapSystemOwner(
    emailInput: string,
  ): Promise<{ userId: string; roleId: string }> {
    const email = emailInput.trim().toLowerCase();
    if (!email) throw new BadRequestException('An explicit email is required.');
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE' || user.archivedAt) {
      throw new NotFoundException('Active user with that email not found');
    }

    const permissionRows = await this.prisma.permission.findMany({
      where: {
        key: { in: PERMISSION_CATALOG.map(({ key }) => key) },
        isActive: true,
      },
    });
    if (permissionRows.length !== PERMISSION_CATALOG.length) {
      throw new ConflictException(
        'Permission catalog must be synchronized first.',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        let role = await tx.role.findFirst({ where: { isSystemOwner: true } });
        if (!role) {
          role = await tx.role.create({
            data: {
              organizationId: null,
              code: SYSTEM_OWNER_ROLE_CODE,
              name: SYSTEM_OWNER_ROLE_NAME,
              description: 'Reserved deployment-wide administrator role.',
              isSystemOwner: true,
            },
          });
        }
        if (
          !role.isSystemOwner ||
          role.organizationId !== null ||
          role.code !== SYSTEM_OWNER_ROLE_CODE
        ) {
          throw new ConflictException('Reserved System Owner role is invalid.');
        }
        if (role.archivedAt) {
          role = await tx.role.update({
            where: { id: role.id },
            data: { archivedAt: null, name: SYSTEM_OWNER_ROLE_NAME },
          });
        }

        for (const permission of permissionRows) {
          const existing = await tx.rolePermission.findFirst({
            where: { roleId: role.id, permissionId: permission.id },
          });
          if (!existing) {
            await tx.rolePermission.create({
              data: { roleId: role.id, permissionId: permission.id },
            });
          }
        }

        const existingAssignment = await tx.roleAssignment.findFirst({
          where: {
            userId: user.id,
            roleId: role.id,
            scopeType: 'SYSTEM',
            revokedAt: null,
          },
        });
        if (!existingAssignment) {
          const assignment = await tx.roleAssignment.create({
            data: {
              userId: user.id,
              roleId: role.id,
              roleOrganizationId: null,
              scopeType: 'SYSTEM',
              organizationId: null,
              organizationalUnitId: null,
              departmentId: null,
              teamId: null,
              createdByUserId: null,
            },
          });
          await this.writeAudit(
            tx,
            'SYSTEM_OWNER_BOOTSTRAPPED',
            'RoleAssignment',
            assignment.id,
            {},
            { userId: user.id, roleId: role.id },
          );
        }
        return { userId: user.id, roleId: role.id };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private async assertPermissionDelegation(
    actorUserId: string,
    organizationId: string,
    permissionKeys: string[],
    client: Prisma.TransactionClient = this.prisma,
  ) {
    const scope = { type: 'ORGANIZATION' as const, id: organizationId };
    for (const permissionKey of permissionKeys) {
      await this.authorization.assertCan(
        actorUserId,
        permissionKey,
        scope,
        client,
      );
    }
  }

  private async rolePermissionKeys(
    roleId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    // The same key set the M3 keep approval delegates (AuthorizationService.assertCanDelegateRole).
    return activeRolePermissionKeys(client, roleId);
  }

  private async replacePermissions(
    tx: Prisma.TransactionClient,
    roleId: string,
    permissionKeys: string[],
  ) {
    const permissions = await tx.permission.findMany({
      where: { key: { in: permissionKeys }, isActive: true },
    });
    if (permissions.length !== permissionKeys.length) {
      throw new BadRequestException(
        'One or more permission keys are not active.',
      );
    }
    await tx.rolePermission.deleteMany({ where: { roleId } });
    for (const permission of permissions) {
      await tx.rolePermission.create({
        data: { roleId, permissionId: permission.id },
      });
    }
  }

  private async requireRole(roleId: string): Promise<RoleRow> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private async requireConfigurableRole(roleId: string): Promise<RoleRow> {
    const role = await this.requireRole(roleId);
    if (role.isSystemOwner || !role.organizationId) {
      throw new NotFoundException('Role not found');
    }
    return role;
  }

  private async assertActiveOrganization(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!organization || organization.archivedAt) {
      throw new NotFoundException('Organization not found');
    }
  }

  /**
   * assertCan on an existing role / assignment. A caller with no role permission at all over
   * its scope (e.g. an id of another organization) gets the same 404 as for a missing id
   * (Phase 19: no existence oracle); a caller who can see it but not act keeps the 403.
   */
  private async assertOnEntity(
    actorUserId: string,
    permission: 'role.read' | 'role.manage' | 'role.assign',
    scope: Parameters<AuthorizationService['assertCan']>[2],
    notFound: string,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    try {
      await this.authorization.assertCan(
        actorUserId,
        permission,
        scope,
        client,
      );
    } catch (error) {
      if (error instanceof ForbiddenException) {
        let visible = false;
        for (const key of ['role.read', 'role.manage', 'role.assign'])
          if (
            await this.authorization.canAccess(actorUserId, key, scope, client)
          ) {
            visible = true;
            break;
          }
        if (!visible) throw new NotFoundException(notFound);
      }
      throw error;
    }
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
    context: RequestAuditContext,
    metadata: Record<string, unknown>,
  ) {
    const auditMetadata = JSON.parse(
      JSON.stringify(metadata),
    ) as Prisma.InputJsonValue;
    await this.audit.write(
      {
        action,
        entityType,
        entityId,
        actorUserId: context.actorUserId ?? null,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        correlationId: context.correlationId ?? null,
        metadata: auditMetadata,
      },
      tx,
    );
  }
}

function normalizeRoleCode(code: string): string {
  return code.trim().replace(/\s+/g, '-').toUpperCase();
}

function normalizeDescription(description?: string | null): string | null {
  return description?.trim() || null;
}

function normalizePermissionKeys(permissionKeys: string[]): string[] {
  return [...new Set(permissionKeys.map((key) => key.trim()))].sort();
}

function scopeColumns(scope: ScopeRef, organizationId: string) {
  return {
    scopeType: scope.type,
    organizationId: scope.type === 'SYSTEM' ? null : organizationId,
    organizationalUnitId:
      scope.type === 'ORGANIZATIONAL_UNIT' ? scope.id! : null,
    departmentId: scope.type === 'DEPARTMENT' ? scope.id! : null,
    teamId: scope.type === 'TEAM' ? scope.id! : null,
  };
}

/**
 * Batch 5E: grant rows are always locked in id order, by every path that revokes grants
 * (lifecycle revocation, the Roles API, role archiving, invitation cancellation), so two of them
 * never wait on each other in opposite orders.
 */
async function lockRoleAssignments(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
) {
  if (ids.length === 0) return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "RoleAssignment" WHERE "id" IN (${Prisma.join(
      ids.map((id) => Prisma.sql`${id}::uuid`),
    )}) ORDER BY "id" FOR UPDATE`,
  );
}

function assignmentScopeRef(assignment: RoleAssignmentRow): ScopeRef {
  switch (assignment.scopeType) {
    case 'SYSTEM':
      return { type: 'SYSTEM' };
    case 'ORGANIZATION':
      return {
        type: 'ORGANIZATION',
        id: assignment.organizationId ?? undefined,
      };
    case 'ORGANIZATIONAL_UNIT':
      return {
        type: 'ORGANIZATIONAL_UNIT',
        id: assignment.organizationalUnitId ?? undefined,
      };
    case 'DEPARTMENT':
      return { type: 'DEPARTMENT', id: assignment.departmentId ?? undefined };
    case 'TEAM':
      return { type: 'TEAM', id: assignment.teamId ?? undefined };
  }
}
