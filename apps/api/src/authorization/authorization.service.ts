import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Permission } from '../generated/prisma/client.js';
import {
  assignmentScope,
  isAssignmentEffective,
  permissionIsGranted,
  scopeContainsTarget,
} from './authorization.policy.js';
import type {
  AuthorizationScope,
  AuthorizationTarget,
  CurrentGrantSnapshot,
  EffectiveGrant,
  RoleAssignmentRow,
  ScopeRef,
  StructuralRow,
} from './authorization.types.js';

type AuthorizationClient = Prisma.TransactionClient;

/**
 * Batch 5B (K9): a grant counts only while its role is not archived and neither its scope
 * organization nor its role's organization is archived. SYSTEM grants (no organization) and
 * global roles are unaffected; the records themselves are never changed, so reactivating the
 * organization restores every grant that is otherwise still valid (dates, revocation, account).
 */
export const LIVE_ORGANIZATION_GRANT = {
  OR: [{ organizationId: null }, { organization: { archivedAt: null } }],
  role: {
    archivedAt: null,
    OR: [{ organizationId: null }, { organization: { archivedAt: null } }],
  },
} satisfies Prisma.RoleAssignmentWhereInput;

/**
 * A role's active permission keys — what granting the role delegates (the ordinary role-assignment
 * workflow and the M3 keep approval both use this). 404 when the role does not exist.
 */
