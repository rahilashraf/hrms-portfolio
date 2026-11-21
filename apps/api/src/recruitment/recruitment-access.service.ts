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
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { RecruitmentClient } from './recruitment-common.js';

export const RECRUITMENT_PERMISSIONS = [
  'recruitment.read',
  'recruitment.manage',
  'recruitment.offer.approve',
  'recruitment.hire',
  'recruitment.pipeline.manage',
  'recruitment.intake.manage',
] as const;
export type RecruitmentPermission = (typeof RECRUITMENT_PERMISSIONS)[number];

/** Permissions only meaningful at organization (or SYSTEM) scope. */
export type RecruitmentOrganizationPermission =
  | 'recruitment.pipeline.manage'
  | 'recruitment.intake.manage'
  | 'recruitment.read'
  | 'recruitment.manage';

/** How much of an application a user sees. */
export type ApplicationView = 'FULL' | 'HIRING_MANAGER' | 'INTERVIEWER';

export interface OpeningPlacement {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  hiringManagerEmployeeId: string | null;
}

export interface UserContext {
  userId: string;
  employeeId: string | null;
  personId: string | null;
  email: string | null;
}

export interface OpeningAccess {
  target: AuthorizationTarget;
  canRead: boolean;
  canManage: boolean;
  canApproveOffers: boolean;
  canHire: boolean;
  isHiringManager: boolean;
}

export const APPLICATION_ACCESS_INCLUDE = {
  candidate: true,
  opening: true,
} as const;

/**
 * Recruitment authorization. Candidate and hiring data is sensitive: only recruitment.*
 * grants it — never employee.read, a reporting line, compensation, payroll, benefits or
 * performance access.
 *
 * - recruitment.read / recruitment.manage / recruitment.offer.approve / recruitment.hire are
 *   scoped through the opening's own placement (team, department, unit or organization).
 * - recruitment.pipeline.manage (stages) and recruitment.intake.manage (external application
 *   sources) are organization-level.
 * - The opening's explicit hiring manager reads its pipeline and submitted feedback (never
 *   offers, screening or internal notes); an explicitly assigned interviewer sees only the
 *   candidate, the opening, the interviews they are on and their own feedback.
 * - Nobody reaches their own candidacy (internal candidates with recruitment access).
 * - Hire conversion additionally needs Core HR's employee.manage on the offered position, and
 *   compensation.manage to initialize compensation.
 */
@Injectable()
export class RecruitmentAccessService {
  /** Phase 18: the RECRUITMENT module gate (every organization-scoped funnel below uses it). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when Recruitment is disabled for the organization. */
  requireEnabled(
    organizationId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    return this.features.require(organizationId, 'RECRUITMENT', client);
  }

  /** Organizations (ids) where Recruitment is disabled: for multi-organization lists. */
  async disabledOrganizations(client: RecruitmentClient = this.prisma) {
    return [
      ...(await this.features.disabledOrganizations('RECRUITMENT', client)),
    ];
  }

