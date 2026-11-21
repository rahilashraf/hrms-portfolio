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
import type { EmployeeWorkflowKind } from '../generated/prisma/client.js';
import type { OnboardingClient } from './onboarding-common.js';
import { permissionFamily } from './onboarding-domain.js';

export const ONBOARDING_PERMISSIONS = [
  'onboarding.read',
  'onboarding.manage',
  'offboarding.read',
  'offboarding.manage',
  'onboarding.template.manage',
] as const;
export type OnboardingPermission = (typeof ONBOARDING_PERMISSIONS)[number];

/** How much of a workflow a user sees. */
export type WorkflowView = 'HR' | 'EMPLOYEE' | 'TASK_OWNER';

export const ASSIGNMENT_CONTEXT_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      status: true,
      archivedAt: true,
      person: {
        select: {
          firstName: true,
          lastName: true,
          preferredName: true,
          user: { select: { id: true, status: true, archivedAt: true } },
        },
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
      department: { select: { id: true, name: true } },
      team: { select: { id: true, name: true } },
      workLocation: { select: { id: true, name: true } },
      organization: { select: { id: true, name: true, timezone: true } },
    },
  },
  manager: {
    select: {
      id: true,
      employee: {
        select: {
          id: true,
          person: {
            select: {
              firstName: true,
              lastName: true,
              preferredName: true,
              user: { select: { id: true, status: true, archivedAt: true } },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Onboarding / offboarding authorization. Workflow data is HR data: only onboarding.* (and,
 * for the more sensitive offboarding, offboarding.*) grants it, scoped through the
 * assignment's position — never employee.read, a reporting line, compensation, payroll,
 * benefits, performance or recruitment access.
 *
 * - onboarding.read / onboarding.manage, offboarding.read / offboarding.manage: assignment
 *   scope; managing never applies to one's own workflow.
 * - onboarding.template.manage: organization scope only (both kinds of templates).
 * - The employee reaches their own workflows (only their own tasks and progress; never an
 *   offboarding reason); a task owner reaches only the tasks assigned to them. A manager is a
 *   task owner only where a task was assigned to them.
 */
@Injectable()
export class OnboardingAccessService {
  /** Phase 18: the ONBOARDING module gate (onboarding and offboarding). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when onboarding / offboarding is disabled for the organization. */
  requireEnabled(
    organizationId: string,
    client: OnboardingClient = this.prisma,
  ) {
    return this.features.require(organizationId, 'ONBOARDING', client);
  }

  async grants(
    userId: string,
    client: OnboardingClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (ONBOARDING_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: OnboardingPermission,
    target: AuthorizationTarget,
  ) {
    return permissionIsGranted(grants, permission, target);
  }

  canInOrganization(
    grants: EffectiveGrant[],
    permission: OnboardingPermission,
    organizationId: string,
  ) {
    return this.can(grants, permission, {
      type: 'ORGANIZATION',
      organizationId,
    });
  }

  /** True when the grants hold `permission` at System scope (deployment-wide authority). */
  hasSystemGrant(grants: EffectiveGrant[], permission: OnboardingPermission) {
    return grants.some(
      (grant) =>
        grant.permission === permission && grant.scope.type === 'SYSTEM',
    );
  }

  /**
   * Security fix — who may own a workflow task (or a template task) of an organization: an
   * ACTIVE account connected to that organization, i.e. with a PLANNED or ACTIVE employment
   * assignment in one of its positions, or a current or upcoming (not revoked, not expired,
   * role not archived) organization role there; or the employee's own manager
   * (`managerUserId`), who may work in another organization. Callers allow any active account
   * only to actors holding the permission at System scope. Before this, any active account of
   * any organization could be named by its id, which gave it the task owner's view of the
   * workflow.
   */
  async isEligibleTaskOwner(
    userId: string,
    organizationId: string,
    {
      managerUserId = null,
      client = this.prisma,
    }: { managerUserId?: string | null; client?: OnboardingClient } = {},
  ): Promise<boolean> {
    const now = new Date();
    const count = await client.user.count({
      where: {
        id: userId,
        status: 'ACTIVE',
        archivedAt: null,
        OR: [
          ...(managerUserId && managerUserId === userId
            ? [{ id: userId }]
            : []),
          {
            person: {
              employee: {
                assignments: {
                  some: {
                    status: { in: ['PLANNED', 'ACTIVE'] },
                    position: { organizationId },
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
                organizationId,
                role: { archivedAt: null },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
            },
          },
        ],
      },
    });
    return count > 0;
  }

  /** An ACTIVE, non-archived account (what System-scope actors may name as a task owner). */
  async isActiveUser(userId: string, client: OnboardingClient = this.prisma) {
    return (
      (await client.user.count({
        where: { id: userId, status: 'ACTIVE', archivedAt: null },
      })) > 0
    );
  }

  async employeeIdOfUser(
    userId: string,
    client: OnboardingClient = this.prisma,
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

  /**
   * Batch 7A (Q4): an organization-level permission on a record looked up by id. No grant at
   * all reaching into the record's organization → the same 404 as a missing id; a caller who
   * works there but lacks this permission → 403.
   */
  async requireOrganizationRecord(
    userId: string | undefined,
    permission: OnboardingPermission,
    organizationId: string,
    notFound: string,
    client: OnboardingClient = this.prisma,
  ) {
    if (
      !userId ||
      !(await this.worksInOrganization(userId, organizationId, client))
    ) {
      throw new NotFoundException(notFound);
    }
    return this.requireOrganization(userId, permission, organizationId, client);
  }

  async requireOrganization(
    userId: string | undefined,
    permission: OnboardingPermission,
    organizationId: string,
    client: OnboardingClient = this.prisma,
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

  async assignmentContext(
    assignmentId: string,
    client: OnboardingClient = this.prisma,
    notFound = 'Employment assignment not found.',
  ) {
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      include: ASSIGNMENT_CONTEXT_INCLUDE,
    });
    if (!assignment) throw new NotFoundException(notFound);
    const target = (await positionTargets(client, [assignment.position])).get(
      assignment.position.id,
    )!;
    return { assignment, target };
  }

  /** read / manage of a kind on an assignment target, never managing one's own. */
  kindAccess(
    grants: EffectiveGrant[],
    kind: EmployeeWorkflowKind,
    target: AuthorizationTarget,
    isSelf: boolean,
  ) {
    const family = permissionFamily(kind);
    const canManage =
      !isSelf &&
      this.can(grants, `${family}.manage` as OnboardingPermission, target);
    const canRead =
      canManage ||
      (!isSelf &&
        this.can(grants, `${family}.read` as OnboardingPermission, target));
    return { canManage, canRead };
  }

  /** Who may start a workflow of this kind on the assignment (manage, not one's own). */
  async requireStart(
    userId: string,
    assignmentId: string,
    kind: EmployeeWorkflowKind,
    client: OnboardingClient = this.prisma,
    notFound = 'Employment assignment not found.',
  ) {
    const { assignment, target } = await this.assignmentContext(
      assignmentId,
      client,
      notFound,
    );
    const grants = await this.grants(userId, client);
    const isSelf =
      (await this.employeeIdOfUser(userId, client)) === assignment.employeeId;
    const access = this.kindAccess(grants, kind, target, isSelf);
    if (!access.canManage) {
      // Batch 7A (Q4): another organization's record reads as missing.
      if (
        !isSelf &&
        !(await this.worksInOrganization(userId, target.organizationId, client))
      ) {
        throw new NotFoundException(notFound);
      }
      if (isSelf) {
        throw new ForbiddenException(
          domainError(
            403,
            'WORKFLOW_SELF_MANAGEMENT',
            'You cannot manage your own onboarding or offboarding.',
          ),
        );
      }
      throw new ForbiddenException(
        `Missing permission ${permissionFamily(kind)}.manage for the assignment.`,
      );
    }
    await this.requireEnabled(target.organizationId, client);
    return { assignment, target, grants };
  }

  /** The viewer's relation to a workflow: HR (read/manage), the employee, or a task owner. */
  async workflowAccess(
    userId: string,
    workflow: {
      id: string;
      kind: EmployeeWorkflowKind;
      employeeId: string;
      employmentAssignmentId: string;
    },
    client: OnboardingClient = this.prisma,
  ) {
    const { assignment, target } = await this.assignmentContext(
      workflow.employmentAssignmentId,
      client,
    );
    const grants = await this.grants(userId, client);
    const isSelf =
      (await this.employeeIdOfUser(userId, client)) === workflow.employeeId;
    const { canManage, canRead } = this.kindAccess(
      grants,
      workflow.kind,
      target,
      isSelf,
    );
    const ownsTasks =
      (await client.employeeWorkflowTask.count({
        where: { workflowId: workflow.id, ownerUserId: userId },
      })) > 0;
    const view: WorkflowView | null = canRead
      ? 'HR'
      : isSelf
        ? 'EMPLOYEE'
        : ownsTasks
          ? 'TASK_OWNER'
          : null;
    // Phase 18: whoever reaches the workflow (HR, the employee, a task owner) is refused
    // while the module is off; list callers leave disabled organizations out beforehand.
    if (view) await this.requireEnabled(target.organizationId, client);
    return {
      assignment,
      target,
      grants,
      isSelf,
      canManage,
      canRead,
      ownsTasks,
      view,
    };
  }

  async requireWorkflowView(
    userId: string,
    workflow: {
      id: string;
      kind: EmployeeWorkflowKind;
      employeeId: string;
      employmentAssignmentId: string;
    },
    client: OnboardingClient = this.prisma,
  ) {
    const access = await this.workflowAccess(userId, workflow, client);
    if (!access.view) throw new NotFoundException('Workflow not found.');
    return { ...access, view: access.view };
  }

  /** Organizations reachable through any onboarding/offboarding grant, with UI action flags. */
  async organizations(userId: string) {
    const grants = await this.grants(userId);
    if (grants.length === 0) return { items: [] };
    const disabled = await this.features.disabledOrganizations('ONBOARDING');
    const rows = await this.prisma.organization.findMany({
      where: { archivedAt: null, id: { notIn: [...disabled] } },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) {
      if (!(await this.hasAnyInOrganization(row.id, grants))) continue;
      const onboardingGrants = grants.filter(
        (g) =>
          g.permission === 'onboarding.read' ||
          g.permission === 'onboarding.manage',
      );
      const offboardingGrants = grants.filter((g) =>
        g.permission.startsWith('offboarding.'),
      );
      items.push({
        ...row,
        actions: {
          // Batch 7A: importing form responses needs organization-level manage of a kind (and
          // completes only those kinds).
          canImportOnboarding: this.canInOrganization(
            grants,
            'onboarding.manage',
            row.id,
          ),
          canImportOffboarding: this.canInOrganization(
            grants,
            'offboarding.manage',
            row.id,
          ),
          canManageTemplates: this.canInOrganization(
            grants,
            'onboarding.template.manage',
            row.id,
          ),
          onboarding: await this.hasAnyInOrganization(row.id, onboardingGrants),
          offboarding: await this.hasAnyInOrganization(
            row.id,
            offboardingGrants,
          ),
        },
      });
    }
    return { items };
  }

  /** Batch 7A (Q4): any effective grant (of any module) reaching into the organization. */
  async worksInOrganization(
    userId: string,
    organizationId: string,
    client: OnboardingClient = this.prisma,
  ) {
    return this.hasAnyInOrganization(
      organizationId,
      await this.authorization.effectiveGrants(userId, new Date(), client),
      client,
    );
  }

  async hasAnyInOrganization(
    organizationId: string,
    grants: EffectiveGrant[],
    client: OnboardingClient = this.prisma,
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
}
