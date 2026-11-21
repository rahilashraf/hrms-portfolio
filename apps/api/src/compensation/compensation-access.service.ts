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
import {
  domainError,
  positionTargets,
  type DomainClient,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { compensationTimezone } from './compensation-domain.js';

export const COMPENSATION_PERMISSIONS = [
  'compensation.read',
  'compensation.manage',
] as const;
export type CompensationPermission = (typeof COMPENSATION_PERMISSIONS)[number];

export const COMPENSATION_ASSIGNMENT_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      archivedAt: true,
      person: {
        select: { firstName: true, lastName: true, preferredName: true },
      },
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
      workLocation: { select: { timezone: true } },
      organization: {
        select: { id: true, name: true, code: true, timezone: true },
      },
    },
  },
} as const;

/**
 * Compensation authorization. Pay is sensitive: only the dedicated compensation.* permissions,
 * scoped through the assignment's position like every assignment-level permission, ever grant
 * access — never employee.read/manage, and never a management relationship by itself. An
 * employee reads (only reads) their own compensation through the self-service path.
 */
@Injectable()
export class CompensationAccessService {
  /** Phase 18: the COMPENSATION module gate (every funnel below uses it). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when Compensation is disabled for the organization. */
  requireEnabled(organizationId: string, client: DomainClient = this.prisma) {
    return this.features.require(organizationId, 'COMPENSATION', client);
  }

  /** Organizations (ids) where Compensation is disabled: for multi-organization lists. */
  async disabledOrganizations(client: DomainClient = this.prisma) {
    return [
      ...(await this.features.disabledOrganizations('COMPENSATION', client)),
    ];
  }

  async grants(
    userId: string,
    client: DomainClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (COMPENSATION_PERMISSIONS as readonly string[]).includes(
        grant.permission,
      ),
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: CompensationPermission,
    target: AuthorizationTarget,
  ) {
    return permissionIsGranted(grants, permission, target);
  }

  async assignmentContext(
    assignmentId: string,
    client: DomainClient = this.prisma,
  ) {
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      include: COMPENSATION_ASSIGNMENT_INCLUDE,
    });
    if (!assignment)
      throw new NotFoundException('Employment assignment not found');
    const target = (await positionTargets(client, [assignment.position])).get(
      assignment.position.id,
    )!;
    return {
      assignment,
      target,
      timezone: compensationTimezone(assignment.position),
    };
  }

  /** The Employee linked to a user, if any. */
  async employeeIdOfUser(userId: string, client: DomainClient = this.prisma) {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: {
        person: {
          select: { employee: { select: { id: true, archivedAt: true } } },
        },
      },
    });
    const employee = user?.person?.employee;
    return employee && !employee.archivedAt ? employee.id : null;
  }

  /** compensation.manage on the assignment, and never on one's own compensation. */
  async requireManage(
    userId: string,
    assignmentId: string,
    client: DomainClient = this.prisma,
  ) {
    const context = await this.assignmentContext(assignmentId, client);
    const grants = await this.grants(userId, client);
    if (!this.can(grants, 'compensation.manage', context.target)) {
      throw new ForbiddenException(
        'Missing permission compensation.manage for the assignment.',
      );
    }
    if (
      (await this.employeeIdOfUser(userId, client)) ===
      context.assignment.employeeId
    ) {
      throw new ForbiddenException(
        domainError(
          403,
          'COMPENSATION_SELF_MANAGEMENT',
          'You cannot change your own compensation.',
        ),
      );
    }
    await this.requireEnabled(context.target.organizationId, client);
    return { ...context, grants };
  }

  /**
   * Read access to an assignment's compensation: compensation.read (or .manage) in scope, or the
   * assignment is the reader's own (read-only). Returns whether the reader may also manage it.
   */
  async requireRead(
    userId: string,
    assignmentId: string,
    client: DomainClient = this.prisma,
  ) {
    const context = await this.assignmentContext(assignmentId, client);
    const grants = await this.grants(userId, client);
    const isSelf =
      (await this.employeeIdOfUser(userId, client)) ===
      context.assignment.employeeId;
    const canRead =
      this.can(grants, 'compensation.read', context.target) ||
      this.can(grants, 'compensation.manage', context.target);
    if (!canRead && !isSelf) {
      throw new ForbiddenException(
        'Missing permission compensation.read for the assignment.',
      );
    }
    await this.requireEnabled(context.target.organizationId, client);
    return {
      ...context,
      grants,
      isSelf,
      canManage:
        !isSelf && this.can(grants, 'compensation.manage', context.target),
    };
  }

  /** compensation.manage at the organization itself (pay group administration). */
  async requireOrganizationManage(
    userId: string,
    organizationId: string,
    client: DomainClient = this.prisma,
  ) {
    const grants = await this.grants(userId, client);
    if (
      !this.can(grants, 'compensation.manage', {
        type: 'ORGANIZATION',
        organizationId,
      })
    ) {
      throw new ForbiddenException(
        'Missing permission compensation.manage for the organization.',
      );
    }
    await this.requireEnabled(organizationId, client);
  }

  /** Any compensation permission anywhere in the organization (reading the pay group list). */
  async hasAnyInOrganization(
    userId: string,
    organizationId: string,
    client: DomainClient = this.prisma,
  ) {
    const grants = await this.grants(userId, client);
    if (grants.some((g) => g.scope.type === 'SYSTEM')) return true;
    if (
      grants.some(
        (g) => g.scope.type === 'ORGANIZATION' && g.scope.id === organizationId,
      )
    )
      return true;
    const ids = (type: string) =>
      grants
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
}