  async grants(
    userId: string,
    client: RecruitmentClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (RECRUITMENT_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: RecruitmentPermission,
    target: AuthorizationTarget,
  ) {
    return permissionIsGranted(grants, permission, target);
  }

  canInOrganization(
    grants: EffectiveGrant[],
    permission: RecruitmentPermission,
    organizationId: string,
  ) {
    return this.can(grants, permission, {
      type: 'ORGANIZATION',
      organizationId,
    });
  }

  async userContext(
    userId: string,
    client: RecruitmentClient = this.prisma,
  ): Promise<UserContext> {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        personId: true,
        person: {
          select: { employee: { select: { id: true, archivedAt: true } } },
        },
      },
    });
    const employee = user?.person?.employee;
    return {
      userId,
      employeeId: employee && !employee.archivedAt ? employee.id : null,
      personId: user?.personId ?? null,
      email: user?.email.trim().toLowerCase() ?? null,
    };
  }

  /** The candidate is the user themselves (an internal candidate, or the same email/person). */
  isSelf(
    user: UserContext,
    candidate: {
      internalEmployeeId: string | null;
      normalizedEmail: string | null;
      personId: string | null;
    },
  ) {
    return Boolean(
      (user.employeeId && candidate.internalEmployeeId === user.employeeId) ||
      (user.email && candidate.normalizedEmail === user.email) ||
      (user.personId && candidate.personId === user.personId),
    );
  }

  async openingTargets(
    client: RecruitmentClient,
    openings: readonly OpeningPlacement[],
  ) {
    return positionTargets(client, openings);
  }

  async openingTarget(client: RecruitmentClient, opening: OpeningPlacement) {
    return (await positionTargets(client, [opening])).get(opening.id)!;
  }

  accessOf(
    grants: EffectiveGrant[],
    user: UserContext,
    opening: OpeningPlacement,
    target: AuthorizationTarget,
  ): OpeningAccess {
    const canManage = this.can(grants, 'recruitment.manage', target);
    return {
      target,
      canManage,
      canRead: canManage || this.can(grants, 'recruitment.read', target),
      canApproveOffers: this.can(grants, 'recruitment.offer.approve', target),
      canHire: this.can(grants, 'recruitment.hire', target),
      isHiringManager:
        user.employeeId !== null &&
        opening.hiringManagerEmployeeId === user.employeeId,
    };
  }

  async openingAccess(
    userId: string,
    opening: OpeningPlacement,
    client: RecruitmentClient = this.prisma,
  ) {
    const [grants, user, target] = await Promise.all([
      this.grants(userId, client),
      this.userContext(userId, client),
      this.openingTarget(client, opening),
    ]);
    return { ...this.accessOf(grants, user, opening, target), grants, user };
  }

  async requireOpening(
    userId: string,
    openingId: string,
    need: 'read' | 'manage',
    client: RecruitmentClient = this.prisma,
  ) {
    const opening = await client.jobOpening.findUnique({
      where: { id: openingId },
    });
    if (!opening) throw new NotFoundException('Job opening not found.');
    const access = await this.openingAccess(userId, opening, client);
    const allowed =
      need === 'manage'
        ? access.canManage
        : access.canRead || access.isHiringManager;
    if (!allowed) {
      // Unreadable openings are indistinguishable from missing ones.
      if (!access.canRead && !access.isHiringManager)
        throw new NotFoundException('Job opening not found.');
      throw new ForbiddenException(
        'Missing permission recruitment.manage for the opening.',
      );
    }
    await this.requireEnabled(opening.organizationId, client);
    return { opening, access };
  }

  /**
   * What a user may do on an application. FULL: recruitment.read/manage on the opening;
   * HIRING_MANAGER: the opening's hiring manager; INTERVIEWER: an active interviewer on one of
   * its interviews. Nobody reaches their own candidacy.
   */
  async applicationAccess(
    userId: string,
    applicationId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    const application = await client.recruitmentApplication.findUnique({
      where: { id: applicationId },
      include: APPLICATION_ACCESS_INCLUDE,
    });
    if (!application) throw new NotFoundException('Application not found.');
    const access = await this.openingAccess(
      userId,
      application.opening,
      client,
    );
    const isSelf = this.isSelf(access.user, application.candidate);
    const interviewerOn = isSelf
      ? []
      : (
          await client.recruitmentInterviewer.findMany({
            where: {
              userId,
              removedAt: null,
              interview: { applicationId },
            },
            select: { interviewId: true },
          })
        ).map((row) => row.interviewId);
    const view: ApplicationView | null = isSelf
      ? null
      : access.canRead
        ? 'FULL'
        : access.isHiringManager
          ? 'HIRING_MANAGER'
          : interviewerOn.length > 0
            ? 'INTERVIEWER'
            : null;
    // Phase 18: whoever reaches the application is refused while Recruitment is disabled.
    if (view) await this.requireEnabled(application.organizationId, client);
    return {
      application,
      ...access,
      isSelf,
      canManage: !isSelf && access.canManage,
      canApproveOffers: !isSelf && access.canApproveOffers,
      canHire: !isSelf && access.canHire,
      interviewerOn,
      view,
    };
  }

  async requireApplicationView(
    userId: string,
    applicationId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    const access = await this.applicationAccess(userId, applicationId, client);
    if (!access.view) {
      if (access.isSelf) {
        throw new ForbiddenException(
          domainError(
            403,
            'RECRUITMENT_SELF_ACCESS',
            'You cannot access your own candidacy.',
          ),
        );
      }
      throw new NotFoundException('Application not found.');
    }
    return { ...access, view: access.view };
  }

  async requireApplicationManage(
    userId: string,
    applicationId: string,
    client: RecruitmentClient = this.prisma,
    permission:
      | 'recruitment.manage'
      | 'recruitment.offer.approve'
      | 'recruitment.hire' = 'recruitment.manage',
  ) {
    const access = await this.requireApplicationView(
      userId,
      applicationId,
      client,
    );
    const allowed =
      permission === 'recruitment.manage'
        ? access.canManage
        : permission === 'recruitment.offer.approve'
          ? access.canApproveOffers
          : access.canHire;
    if (!allowed) {
      throw new ForbiddenException(
        `Missing permission ${permission} for the application.`,
      );
    }
    return access;
  }

  /** Every opening of the organization the user reads (with access flags). */
  async visibleOpenings(
    userId: string,
    organizationId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    const [grants, user] = await Promise.all([
      this.grants(userId, client),
      this.userContext(userId, client),
    ]);
    if (grants.length === 0 && !user.employeeId)
      return { grants, user, items: [] };
    const openings = await client.jobOpening.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const targets = await this.openingTargets(client, openings);
    const items = openings
      .map((opening) => ({
        opening,
        access: this.accessOf(grants, user, opening, targets.get(opening.id)!),
      }))
      .filter(({ access }) => access.canRead || access.isHiringManager);
    if (items.length > 0) await this.requireEnabled(organizationId, client);
    return { grants, user, items };
  }

  async requireOrganization(
    userId: string | undefined,
    permission: RecruitmentOrganizationPermission,
    organizationId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    const grants = userId ? await this.grants(userId, client) : [];
    if (!this.canInOrganization(grants, permission, organizationId)) {
      throw new ForbiddenException(
        `Missing permission ${permission} for the organization.`,
      );
    }
    await this.requireEnabled(organizationId, client);
    return grants;
  }

  /**
   * Batch 7A (Q4): an organization-level permission on a record looked up by id. A caller with
   * no grant at all reaching into the record's organization gets the same 404 as for a
   * missing id (no cross-organization existence oracle, as Phase 19 A3 and Batch 4F); a caller
   * who works there but lacks the permission keeps the 403.
   */
  async requireOrganizationRecord(
    userId: string | undefined,
    permission: RecruitmentOrganizationPermission,
    organizationId: string,
    notFound: string,
    client: RecruitmentClient = this.prisma,
  ) {
    // Any grant of any module counts as working there (as onboarding's rule), so a Core HR
    // user of the organization keeps the 403.
    if (
      !userId ||
      !(await this.hasAnyInOrganization(
        userId,
        organizationId,
        client,
        await this.authorization.effectiveGrants(userId, new Date(), client),
      ))
    ) {
      throw new NotFoundException(notFound);
    }
    return this.requireOrganization(userId, permission, organizationId, client);
  }

  /**
   * Batch 7A (D4): the permission at some scope inside the organization (a team recruiter may
   * create a team opening). Checked before input ids are validated; the exact placement check
   * still follows.
   */
  async requireAnyInOrganization(
    userId: string,
    permission: RecruitmentOrganizationPermission,
    organizationId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    const grants = (await this.grants(userId, client)).filter(
      (g) => g.permission === permission,
    );
    if (
      !(await this.hasAnyInOrganization(userId, organizationId, client, grants))
    ) {
      throw new ForbiddenException(
        `Missing permission ${permission} for the organization.`,
      );
    }
  }

  /** Any recruitment permission reaching into the organization. */
  async hasAnyInOrganization(
    userId: string,
    organizationId: string,
    client: RecruitmentClient = this.prisma,
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

  /** Reading configuration (stages) and option lists: any recruitment grant, or hiring manager. */
  async requireConfigurationRead(
    userId: string,
    organizationId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    if (await this.hasAnyInOrganization(userId, organizationId, client))
      return this.requireEnabled(organizationId, client);
    const user = await this.userContext(userId, client);
    if (
      user.employeeId &&
      (await client.jobOpening.count({
        where: { organizationId, hiringManagerEmployeeId: user.employeeId },
      })) > 0
    ) {
      return this.requireEnabled(organizationId, client);
    }
    throw new ForbiddenException(
      'Missing recruitment permissions for the organization.',
    );
  }

  /** Organizations reachable through any recruitment grant, with UI action flags. */
  async organizations(userId: string) {
    const grants = await this.grants(userId);
    const user = await this.userContext(userId);
    const managed = user.employeeId
      ? new Set(
          (
            await this.prisma.jobOpening.findMany({
              where: { hiringManagerEmployeeId: user.employeeId },
              select: { organizationId: true },
            })
          ).map((row) => row.organizationId),
        )
      : new Set<string>();
    if (grants.length === 0 && managed.size === 0) return { items: [] };
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
        !managed.has(row.id) &&
        !(await this.hasAnyInOrganization(userId, row.id, this.prisma, grants))
      )
        continue;
      items.push({
        ...row,
        actions: {
          canManagePipeline: this.canInOrganization(
            grants,
            'recruitment.pipeline.manage',
            row.id,
          ),
          canManageIntake: this.canInOrganization(
            grants,
            'recruitment.intake.manage',
            row.id,
          ),
          canReadAllCandidates:
            this.canInOrganization(grants, 'recruitment.read', row.id) ||
            this.canInOrganization(grants, 'recruitment.manage', row.id),
          canManageCandidates: this.canInOrganization(
            grants,
            'recruitment.manage',
            row.id,
          ),
          canCreateOpenings: grants.some(
            (grant) => grant.permission === 'recruitment.manage',
          ),
        },
      });
    }
    return { items };
  }
}
