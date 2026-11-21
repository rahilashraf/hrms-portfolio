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
import type { DocumentConfidentiality } from '../generated/prisma/client.js';
import type { DocumentsClient } from './documents-common.js';
import { clearanceOf, levelWithin } from './documents-domain.js';

export const DOCUMENT_PERMISSIONS = [
  'document.read',
  'document.confidential.read',
  'document.restricted.read',
  'document.manage',
  'document.type.manage',
  'document.policy.manage',
] as const;
export type DocumentPermission = (typeof DOCUMENT_PERMISSIONS)[number];

/** What a user may do with one employee's records in one organization. */
export interface EmployeeDocumentAccess {
  employeeId: string;
  organizationId: string;
  isSelf: boolean;
  /** Highest confidentiality level readable through grants (-1 none). Never for oneself. */
  clearance: number;
  canManage: boolean;
  targets: AuthorizationTarget[];
}

/**
 * Documents authorization. Employee records may hold highly sensitive information: only the
 * document.* permissions grant access — never employee.read, a reporting line, payroll,
 * compensation, recruitment or performance access.
 *
 * - document.read / document.confidential.read / document.restricted.read are scoped through
 *   the employee's assignments in the document's organization and reach, respectively,
 *   EMPLOYEE_VISIBLE + MANAGER_VISIBLE, + HR_ONLY, + RESTRICTED documents.
 * - document.manage (same scope) creates, versions, re-classifies and archives documents up
 *   to the user's read clearance; never one's own records.
 * - document.type.manage (types, requirements) and document.policy.manage (policies) are
 *   organization-level.
 * - An employee reads their own EMPLOYEE_VISIBLE documents and the policies addressed to
 *   them through self-service, and provides documents of employee-provided types.
 */
@Injectable()
export class DocumentsAccessService {
  /** Phase 18: the DOCUMENTS module gate (every organization-scoped funnel below uses it). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when Documents is disabled for the organization. */
  requireEnabled(
    organizationId: string,
    client: DocumentsClient = this.prisma,
  ) {
    return this.features.require(organizationId, 'DOCUMENTS', client);
  }

