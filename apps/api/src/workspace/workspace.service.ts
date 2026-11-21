import { Injectable } from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { brandingSummary } from '../branding/branding-domain.js';
import {
  disabledModules,
  enabledModulesOf,
  scopeOrganizations,
} from './workspace-scope.js';
import { permissionsReaching, personDisplayName } from './workspace-domain.js';

/**
 * Phase 20 — the signed-in user's workspace context for navigation and persona rendering:
 * the organizations they reach (any grant into them, or employment there; a SYSTEM grant
 * reaches every non-archived organization) with the modules enabled there, the permission
 * keys that reach any part of each, and whether they work / manage there.
 *
 * NEVER authorization: it only lets the UI hide what the caller could not use. Every domain
 * endpoint still authorizes on its own. Bounded work: one grants load, one batched lookup per
 * scope kind, one query each for organizations (with branding), modules, employment and
 * reports — never a query per permission or per organization.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async workspace(userId: string) {
    const [grants, user] = await Promise.all([
      this.authorization.effectiveGrants(userId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          person: {
            select: {
              firstName: true,
              lastName: true,
              preferredName: true,
              employee: { select: { id: true, archivedAt: true } },
            },
          },
        },
      }),
    ]);
    const employeeId =
      user?.person?.employee && !user.person.employee.archivedAt
        ? user.person.employee.id
        : null;
    const scopes = await scopeOrganizations(this.prisma, grants);
    const [employment, managed] = employeeId
      ? await Promise.all([
          this.prisma.employmentAssignment.findMany({
            where: { employeeId, status: { not: 'CANCELLED' } },
            select: { position: { select: { organizationId: true } } },
          }),
          // Active assignments reporting to one of the caller's assignments (distinct positions
          // bound the rows to the caller's direct reports' placements).
          this.prisma.employmentAssignment.findMany({
            where: {
              status: 'ACTIVE',
              manager: { employeeId, status: { not: 'CANCELLED' } },
            },
            select: {
              positionId: true,
              position: { select: { organizationId: true } },
            },
            distinct: ['positionId'],
          }),
        ])
      : [[], []];
    const employmentOrgs = new Set(
      employment.map((row) => row.position.organizationId),
    );
    const managerOrgs = new Set(
      managed.map((row) => row.position.organizationId),
    );
    const system = grants.some((grant) => grant.scope.type === 'SYSTEM');
    const reached = new Set<string>(employmentOrgs);
    for (const grant of grants) {
      const id =
        grant.scope.type === 'ORGANIZATION'
          ? grant.scope.id
          : grant.scope.type === 'ORGANIZATIONAL_UNIT'
            ? scopes.units.get(grant.scope.id ?? '')
            : grant.scope.type === 'DEPARTMENT'
              ? scopes.departments.get(grant.scope.id ?? '')
              : grant.scope.type === 'TEAM'
                ? scopes.teams.get(grant.scope.id ?? '')
                : undefined;
      if (id) reached.add(id);
    }
    const organizations = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        ...(system ? {} : { id: { in: [...reached] } }),
      },
      select: {
        id: true,
        name: true,
        code: true,
        timezone: true,
        branding: {
          select: {
            displayName: true,
            shortName: true,
            logoUrl: true,
            iconUrl: true,
            primaryColor: true,
            secondaryColor: true,
          },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const disabled = await disabledModules(
      this.prisma,
      organizations.map((row) => row.id),
    );
    return {
      user: {
        id: userId,
        email: user?.email ?? null,
        displayName: personDisplayName(user?.person, user?.email ?? ''),
      },
      systemPermissions: [
        ...new Set(
          grants
            .filter((grant) => grant.scope.type === 'SYSTEM')
            .map((grant) => grant.permission),
        ),
      ].sort(),
      organizations: organizations.map((row) => ({
        id: row.id,
        name: row.name,
        code: row.code,
        timezone: row.timezone,
        branding: brandingSummary(row.name, row.branding),
        enabledModules: enabledModulesOf(disabled.get(row.id)),
        permissions: permissionsReaching(grants, scopes, row.id),
        isEmployee: employmentOrgs.has(row.id),
        isManager: managerOrgs.has(row.id),
      })),
    };
  }
}
