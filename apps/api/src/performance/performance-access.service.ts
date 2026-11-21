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
import { domainError, positionTargets } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { featureDisabled } from '../features/features-domain.js';
import type { PerformanceClient } from './performance-common.js';

export const PERFORMANCE_PERMISSIONS = [
  'performance.read',
  'performance.manage',
  'performance.template.manage',
  'performance.cycle.manage',
  'performance.evidence.manage',
] as const;
export type PerformancePermission = (typeof PERFORMANCE_PERMISSIONS)[number];

/** Permissions that are only meaningful at organization (or SYSTEM) scope. */
export type PerformanceOrganizationPermission =
  | 'performance.template.manage'
  | 'performance.cycle.manage'
  | 'performance.evidence.manage';

export const PERFORMANCE_ASSIGNMENT_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      status: true,
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
      department: { select: { organizationalUnitId: true } },
      organization: {
        select: { id: true, name: true, code: true, timezone: true },
      },
    },
  },
} as const;

export interface ReviewAccessRow {
  employeeId: string;
  employmentAssignmentId: string;
  reviewerEmployeeId: string | null;
}

/**
 * Performance authorization. Performance data is sensitive HR data: only performance.*
 * grants it — never employee.read, compensation, payroll, benefits or a reporting line.
 *
 * - performance.read / performance.manage are scoped through the reviewed assignment's
 *   position like every assignment-level permission (manage: reviewer reassignment, HR
 *   review, reopening, finalization, corrections, goals; never one's own).
 * - performance.template.manage, performance.cycle.manage and performance.evidence.manage are
 *   organization-level (ORGANIZATION or SYSTEM scope only).
 * - A reviewer reaches a review only by being its current reviewer (an explicit assignment
 *   recorded on the review), not by being someone's manager now or before.
 * - An employee reaches their own reviews, goals and evidence through /performance/me.
 */
@Injectable()
export class PerformanceAccessService {
  /** Phase 18: the PERFORMANCE module gate (every organization-scoped funnel below uses it). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when Performance is disabled for the organization. */
  requireEnabled(
    organizationId: string,
    client: PerformanceClient = this.prisma,
  ) {
    return this.features.require(organizationId, 'PERFORMANCE', client);
  }

  /** Organizations (ids) where Performance is disabled: for multi-organization lists. */
  async disabledOrganizations(client: PerformanceClient = this.prisma) {
    return [
      ...(await this.features.disabledOrganizations('PERFORMANCE', client)),
    ];
  }

  async grants(
    userId: string,
    client: PerformanceClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (PERFORMANCE_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: PerformancePermission,
    target: AuthorizationTarget,
  ) {
    return permissionIsGranted(grants, permission, target);
  }

  canInOrganization(
    grants: EffectiveGrant[],
    permission: PerformanceOrganizationPermission,
    organizationId: string,
  ) {
    return this.can(grants, permission, {
      type: 'ORGANIZATION',
      organizationId,
    });
  }

  /** The Employee linked to a user (not archived), if any. */
  async employeeIdOfUser(
    userId: string,
    client: PerformanceClient = this.prisma,
  ) {
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

  async requireEmployee(
    userId: string,
    client: PerformanceClient = this.prisma,
  ) {
    const employeeId = await this.employeeIdOfUser(userId, client);
    if (!employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee.',
        ),
      );
    }
    return employeeId;
  }