  async grants(
    userId: string,
    client: DocumentsClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (DOCUMENT_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
  }

  canInOrganization(
    grants: EffectiveGrant[],
    permission: DocumentPermission,
    organizationId: string,
  ) {
    return permissionIsGranted(grants, permission, {
      type: 'ORGANIZATION',
      organizationId,
    });
  }

  async requireOrganization(
    userId: string | undefined,
    permission: DocumentPermission,
    organizationId: string,
    client: DocumentsClient = this.prisma,
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

  async employeeIdOfUser(
    userId: string,
    client: DocumentsClient = this.prisma,
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

  /** Clearance from grants over a set of targets (any target granting a permission counts). */
  clearanceOver(
    grants: EffectiveGrant[],
    targets: readonly AuthorizationTarget[],
  ) {
    const held = new Set<string>();
    for (const permission of [
      'document.read',
      'document.confidential.read',
      'document.restricted.read',
      'document.manage',
    ] as const) {
      if (
        targets.some((target) =>
          permissionIsGranted(grants, permission, target),
        )
      )
        held.add(permission);
    }
    return {
      clearance: clearanceOf(held),
      canManage: held.has('document.manage'),
    };
  }

  /** The user's access to one employee's records in an organization. */
  async employeeAccess(
    userId: string,
    employeeId: string,
    organizationId: string,
    client: DocumentsClient = this.prisma,
    grantsIn?: EffectiveGrant[],
  ): Promise<EmployeeDocumentAccess> {
    const assignments = await client.employmentAssignment.findMany({
      where: {
        employeeId,
        status: { not: 'CANCELLED' },
        position: { organizationId },
      },
      select: {
        position: {
          select: {
            id: true,
            organizationId: true,
            organizationalUnitId: true,
            departmentId: true,
            teamId: true,
          },
        },
      },
    });
    const isSelf = (await this.employeeIdOfUser(userId, client)) === employeeId;
    // Phase 19: the module gate runs only once the caller is known to reach the employee
    // (self, or any clearance / manage over them), so a caller without access gets the
    // normal 404 / 403 rather than FEATURE_DISABLED (no existence oracle). Loop callers pass
    // grantsIn after gating the organization once (requireAnyInOrganization).
    const gate = async (access: EmployeeDocumentAccess) => {
      if (
        !grantsIn &&
        (access.isSelf || access.clearance >= 0 || access.canManage)
      )
        await this.requireEnabled(organizationId, client);
      return access;
    };
    if (assignments.length === 0)
      return gate({
        employeeId,
        organizationId,
        isSelf,
        clearance: -1,
        canManage: false,
        targets: [],
      });
    const targets = [
      ...(
        await positionTargets(
          client,
          assignments.map((a) => a.position),
        )
      ).values(),
    ];
    const grants = grantsIn ?? (await this.grants(userId, client));
    const { clearance, canManage } = this.clearanceOver(grants, targets);
    return gate({
      employeeId,
      organizationId,
      isSelf,
      clearance: isSelf ? -1 : clearance,
      canManage: !isSelf && canManage,
      targets,
    });
  }

  /** May the user read a document of this level (through grants, or as its EMPLOYEE_VISIBLE owner)? */
  canReadLevel(access: EmployeeDocumentAccess, level: DocumentConfidentiality) {
    return (
      levelWithin(level, access.clearance) ||
      (access.isSelf && level === 'EMPLOYEE_VISIBLE')
    );
  }

  /** Manage a document of this level: document.manage and clearance for the level, never oneself. */
  requireManageLevel(
    access: EmployeeDocumentAccess,
    level: DocumentConfidentiality,
  ) {
    if (access.isSelf) {
      throw new ForbiddenException(
        domainError(
          403,
          'DOCUMENT_SELF_MANAGEMENT',
          'You cannot manage your own employee records.',
        ),
      );
    }
    if (!access.canManage)
      throw new ForbiddenException(
        'Missing permission document.manage for the employee.',
      );
    if (!levelWithin(level, access.clearance)) {
      throw new ForbiddenException(
        domainError(
          403,
          'DOCUMENT_CLEARANCE_REQUIRED',
          `Managing ${level.toLowerCase().replace('_', ' ')} documents needs the matching read permission.`,
        ),
      );
    }
  }

  /** Organizations reachable through any document grant, with UI action flags. */
  async organizations(userId: string) {
    const grants = await this.grants(userId);
    if (grants.length === 0) return { items: [] };
    // Phase 18: organizations with Documents disabled are not offered.
    const disabled = await this.features.disabledOrganizations('DOCUMENTS');
    const rows = await this.prisma.organization.findMany({
      where: { archivedAt: null, id: { notIn: [...disabled] } },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) {
      if (!(await this.hasAnyInOrganization(row.id, grants))) continue;
      items.push({
        ...row,
        actions: {
          canManageTypes: this.canInOrganization(
            grants,
            'document.type.manage',
            row.id,
          ),
          canManagePolicies: this.canInOrganization(
            grants,
            'document.policy.manage',
            row.id,
          ),
          // Hints for the UI only: whether any record grant reaches into this organization.
          canReadRecords: await this.hasAnyInOrganization(
            row.id,
            grants.filter((g) =>
              [
                'document.read',
                'document.confidential.read',
                'document.restricted.read',
              ].includes(g.permission),
            ),
          ),
          canManageRecords: await this.hasAnyInOrganization(
            row.id,
            grants.filter((g) => g.permission === 'document.manage'),
          ),
        },
      });
    }
    return { items };
  }

  async hasAnyInOrganization(
    organizationId: string,
    grants: EffectiveGrant[],
    client: DocumentsClient = this.prisma,
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

  async requireAnyInOrganization(
    userId: string,
    organizationId: string,
    client: DocumentsClient = this.prisma,
  ) {
    const grants = await this.grants(userId, client);
    if (!(await this.hasAnyInOrganization(organizationId, grants, client))) {
      throw new ForbiddenException(
        'Missing document permissions for the organization.',
      );
    }
    await this.requireEnabled(organizationId, client);
    return grants;
  }

  notFound() {
    return new NotFoundException('Document not found.');
  }
}
