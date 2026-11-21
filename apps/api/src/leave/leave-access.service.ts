import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  AuthorizationTarget,
  EffectiveGrant,
} from '../authorization/authorization.types.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import {
  positionTargets,
  resolveLeaveTimezone,
  type LeaveClient,
} from './leave-common.js';

export const LEAVE_PERMISSIONS = [
  'leave.request',
  'leave.read',
  'leave.approve',
  'leave.adjust',
  'leave.manage_policy',
] as const;
export type LeavePermission = (typeof LEAVE_PERMISSIONS)[number];

export const ASSIGNMENT_CONTEXT_INCLUDE = {
  employee: {
    select: {
      id: true,
      status: true,
      hireDate: true,
      terminationDate: true,
      archivedAt: true,
      personId: true,
    },
  },
  position: {
    select: {
      id: true,
      name: true,
      code: true,
      organizationId: true,
      organizationalUnitId: true,
      departmentId: true,
      teamId: true,
      workLocation: { select: { id: true, name: true, timezone: true } },
      organization: {
        select: { id: true, name: true, code: true, timezone: true },
      },
    },
  },
} as const;

/**
 * Shared Leave authorization and work-context helpers. Every Leave permission is scoped through
 * the EmploymentAssignment's position placement, like the time.* permissions.
 */
@Injectable()
export class LeaveAccessService {
  /** Phase 18: the LEAVE module gate (assignment contexts and organization reads use it). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when Leave is disabled for the organization. */
  requireEnabled(organizationId: string, client: LeaveClient = this.prisma) {
    return this.features.require(organizationId, 'LEAVE', client);
  }

  /** Organizations (ids) where Leave is disabled: for multi-organization lists. */
  async disabledOrganizations(client: LeaveClient = this.prisma) {
    return [...(await this.features.disabledOrganizations('LEAVE', client))];
  }

  async grants(
    userId: string,
    client: LeaveClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter(
      (grant) =>
        (LEAVE_PERMISSIONS as readonly string[]).includes(grant.permission) ||
        grant.permission === 'holiday.manage',
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: LeavePermission,
    target: AuthorizationTarget,
  ) {
    return permissionIsGranted(grants, permission, target);
  }

  canAny(
    grants: EffectiveGrant[],
    permissions: readonly LeavePermission[],
    target: AuthorizationTarget,
  ) {
    return permissions.some((permission) =>
      permissionIsGranted(grants, permission, target),
    );
  }

  /** The assignment with its employee, position placement, target and resolved timezone. */
  async assignmentContext(
    assignmentId: string,
    client: LeaveClient = this.prisma,
  ) {
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      include: ASSIGNMENT_CONTEXT_INCLUDE,
    });
    if (!assignment)
      throw new NotFoundException('Employment assignment not found');
    // Phase 18 / 19: the LEAVE gate is NOT applied here. Every caller authorizes against the
    // context first and then gates (requireAssignmentPermission, the self / decider guards,
    // the ledger and policy resolution), so a caller without access never learns from a
    // FEATURE_DISABLED answer that the assignment exists.
    const target = (await positionTargets(client, [assignment.position])).get(
      assignment.position.id,
    )!;
    return {
      assignment,
      target,
      timezone: () => resolveLeaveTimezone(assignment.position),
    };
  }

  async requireAssignmentPermission(
    userId: string,
    assignmentId: string,
    permission: LeavePermission,
    client: LeaveClient = this.prisma,
  ) {
    const context = await this.assignmentContext(assignmentId, client);
    const grants = await this.grants(userId, client);
    if (!this.can(grants, permission, context.target)) {
      throw new ForbiddenException(
        `Missing permission ${permission} for the assignment.`,
      );
    }
    await this.requireEnabled(context.target.organizationId, client);
    return { ...context, grants };
  }

  /** The signed-in user's Employee, or 403. */
  async selfEmployee(userId: string, client: LeaveClient = this.prisma) {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: {
        person: {
          select: {
            employee: { select: { id: true, status: true, archivedAt: true } },
          },
        },
      },
    });
    const employee = user?.person?.employee;
    if (!employee || employee.archivedAt) {
      throw new ForbiddenException('Authenticated user is not an employee.');
    }
    return employee;
  }

  /** The Employee linked to a user, if any (used to refuse self-approval). */
  async employeeIdOfUser(userId: string, client: LeaveClient = this.prisma) {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    return user?.person?.employee?.id ?? null;
  }

  /**
   * Whether a permission is granted anywhere inside an organization (organization, one of its
   * units, departments or teams) — used for organization catalog reads such as leave types.
   */
  async grantedInOrganization(
    grants: EffectiveGrant[],
    permissions: readonly string[],
    organizationId: string,
    client: LeaveClient = this.prisma,
  ) {
    const relevant = grants.filter((g) => permissions.includes(g.permission));
    if (relevant.some((g) => g.scope.type === 'SYSTEM')) return true;
    if (
      relevant.some(
        (g) => g.scope.type === 'ORGANIZATION' && g.scope.id === organizationId,
      )
    ) {
      return true;
    }
    const ids = (type: string) =>
      relevant
        .filter((g) => g.scope.type === type)
        .map((g) => g.scope.id!)
        .filter(Boolean);
    const [units, departments, teams] = await Promise.all([
      ids('ORGANIZATIONAL_UNIT').length
        ? client.organizationalUnit.count({
            where: { id: { in: ids('ORGANIZATIONAL_UNIT') }, organizationId },
          })
        : 0,
      ids('DEPARTMENT').length
        ? client.department.count({
            where: { id: { in: ids('DEPARTMENT') }, organizationId },
          })
        : 0,
      ids('TEAM').length
        ? client.team.count({
            where: { id: { in: ids('TEAM') }, organizationId },
          })
        : 0,
    ]);
    return units + departments + teams > 0;
  }

  organizationTarget(organizationId: string): AuthorizationTarget {
    return {
      type: 'ORGANIZATION',
      organizationId,
      unitPathIds: [],
      departmentId: null,
      teamId: null,
    };
  }
}
