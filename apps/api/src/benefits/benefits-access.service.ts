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
import type { BenefitsClient } from './benefits-common.js';

/** Batch 7C: plain permission refusals carry a domain code (clients tell them apart). */
export const permissionRequired = (message: string) =>
  new ForbiddenException(
    domainError(403, 'BENEFIT_PERMISSION_REQUIRED', message),
  );

export const BENEFIT_PERMISSIONS = [
  'benefit.read',
  'benefit.manage',
  'benefit.plan.manage',
] as const;
export type BenefitPermission = (typeof BENEFIT_PERMISSIONS)[number];

export const BENEFIT_ASSIGNMENT_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      hireDate: true,
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
      workLocation: { select: { timezone: true } },
      organization: {
        select: { id: true, name: true, code: true, timezone: true },
      },
    },
  },
} as const;

/**
 * Benefits authorization. Elections and dependents are sensitive: only the benefit.*
 * permissions grant access — benefit.read/manage scoped through the sponsoring assignment's
 * position like every assignment-level permission, benefit.plan.manage only at organization (or
 * SYSTEM) scope. employee.*, compensation.*, payroll.* and managing someone never imply it. An
 * employee reads (only reads) their own benefits through the self-service routes.
 */
@Injectable()
export class BenefitsAccessService {
  /** Phase 18: the BENEFITS module gate (every funnel below uses it). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when Benefits is disabled for the organization. */
  requireEnabled(organizationId: string, client: BenefitsClient = this.prisma) {
    return this.features.require(organizationId, 'BENEFITS', client);
  }

  /** Organizations (ids) where Benefits is disabled: for multi-organization lists. */
  async disabledOrganizations(client: BenefitsClient = this.prisma) {
    return [...(await this.features.disabledOrganizations('BENEFITS', client))];
  }

  /**
   * Employee-level self-service (dependents): refused when Benefits is disabled in every
   * organization the employee works in.
   */
  requireEnabledForEmployee(
    employeeId: string,
    client: BenefitsClient = this.prisma,
  ) {
    return this.features.requireForEmployee(employeeId, 'BENEFITS', client);
  }

  async grants(
    userId: string,
    client: BenefitsClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (BENEFIT_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: BenefitPermission,
    target: AuthorizationTarget,
  ) {
    return permissionIsGranted(grants, permission, target);
  }

  /** The Employee linked to a user (not archived), if any. */
  async employeeIdOfUser(userId: string, client: BenefitsClient = this.prisma) {
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

  async assignmentContext(
    assignmentId: string,
    client: BenefitsClient = this.prisma,
    notFound = 'Employment assignment not found',
  ) {
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      include: BENEFIT_ASSIGNMENT_INCLUDE,
    });
    if (!assignment) throw new NotFoundException(notFound);
    const target = (await positionTargets(client, [assignment.position])).get(
      assignment.position.id,
    )!;
    return { assignment, target };
  }

  /** benefit.manage on the assignment, and never on one's own benefits. */
  async requireManage(
    userId: string,
    assignmentId: string,
    client: BenefitsClient = this.prisma,
    /** Batch 7C (B1): what a caller outside the organization is told. */
    notFound = 'Employment assignment not found',
  ) {
    const context = await this.assignmentContext(
      assignmentId,
      client,
      notFound,
    );
    const grants = await this.grants(userId, client);
    if (!this.can(grants, 'benefit.manage', context.target)) {
      await this.notFoundOutside(
        userId,
        context.target.organizationId,
        notFound,
        client,
      );
      throw permissionRequired(
        'Missing permission benefit.manage for the assignment.',
      );
    }
    if (
      (await this.employeeIdOfUser(userId, client)) ===
      context.assignment.employeeId
    ) {
      throw new ForbiddenException(
        domainError(
          403,
          'BENEFIT_SELF_MANAGEMENT',
          'You cannot change your own benefits.',
        ),
      );
    }
    await this.requireEnabled(context.target.organizationId, client);
    return { ...context, grants };
  }

  /** benefit.read (or .manage) on the assignment. Self access goes through /benefits/me. */
  async requireRead(
    userId: string,
    assignmentId: string,
    client: BenefitsClient = this.prisma,
  ) {
    const context = await this.assignmentContext(assignmentId, client);
    const grants = await this.grants(userId, client);
    if (
      !this.can(grants, 'benefit.read', context.target) &&
      !this.can(grants, 'benefit.manage', context.target)
    ) {
      await this.notFoundOutside(
        userId,
        context.target.organizationId,
        'Employment assignment not found',
        client,
      );
      throw permissionRequired(
        'Missing permission benefit.read for the assignment.',
      );
    }
    const isSelf =
      (await this.employeeIdOfUser(userId, client)) ===
      context.assignment.employeeId;
    await this.requireEnabled(context.target.organizationId, client);
    return {
      ...context,
      grants,
      canManage: !isSelf && this.can(grants, 'benefit.manage', context.target),
    };
  }

