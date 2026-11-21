import { NotFoundException } from '@nestjs/common';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import type { EffectiveGrant } from '../authorization/authorization.types.js';
import { domainError, type DomainClient } from '../common/domain-support.js';
import {
  ORGANIZATION_MODULES,
  type FeatureModule,
} from '../features/features-domain.js';
import {
  permissionsReaching,
  type ScopeOrganizations,
} from './workspace-domain.js';

/**
 * Phase 20 — shared database helpers: the organizations a set of grants reaches (one batched
 * lookup per scope kind, never per permission), module states and the caller's employee.
 */

export async function scopeOrganizations(
  client: DomainClient,
  grants: readonly EffectiveGrant[],
): Promise<ScopeOrganizations> {
  const ids = (type: string) => [
    ...new Set(
      grants
        .filter((grant) => grant.scope.type === type && grant.scope.id)
        .map((grant) => grant.scope.id!),
    ),
  ];
  const [unitIds, departmentIds, teamIds] = [
    ids('ORGANIZATIONAL_UNIT'),
    ids('DEPARTMENT'),
    ids('TEAM'),
  ];
  const [units, departments, teams] = await Promise.all([
    unitIds.length
      ? client.organizationalUnit.findMany({
          where: { id: { in: unitIds } },
          select: { id: true, organizationId: true },
        })
      : [],
    departmentIds.length
      ? client.department.findMany({
          where: { id: { in: departmentIds } },
          select: { id: true, organizationId: true },
        })
      : [],
    teamIds.length
      ? client.team.findMany({
          where: { id: { in: teamIds } },
          select: { id: true, organizationId: true },
        })
      : [],
  ]);
  const map = (rows: { id: string; organizationId: string }[]) =>
    new Map(rows.map((row) => [row.id, row.organizationId]));
  return {
    units: map(units),
    departments: map(departments),
    teams: map(teams),
  };
}

/** Modules disabled per organization (one query for any number of organizations). */
export async function disabledModules(
  client: DomainClient,
  organizationIds: readonly string[],
): Promise<Map<string, Set<FeatureModule>>> {
  const result = new Map<string, Set<FeatureModule>>();
  if (organizationIds.length === 0) return result;
  const rows = await client.organizationModuleSetting.findMany({
    where: {
      organizationId: { in: [...new Set(organizationIds)] },
      enabled: false,
    },
    select: { organizationId: true, module: true },
  });
  for (const row of rows) {
    const set = result.get(row.organizationId) ?? new Set<FeatureModule>();
    set.add(row.module as FeatureModule);
    result.set(row.organizationId, set);
  }
  return result;
}

export function enabledModulesOf(
  disabled: ReadonlySet<FeatureModule> | undefined,
) {
  return ORGANIZATION_MODULES.filter((module) => !disabled?.has(module));
}

/** The caller's (non-archived) Employee, if any. */
export async function selfEmployeeId(client: DomainClient, userId: string) {
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

export interface OrganizationContext {
  organization: {
    id: string;
    name: string;
    code: string;
    timezone: string | null;
  };
  grants: EffectiveGrant[];
  /** Permission keys reaching any part of the organization. */
  permissions: Set<string>;
  employeeId: string | null;
  /** The caller has a non-cancelled employment assignment in the organization. */
  isEmployee: boolean;
  /** organization-level check (ORGANIZATION or SYSTEM grant). */
  atOrganization: (permission: string) => boolean;
}

/**
 * An existing, non-archived organization the caller reaches (any grant into it, or employment
 * there). Anything else — unknown, archived, or another organization entirely — is the same
 * 404, so this never reveals that an organization exists.
 */
export async function requireOrganizationContext(
  client: DomainClient,
  grants: EffectiveGrant[],
  userId: string,
  organizationId: string,
): Promise<OrganizationContext> {
  const notFound = () =>
    new NotFoundException(
      domainError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found.'),
    );
  const organization = await client.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      code: true,
      timezone: true,
      archivedAt: true,
    },
  });
  if (!organization || organization.archivedAt) throw notFound();
  const scopes = await scopeOrganizations(client, grants);
  const permissions = new Set(
    permissionsReaching(grants, scopes, organizationId),
  );
  const employeeId = await selfEmployeeId(client, userId);
  const isEmployee =
    employeeId !== null &&
    (await client.employmentAssignment.count({
      where: {
        employeeId,
        status: { not: 'CANCELLED' },
        position: { organizationId },
      },
    })) > 0;
  if (permissions.size === 0 && !isEmployee) throw notFound();
  const target = { type: 'ORGANIZATION' as const, organizationId };
  return {
    organization: {
      id: organization.id,
      name: organization.name,
      code: organization.code,
      timezone: organization.timezone,
    },
    grants,
    permissions,
    employeeId,
    isEmployee,
    atOrganization: (permission) =>
      permissionIsGranted(grants, permission, target),
  };
}