  async assignmentContext(
    assignmentId: string,
    client: PerformanceClient = this.prisma,
  ) {
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      include: PERFORMANCE_ASSIGNMENT_INCLUDE,
    });
    if (!assignment)
      throw new NotFoundException('Employment assignment not found');
    const target = (await positionTargets(client, [assignment.position])).get(
      assignment.position.id,
    )!;
    return { assignment, target };
  }

  /**
   * Batch 7B (D8): the user works in the organization — any effective grant (of any module)
   * reaching into it, or an employment (not cancelled) there.
   */
  async worksInOrganization(
    userId: string,
    organizationId: string,
    client: PerformanceClient = this.prisma,
  ) {
    if (
      await this.hasAnyInOrganization(
        userId,
        organizationId,
        client,
        await this.authorization.effectiveGrants(userId, new Date(), client),
      )
    )
      return true;
    const employeeId = await this.employeeIdOfUser(userId, client);
    return (
      employeeId !== null &&
      (await client.employmentAssignment.count({
        where: {
          employeeId,
          status: { not: 'CANCELLED' },
          position: { organizationId },
        },
      })) > 0
    );
  }

  /**
   * Batch 7B (D8): a caller with no grant at all in a record's organization gets the same 404
   * as for a missing id (no cross-organization existence oracle, as Batch 7A Q4).
   */
  async notFoundOutside(
    userId: string | undefined,
    organizationId: string,
    notFound: string,
    client: PerformanceClient = this.prisma,
  ) {
    if (
      !userId ||
      !(await this.worksInOrganization(userId, organizationId, client))
    )
      throw new NotFoundException(notFound);
  }

  /** An organization-level permission on a record looked up by id (404 outside, 403 within). */
  async requireOrganizationRecord(
    userId: string | undefined,
    permission: PerformanceOrganizationPermission,
    organizationId: string,
    notFound: string,
    client: PerformanceClient = this.prisma,
  ) {
    await this.notFoundOutside(userId, organizationId, notFound, client);
    return this.requireOrganization(userId, permission, organizationId, client);
  }

  /** An organization-level permission at the organization itself. */
  async requireOrganization(
    userId: string | undefined,
    permission: PerformanceOrganizationPermission,
    organizationId: string,
    client: PerformanceClient = this.prisma,
  ) {
    const grants = userId ? await this.grants(userId, client) : [];
    if (!this.canInOrganization(grants, permission, organizationId)) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          `Missing permission ${permission} for the organization.`,
        ),
      );
    }
    await this.requireEnabled(organizationId, client);
    return grants;
  }

  /**
   * What a user may do on a review (or a goal of the same assignment): read and manage through
   * performance.* on the assignment, act as reviewer when they are its current reviewer, act as
   * the employee when it is theirs. Managing never applies to one's own review.
   */
  async reviewAccess(
    userId: string,
    row: ReviewAccessRow,
    client: PerformanceClient = this.prisma,
    /** Phase 18: true when the caller already gated the organization (list loops). */
    gated = false,
  ) {
    const { target, assignment } = await this.assignmentContext(
      row.employmentAssignmentId,
      client,
    );
    const grants = await this.grants(userId, client);
    const employeeId = await this.employeeIdOfUser(userId, client);
    const isSelf = employeeId !== null && employeeId === row.employeeId;
    const isReviewer =
      employeeId !== null && employeeId === row.reviewerEmployeeId;
    const canManage = !isSelf && this.can(grants, 'performance.manage', target);
    const canRead =
      canManage ||
      (!isSelf && this.can(grants, 'performance.read', target)) ||
      isReviewer;
    // Phase 18: whoever reaches the review (HR, reviewer, the employee) is refused while
    // Performance is disabled for its organization.
    if (!gated && (canRead || isSelf))
      await this.requireEnabled(target.organizationId, client);
    return {
      target,
      assignment,
      grants,
      employeeId,
      isSelf,
      isReviewer,
      canManage,
      canRead,
    };
  }

  async requireReviewRead(
    userId: string,
    row: ReviewAccessRow,
    client?: PerformanceClient,
  ) {
    const access = await this.reviewAccess(userId, row, client);
    if (!access.canRead && !access.isSelf) {
      if (!access.isReviewer)
        await this.notFoundOutside(
          userId,
          access.target.organizationId,
          'Review not found.',
          client,
        );
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing permission performance.read for the review.',
        ),
      );
    }
    return access;
  }

  async requireReviewManage(
    userId: string,
    row: ReviewAccessRow,
    client?: PerformanceClient,
  ) {
    const access = await this.reviewAccess(userId, row, client);
    if (!access.canManage) {
      if (!access.isSelf && !access.isReviewer && !access.canRead)
        await this.notFoundOutside(
          userId,
          access.target.organizationId,
          'Review not found.',
          client,
        );
      if (access.isSelf) {
        throw new ForbiddenException(
          domainError(
            403,
            'PERFORMANCE_SELF_MANAGEMENT',
            'You cannot manage your own performance records.',
          ),
        );
      }
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing permission performance.manage for the review.',
        ),
      );
    }
    return access;
  }

  /** Which of an employee's assignments the user can read or manage performance through. */
  async employeeAccess(
    userId: string,
    employeeId: string,
    client: PerformanceClient = this.prisma,
  ) {
    const assignments = await client.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      include: PERFORMANCE_ASSIGNMENT_INCLUDE,
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }],
    });
    if (assignments.length === 0)
      throw new NotFoundException('Employee not found.');
    const targets = await positionTargets(
      client,
      assignments.map((assignment) => assignment.position),
    );
    const grants = await this.grants(userId, client);
    const isSelf = (await this.employeeIdOfUser(userId, client)) === employeeId;
    const all = assignments.map((assignment) => {
      const target = targets.get(assignment.position.id)!;
      const canManage =
        !isSelf && this.can(grants, 'performance.manage', target);
      return {
        assignment,
        target,
        canManage,
        canRead:
          canManage ||
          (!isSelf && this.can(grants, 'performance.read', target)),
      };
    });
    // Phase 18: assignments in organizations with Performance disabled are left out; when
    // that leaves nothing the user could otherwise reach, the module is reported disabled.
    const disabled = await this.features.disabledAmong(
      'PERFORMANCE',
      all.map((row) => row.target.organizationId),
      client,
    );
    const rows = all.filter((row) => !disabled.has(row.target.organizationId));
    if (
      disabled.size > 0 &&
      (isSelf
        ? rows.length === 0
        : !rows.some((row) => row.canRead) && all.some((row) => row.canRead))
    )
      throw featureDisabled('PERFORMANCE');
    return { assignments: rows, isSelf, grants };
  }

  /**
   * The employee's assignments the user currently reviews (a review being written in an open
   * cycle): the reviewer reads goals and evidence of those assignments to write the review.
   */
  async reviewingAssignments(
    userId: string,
    employeeId: string,
    client: PerformanceClient = this.prisma,
  ) {
    const reviewerEmployeeId = await this.employeeIdOfUser(userId, client);
    if (!reviewerEmployeeId) return [];
    const rows = await client.performanceReview.findMany({
      where: {
        employeeId,
        reviewerEmployeeId,
        status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'] },
        cycle: { status: 'OPEN' },
        organizationId: { notIn: await this.disabledOrganizations(client) },
      },
      select: { employmentAssignmentId: true, organizationId: true },
    });
    return rows;
  }

  /** Any performance permission reaching into the organization (reading its configuration). */
  async hasAnyInOrganization(
    userId: string,
    organizationId: string,
    client: PerformanceClient = this.prisma,
    grantsIn?: EffectiveGrant[],
  ) {
    const grants = grantsIn ?? (await this.grants(userId, client));
    if (grants.some((g) => g.scope.type === 'SYSTEM')) return true;
    if (
      grants.some(
        (g) => g.scope.type === 'ORGANIZATION' && g.scope.id === organizationId,
      )
    ) {
      return true;
    }
    const ids = (type: string) =>
      grants
        .filter((g) => g.scope.type === type)
        .map((g) => g.scope.id!)
        .filter(Boolean);
    const units = ids('ORGANIZATIONAL_UNIT');
    const departments = ids('DEPARTMENT');
    const teams = ids('TEAM');
    return (
      (units.length > 0 &&
        (await client.organizationalUnit.count({
          where: { id: { in: units }, organizationId },
        })) > 0) ||
      (departments.length > 0 &&
        (await client.department.count({
          where: { id: { in: departments }, organizationId },
        })) > 0) ||
      (teams.length > 0 &&
        (await client.team.count({
          where: { id: { in: teams }, organizationId },
        })) > 0)
    );
  }

  async requireConfigurationRead(
    userId: string,
    organizationId: string,
    client: PerformanceClient = this.prisma,
  ) {
    if (!(await this.hasAnyInOrganization(userId, organizationId, client))) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing performance permissions for the organization.',
        ),
      );
    }
    await this.requireEnabled(organizationId, client);
  }

  /** Organizations reachable through any performance grant, with UI action flags. */
  async organizations(userId: string) {
    const grants = await this.grants(userId);
    if (grants.length === 0) return { items: [] };
    const rows = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        id: { notIn: await this.disabledOrganizations() },
      },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) {
      if (
        !(await this.hasAnyInOrganization(userId, row.id, this.prisma, grants))
      )
        continue;
      items.push({
        ...row,
        actions: {
          canManageTemplates: this.canInOrganization(
            grants,
            'performance.template.manage',
            row.id,
          ),
          canManageCycles: this.canInOrganization(
            grants,
            'performance.cycle.manage',
            row.id,
          ),
          canManageEvidence: this.canInOrganization(
            grants,
            'performance.evidence.manage',
            row.id,
          ),
        },
      });
    }
    return { items };
  }
}