export async function activeRolePermissionKeys(
  client: AuthorizationClient,
  roleId: string,
): Promise<string[]> {
  const role = (await client.role.findUnique({
    where: { id: roleId },
    include: {
      permissions: {
        where: { permission: { isActive: true } },
        include: { permission: true },
      },
    },
  })) as { permissions: Array<{ permission: { key: string } }> } | null;
  if (!role) throw new NotFoundException('Role not found');
  return role.permissions.map(({ permission }) => permission.key);
}

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async effectiveGrants(
    userId: string,
    now = new Date(),
    client: AuthorizationClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    const assignments = await this.loadAssignments(userId, client);
    const grants: EffectiveGrant[] = [];

    for (const assignment of assignments) {
      if (!isAssignmentEffective(assignment, now) || !assignment.role) continue;
      if (assignment.role.archivedAt !== null) continue;
      const scope = assignmentScope(assignment);
      for (const grant of assignment.role.permissions ?? []) {
        if (!grant.permission.isActive) continue;
        grants.push({
          permission: grant.permission.key,
          scope: { type: scope.type, ...(scope.id ? { id: scope.id } : {}) },
        });
      }
    }

    return grants;
  }

  async can(
    userId: string,
    permissionKey: string,
    scope?: AuthorizationScope,
    now = new Date(),
    client: AuthorizationClient = this.prisma,
  ): Promise<boolean> {
    const grants = await this.effectiveGrants(userId, now, client);
    if (!scope) {
      return grants.some((grant) => grant.permission === permissionKey);
    }
    if (scope.type === 'SYSTEM') {
      return grants.some(
        (grant) =>
          grant.permission === permissionKey && grant.scope.type === 'SYSTEM',
      );
    }
    const target = await this.resolveTarget(scope, client);
    return permissionIsGranted(grants, permissionKey, target);
  }

  async assertCan(
    userId: string,
    permissionKey: string,
    scope: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
  ): Promise<void> {
    if (!(await this.can(userId, permissionKey, scope, new Date(), client))) {
      throw new ForbiddenException(
        `Missing permission ${permissionKey} for the requested scope.`,
      );
    }
  }

  async assertAccess(
    userId: string,
    permissionKey: string,
    scope: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
  ): Promise<void> {
    return this.assertCan(userId, permissionKey, scope, client);
  }

  async canAccess(
    userId: string,
    permissionKey: string,
    scope: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
  ): Promise<boolean> {
    return this.can(userId, permissionKey, scope, new Date(), client);
  }

  /**
   * The permission keys the user holds anywhere within one Organization: at SYSTEM scope, on the
   * Organization itself, or on an Organizational Unit, Department or Team that belongs to it. Built
   * on effectiveGrants, so only active, unexpired, unrevoked grants outside archived organizations
   * (K9) count. It answers "may this user act somewhere in X", never "may they act on this record".
   */
  async permissionKeysWithinOrganization(
    userId: string,
    organizationId: string,
    client: AuthorizationClient = this.prisma,
    now: Date = new Date(),
  ): Promise<Set<string>> {
    const grants = await this.effectiveGrants(userId, now, client);
    const keys = new Set<string>();
    const structural = new Map<string, string[]>();
    for (const grant of grants) {
      if (
        grant.scope.type === 'SYSTEM' ||
        (grant.scope.type === 'ORGANIZATION' &&
          grant.scope.id === organizationId)
      ) {
        keys.add(grant.permission);
      } else if (
        grant.scope.id &&
        (grant.scope.type === 'ORGANIZATIONAL_UNIT' ||
          grant.scope.type === 'DEPARTMENT' ||
          grant.scope.type === 'TEAM')
      ) {
        const key = `${grant.scope.type}:${grant.scope.id}`;
        structural.set(key, [...(structural.get(key) ?? []), grant.permission]);
      }
    }
    if (structural.size === 0) return keys;
    const ids = (type: string) =>
      [...structural.keys()]
        .filter((key) => key.startsWith(`${type}:`))
        .map((key) => key.slice(type.length + 1));
    const [units, departments, teams] = await Promise.all([
      client.organizationalUnit.findMany({
        where: { id: { in: ids('ORGANIZATIONAL_UNIT') }, organizationId },
        select: { id: true },
      }),
      client.department.findMany({
        where: { id: { in: ids('DEPARTMENT') }, organizationId },
        select: { id: true },
      }),
      client.team.findMany({
        where: { id: { in: ids('TEAM') }, organizationId },
        select: { id: true },
      }),
    ]);
    for (const [type, rows] of [
      ['ORGANIZATIONAL_UNIT', units],
      ['DEPARTMENT', departments],
      ['TEAM', teams],
    ] as const) {
      for (const { id } of rows) {
        for (const permission of structural.get(`${type}:${id}`) ?? [])
          keys.add(permission);
      }
    }
    return keys;
  }

  async effectivePermissions(
    userId: string,
    scope?: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
    now: Date = new Date(),
  ): Promise<Permission[]> {
    const grants = await this.effectiveGrants(userId, now, client);
    let relevant = grants;
    if (scope?.type === 'SYSTEM') {
      relevant = grants.filter((grant) => grant.scope.type === 'SYSTEM');
    } else if (scope) {
      const target = await this.resolveTarget(scope, client);
      relevant = grants.filter((grant) =>
        scopeContainsTarget(grant.scope, target),
      );
    }
    const permissionKeys = [
      ...new Set(relevant.map(({ permission }) => permission)),
    ];
    if (permissionKeys.length === 0) return [];
    return client.permission.findMany({
      where: { key: { in: permissionKeys }, isActive: true },
      orderBy: { key: 'asc' },
    });
  }

  async effectivePermissionKeys(
    userId: string,
    scope?: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
    now: Date = new Date(),
  ): Promise<string[]> {
    return (await this.effectivePermissions(userId, scope, client, now)).map(
      (permission) => permission.key,
    );
  }

  async assertCanDelegate(
    actorUserId: string,
    permissionKeys: readonly string[],
    scope: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
    now: Date = new Date(),
  ): Promise<void> {
    const effectiveKeys = new Set(
      await this.effectivePermissionKeys(actorUserId, scope, client, now),
    );
    if (!effectiveKeys.has('role.assign')) {
      throw new ForbiddenException(
        'Missing permission role.assign for the requested scope.',
      );
    }
    for (const permissionKey of new Set(permissionKeys)) {
      if (!effectiveKeys.has(permissionKey)) {
        throw new ForbiddenException(
          `Missing permission ${permissionKey} for the requested scope.`,
        );
      }
    }
  }

  /**
   * The role-delegation rule of the ordinary role-assignment workflow: to grant (or, M3, to keep)
   * a role at a scope, the actor needs role.assign there plus every active permission of the
   * role, each through a grant whose scope contains the target scope (SYSTEM: SYSTEM grants).
   * Read on the caller's client, so a transaction sees its own view; `now` is when the authority
   * must hold (default: now — M3 revalidates at a termination's application time). The ordinary workflow
   * (RoleManagementService.createAssignment) applies the same rule: the same key set
   * (activeRolePermissionKeys) through the same assertCanDelegate.
   */
  async assertCanDelegateRole(
    actorUserId: string,
    roleId: string,
    scope: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
    now: Date = new Date(),
  ): Promise<void> {
    await this.assertCanDelegate(
      actorUserId,
      await activeRolePermissionKeys(client, roleId),
      scope,
      client,
      now,
    );
  }

  async getCurrentGrantSnapshot(userId: string): Promise<CurrentGrantSnapshot> {
    const grants = await this.effectiveGrants(userId);
    const permissions = new Map<string, Map<string, ScopeRef>>();
    for (const grant of grants) {
      const scopes = permissions.get(grant.permission) ?? new Map();
      scopes.set(`${grant.scope.type}:${grant.scope.id ?? ''}`, grant.scope);
      permissions.set(grant.permission, scopes);
    }

    return {
      userId,
      permissions: [...permissions.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, scopes]) => ({
          key,
          scopes: [...scopes.values()].sort((a, b) =>
            `${a.type}:${a.id ?? ''}`.localeCompare(`${b.type}:${b.id ?? ''}`),
          ),
        })),
    };
  }

  async resolveTarget(
    scope: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
  ): Promise<AuthorizationTarget> {
    const scopeId =
      scope.type === 'ORGANIZATION'
        ? (scope.id ?? scope.organizationId)
        : scope.id;
    if (scope.type === 'SYSTEM' || !scopeId) {
      throw new NotFoundException(
        'A concrete organizational scope is required.',
      );
    }

    if (scope.type === 'ORGANIZATION') {
      const organization = await client.organization.findUnique({
        where: { id: scopeId },
      });
      if (
        !organization ||
        (scope.organizationId && scope.organizationId !== organization.id)
      ) {
        throw new NotFoundException('Organization not found');
      }
      return { type: 'ORGANIZATION', organizationId: organization.id };
    }

    if (scope.type === 'ORGANIZATIONAL_UNIT') {
      const unit = await client.organizationalUnit.findUnique({
        where: { id: scopeId },
      });
      if (
        !unit ||
        (scope.organizationId && scope.organizationId !== unit.organizationId)
      ) {
        throw new NotFoundException('Organizational unit not found');
      }
      return {
        type: 'ORGANIZATIONAL_UNIT',
        organizationId: unit.organizationId,
        unitPathIds: await this.unitPath(unit.organizationId, unit.id, client),
      };
    }

    if (scope.type === 'DEPARTMENT') {
      const department = await client.department.findUnique({
        where: { id: scopeId },
      });
      if (
        !department ||
        (scope.organizationId &&
          scope.organizationId !== department.organizationId)
      ) {
        throw new NotFoundException('Department not found');
      }
      return {
        type: 'DEPARTMENT',
        organizationId: department.organizationId,
        departmentId: department.id,
        unitPathIds: department.organizationalUnitId
          ? await this.unitPath(
              department.organizationId,
              department.organizationalUnitId,
              client,
            )
          : [],
      };
    }

    const team = await client.team.findUnique({ where: { id: scopeId } });
    if (
      !team ||
      (scope.organizationId && scope.organizationId !== team.organizationId)
    ) {
      throw new NotFoundException('Team not found');
    }
    const departmentId = team.departmentId ?? null;
    let unitId = team.organizationalUnitId ?? null;
    if (departmentId) {
      const department = await client.department.findUnique({
        where: { id: departmentId },
      });
      if (!department || department.organizationId !== team.organizationId) {
        throw new NotFoundException('Team placement not found');
      }
      unitId = department.organizationalUnitId ?? null;
    }
    return {
      type: 'TEAM',
      organizationId: team.organizationId,
      teamId: team.id,
      departmentId,
      unitPathIds: unitId
        ? await this.unitPath(team.organizationId, unitId, client)
        : [],
    };
  }

  async resolveAssignmentScope(
    scope: AuthorizationScope,
    client: AuthorizationClient = this.prisma,
  ): Promise<{
    target: AuthorizationTarget;
    organizationId: string;
  }> {
    if (scope.type === 'SYSTEM') {
      throw new ForbiddenException(
        'System-scoped assignments are reserved for bootstrap.',
      );
    }
    const target = await this.resolveTarget(scope, client);
    return { target, organizationId: target.organizationId };
  }

  private async loadAssignments(
    userId: string,
    client: AuthorizationClient,
  ): Promise<RoleAssignmentRow[]> {
    return client.roleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        ...LIVE_ORGANIZATION_GRANT,
        user: { status: 'ACTIVE', archivedAt: null },
      },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
      },
    });
  }

  private async unitPath(
    organizationId: string,
    unitId: string,
    client: AuthorizationClient,
  ): Promise<string[]> {
    const units = await client.organizationalUnit.findMany({
      where: { organizationId },
    });
    return getUnitPath(units, unitId);
  }
}

export function getUnitPath(
  units: readonly StructuralRow[],
  unitId: string,
): string[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const path: string[] = [];
  const visited = new Set<string>();
  let current: StructuralRow | undefined = byId.get(unitId);

  while (current) {
    if (visited.has(current.id)) return [];
    visited.add(current.id);
    path.push(current.id);
    if (!current.parentUnitId) break;
    const parent = byId.get(current.parentUnitId);
    if (!parent) return [];
    current = parent;
  }

  return path;
}
