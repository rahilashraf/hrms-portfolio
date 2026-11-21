import { scopeContainsTarget } from '../authorization/authorization.policy.js';
import type {
  AuthorizationTarget,
  EffectiveGrant,
} from '../authorization/authorization.types.js';

/**
 * Phase 20 — pure helpers for navigation, dashboard and capability flags. Nothing here grants
 * access: every flag and count is derived from the caller's effective grants with the same
 * scope semantics the domain endpoints apply, and the domain endpoints stay authoritative.
 */

// ─── Grants → organizations ──────────────────────────────────────────────────

export interface ScopeOrganizations {
  units: ReadonlyMap<string, string>;
  departments: ReadonlyMap<string, string>;
  teams: ReadonlyMap<string, string>;
}

/** The organization a grant's scope lies in (null: SYSTEM, which reaches every organization). */
export function grantOrganization(
  grant: EffectiveGrant,
  scopes: ScopeOrganizations,
): string | null | undefined {
  const id = grant.scope.id;
  switch (grant.scope.type) {
    case 'SYSTEM':
      return null;
    case 'ORGANIZATION':
      return id;
    case 'ORGANIZATIONAL_UNIT':
      return id ? scopes.units.get(id) : undefined;
    case 'DEPARTMENT':
      return id ? scopes.departments.get(id) : undefined;
    case 'TEAM':
      return id ? scopes.teams.get(id) : undefined;
  }
}

/** Permission keys whose grants reach any part of the organization (or SYSTEM). */
export function permissionsReaching(
  grants: readonly EffectiveGrant[],
  scopes: ScopeOrganizations,
  organizationId: string,
): string[] {
  const keys = new Set<string>();
  for (const grant of grants) {
    const organization = grantOrganization(grant, scopes);
    if (organization === null || organization === organizationId)
      keys.add(grant.permission);
  }
  return [...keys].sort();
}

// ─── Placement filters ───────────────────────────────────────────────────────

/**
 * Which placements (positions, or job openings' own placement) the caller's grants of some
 * permissions reach inside one organization:
 * - ALL: an organization (or SYSTEM) grant — every placement of the organization;
 * - SOME: the units (with all their descendants), departments and teams granted;
 * - NONE: nothing.
 */
export type PlacementFilter =
  | { kind: 'NONE' }
  | { kind: 'ALL' }
  | {
      kind: 'SOME';
      /** Granted units and every unit below them (organization's units only). */
      unitIds: string[];
      departmentIds: string[];
      teamIds: string[];
    };

export interface UnitRow {
  id: string;
  parentUnitId: string | null;
}

/** Each unit's id with every descendant (cycle-safe). */
export function unitSubtrees(
  units: readonly UnitRow[],
  roots: readonly string[],
): string[] {
  const children = new Map<string, string[]>();
  for (const unit of units) {
    if (!unit.parentUnitId) continue;
    children.set(unit.parentUnitId, [
      ...(children.get(unit.parentUnitId) ?? []),
      unit.id,
    ]);
  }
  const known = new Set(units.map((unit) => unit.id));
  const result = new Set<string>();
  const queue = roots.filter((root) => known.has(root));
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (result.has(next)) continue;
    result.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return [...result];
}

export function placementFilter(
  grants: readonly EffectiveGrant[],
  permissions: readonly string[],
  organizationId: string,
  units: readonly UnitRow[],
): PlacementFilter {
  const relevant = grants.filter((grant) =>
    permissions.includes(grant.permission),
  );
  if (relevant.length === 0) return { kind: 'NONE' };
  if (
    relevant.some(
      (grant) =>
        grant.scope.type === 'SYSTEM' ||
        (grant.scope.type === 'ORGANIZATION' &&
          grant.scope.id === organizationId),
    )
  )
    return { kind: 'ALL' };
  const ids = (type: string) => [
    ...new Set(
      relevant
        .filter((grant) => grant.scope.type === type && grant.scope.id)
        .map((grant) => grant.scope.id!),
    ),
  ];
  const unitIds = unitSubtrees(units, ids('ORGANIZATIONAL_UNIT'));
  const departmentIds = ids('DEPARTMENT');
  const teamIds = ids('TEAM');
  if (unitIds.length + departmentIds.length + teamIds.length === 0)
    return { kind: 'NONE' };
  return { kind: 'SOME', unitIds, departmentIds, teamIds };
}

/**
 * The Prisma condition on a placement row (Position or JobOpening columns) that matches
 * exactly the placements `positionTargets` + `permissionIsGranted` allow (the semantics of
 * leave, onboarding, documents, performance, compensation, benefits and recruitment): a unit
 * grant reaches the placement's own unit path, a department grant its department, a team
 * grant its team. Returns null for NONE (nothing matches) and {} for ALL.
 */
export function placementWhere(filter: PlacementFilter) {
  if (filter.kind === 'NONE') return null;
  if (filter.kind === 'ALL') return {};
  return {
    OR: [
      ...(filter.unitIds.length
        ? [{ organizationalUnitId: { in: filter.unitIds } }]
        : []),
      ...(filter.departmentIds.length
        ? [{ departmentId: { in: filter.departmentIds } }]
        : []),
      ...(filter.teamIds.length ? [{ teamId: { in: filter.teamIds } }] : []),
    ],
  };
}

/**
 * The Prisma condition on a Position that matches exactly the positions
 * PositionAuthorizationTargetResolver.scopeForPosition + AuthorizationService.resolveTarget
 * allow (the semantics of employee.* and time.*): the position's most specific placement is
 * resolved as a scope — a team position's department and unit come from its Team (the team's
 * department's unit, else the team's own unit), a department position's unit from its
 * Department, a unit position's from its own unit.
 */
export function resolvedPositionWhere(filter: PlacementFilter) {
  if (filter.kind === 'NONE') return null;
  if (filter.kind === 'ALL') return {};
  const units = filter.unitIds;
  const departments = filter.departmentIds;
  const or: Record<string, unknown>[] = [];
  if (filter.teamIds.length) or.push({ teamId: { in: filter.teamIds } });
  if (departments.length) {
    or.push({ teamId: null, departmentId: { in: departments } });
    or.push({ team: { departmentId: { in: departments } } });
  }
  if (units.length) {
    or.push({
      teamId: null,
      departmentId: null,
      organizationalUnitId: { in: units },
    });
    or.push({
      teamId: null,
      department: { organizationalUnitId: { in: units } },
    });
    or.push({
      team: { departmentId: null, organizationalUnitId: { in: units } },
    });
    or.push({ team: { department: { organizationalUnitId: { in: units } } } });
  }
  return { OR: or };
}

/** Whether a target is reached by a filter (the JS mirror used by the unit tests). */
export function filterReaches(
  grants: readonly EffectiveGrant[],
  permissions: readonly string[],
  target: AuthorizationTarget,
) {
  return grants.some(
    (grant) =>
      permissions.includes(grant.permission) &&
      scopeContainsTarget(grant.scope, target),
  );
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export function personDisplayName(
  person:
    | {
        firstName?: string | null;
        lastName?: string | null;
        preferredName?: string | null;
      }
    | null
    | undefined,
  fallback: string,
) {
  const first = person?.preferredName?.trim() || person?.firstName?.trim();
  const name = [first, person?.lastName?.trim()].filter(Boolean).join(' ');
  return name || fallback;
}