  /** Which of an employee's assignments the user can read or manage benefits through. */
  async employeeAccess(
    userId: string,
    employeeId: string,
    client: BenefitsClient = this.prisma,
  ) {
    const assignments = await client.employmentAssignment.findMany({
      where: { employeeId },
      include: BENEFIT_ASSIGNMENT_INCLUDE,
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }],
    });
    if (assignments.length === 0) {
      throw new NotFoundException('Employee not found.');
    }
    const targets = await positionTargets(
      client,
      assignments.map((assignment) => assignment.position),
    );
    const grants = await this.grants(userId, client);
    const isSelf = (await this.employeeIdOfUser(userId, client)) === employeeId;
    const all = assignments.map((assignment) => {
      const target = targets.get(assignment.position.id)!;
      const canManage = !isSelf && this.can(grants, 'benefit.manage', target);
      return {
        assignment,
        target,
        canRead:
          canManage ||
          this.can(grants, 'benefit.read', target) ||
          this.can(grants, 'benefit.manage', target),
        canManage,
      };
    });
    // Phase 18: assignments in organizations with Benefits disabled are left out.
    const disabled = await this.features.disabledAmong(
      'BENEFITS',
      all.map((row) => row.target.organizationId),
      client,
    );
    const rows = all.filter((row) => !disabled.has(row.target.organizationId));
    if (!rows.some((row) => row.canRead)) {
      if (all.some((row) => row.canRead)) throw featureDisabled('BENEFITS');
      // Batch 7C (B1): an employee of organizations the caller has nothing to do with reads as
      // missing; within them, the permission is what is missing.
      if (!isSelf) {
        let works = false;
        for (const organizationId of new Set(
          all.map((row) => row.target.organizationId),
        )) {
          if (await this.worksInOrganization(userId, organizationId, client)) {
            works = true;
            break;
          }
        }
        if (!works) throw new NotFoundException('Employee not found.');
      }
      throw permissionRequired(
        'Missing permission benefit.read for the employee.',
      );
    }
    return { assignments: rows, isSelf };
  }

  /** benefit.plan.manage at the organization itself (plan configuration). */
  async requirePlanManage(
    userId: string | undefined,
    organizationId: string,
    client: BenefitsClient = this.prisma,
    /** Batch 7C (B1): for records looked up by id — 404 outside the organization. */
    notFound?: string,
  ) {
    const grants = userId ? await this.grants(userId, client) : [];
    if (
      !this.can(grants, 'benefit.plan.manage', {
        type: 'ORGANIZATION',
        organizationId,
      })
    ) {
      if (notFound)
        await this.notFoundOutside(userId, organizationId, notFound, client);
      throw permissionRequired(
        'Missing permission benefit.plan.manage for the organization.',
      );
    }
    await this.requireEnabled(organizationId, client);
  }

  /** Reading an organization's plan catalogue: any benefit permission reaching into it. */
  async requirePlanRead(
    userId: string,
    organizationId: string,
    client: BenefitsClient = this.prisma,
    notFound?: string,
  ) {
    if (!(await this.hasAnyInOrganization(userId, organizationId, client))) {
      if (notFound)
        await this.notFoundOutside(userId, organizationId, notFound, client);
      throw permissionRequired(
        'Missing benefit permissions for the organization.',
      );
    }
    await this.requireEnabled(organizationId, client);
  }

  /**
   * Batch 7C (B1) — as in 7A/7B: a caller with nothing in a record's organization (no grant of
   * any module reaching it, no employment there) is told the record does not exist, never that
   * it exists elsewhere. Within the organization the missing permission is reported (403).
   */
  async notFoundOutside(
    userId: string | undefined,
    organizationId: string,
    notFound: string,
    client: BenefitsClient = this.prisma,
  ) {
    if (
      !userId ||
      !(await this.worksInOrganization(userId, organizationId, client))
    )
      throw new NotFoundException(notFound);
  }

  async worksInOrganization(
    userId: string,
    organizationId: string,
    client: BenefitsClient = this.prisma,
  ) {
    if (
      await this.reaches(
        await this.authorization.effectiveGrants(userId, new Date(), client),
        organizationId,
        client,
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

  async hasAnyInOrganization(
    userId: string,
    organizationId: string,
    client: BenefitsClient = this.prisma,
  ) {
    return this.reaches(
      await this.grants(userId, client),
      organizationId,
      client,
    );
  }

  /** Whether any of the grants reaches into the organization (any scope within it). */
  private async reaches(
    grants: EffectiveGrant[],
    organizationId: string,
    client: BenefitsClient,
  ) {
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
    const units = ids('ORGANIZATIONAL_UNIT');
    const departments = ids('DEPARTMENT');
    const teams = ids('TEAM');
    if (
      units.length &&
      (await client.organizationalUnit.count({
        where: { id: { in: units }, organizationId },
      }))
    )
      return true;
    if (
      departments.length &&
      (await client.department.count({
        where: { id: { in: departments }, organizationId },
      }))
    )
      return true;
    if (
      teams.length &&
      (await client.team.count({
        where: { id: { in: teams }, organizationId },
      }))
    )
      return true;
    return false;
  }

  /** Organizations reachable through any benefit grant, with UI action flags. */
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
      if (!(await this.hasAnyInOrganization(userId, row.id))) continue;
      items.push({
        ...row,
        actions: {
          canManagePlans: this.can(grants, 'benefit.plan.manage', {
            type: 'ORGANIZATION',
            organizationId: row.id,
          }),
        },
      });
    }
    return { items };
  }
}
