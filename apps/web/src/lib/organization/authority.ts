import type { AuthorizationScope } from '../authorization/can';
import type { Department, OrganizationalUnit, Team } from './types';

/**
 * Batch 5C — the scope a structure record is managed at, and the ancestors a grant may cover it
 * from, mirroring the API (OrganizationAuthorizationInterceptor.resourceScope; the server then
 * resolves the full ancestry). The permission snapshot only matches a scope exactly or one of
 * the ancestors given here, so every ancestor must be listed: the organization always, then the
 * department and the chain of business units above the record.
 *
 * Only structure the caller can see is used. An ancestor that is not visible is left out, which
 * can hide an action the API would allow but never shows one it would refuse.
 */
export interface StructureLookup {
  units: Array<Pick<OrganizationalUnit, 'id' | 'parentUnitId'>>;
  departments: Array<Pick<Department, 'id' | 'organizationalUnitId'>>;
  teams: Array<Pick<Team, 'id' | 'departmentId' | 'organizationalUnitId'>>;
}

export type StructureResource =
  'units' | 'departments' | 'teams' | 'job-titles' | 'positions' | 'work-locations';

export interface RecordAuthority {
  scope: AuthorizationScope;
  ancestors: AuthorizationScope[];
}

type Placement = {
  id: string;
  parentUnitId?: string | null;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
};

export function recordAuthority(
  resource: StructureResource,
  record: Placement,
  organizationId: string,
  structure: StructureLookup,
): RecordAuthority {
  const organization: AuthorizationScope = { type: 'ORGANIZATION', id: organizationId };
  const units = new Map(structure.units.map((unit) => [unit.id, unit]));
  const departments = new Map(
    structure.departments.map((department) => [department.id, department]),
  );
  const teams = new Map(structure.teams.map((team) => [team.id, team]));

  /** A unit and the units above it (stops at a cycle or a unit that is not visible). */
  const unitChain = (unitId: string | null | undefined): AuthorizationScope[] => {
    const chain: AuthorizationScope[] = [];
    const seen = new Set<string>();
    let current = unitId ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push({ type: 'ORGANIZATIONAL_UNIT', id: current });
      current = units.get(current)?.parentUnitId ?? null;
    }
    return chain;
  };
  const departmentChain = (departmentId: string): AuthorizationScope[] => [
    { type: 'DEPARTMENT', id: departmentId },
    ...unitChain(departments.get(departmentId)?.organizationalUnitId),
  ];
  const teamChain = (teamId: string): AuthorizationScope[] => {
    const team = teams.get(teamId);
    const above = team?.departmentId
      ? departmentChain(team.departmentId)
      : unitChain(team?.organizationalUnitId);
    // A team under a department may also name a unit directly; both are its ancestors.
    const direct =
      team?.departmentId && team.organizationalUnitId ? unitChain(team.organizationalUnitId) : [];
    return [{ type: 'TEAM', id: teamId }, ...above, ...direct];
  };

  let chain: AuthorizationScope[];
  switch (resource) {
    case 'units':
      chain = unitChain(record.id);
      if (chain.length === 0) chain = [{ type: 'ORGANIZATIONAL_UNIT', id: record.id }];
      // The record itself may not be in the lookup (e.g. archived); its own parent still counts.
      if (!units.has(record.id) && record.parentUnitId)
        chain = [chain[0]!, ...unitChain(record.parentUnitId)];
      break;
    case 'departments':
      chain = [
        { type: 'DEPARTMENT', id: record.id },
        ...unitChain(
          departments.get(record.id)?.organizationalUnitId ?? record.organizationalUnitId,
        ),
      ];
      break;
    case 'teams': {
      const known = teams.has(record.id);
      chain = known
        ? teamChain(record.id)
        : [
            { type: 'TEAM', id: record.id },
            ...(record.departmentId
              ? departmentChain(record.departmentId)
              : unitChain(record.organizationalUnitId)),
          ];
      break;
    }
    case 'positions':
      // The position's placement (API: scopeForPlacement): team, else department, else unit.
      chain = record.teamId
        ? teamChain(record.teamId)
        : record.departmentId
          ? departmentChain(record.departmentId)
          : record.organizationalUnitId
            ? unitChain(record.organizationalUnitId)
            : [];
      break;
    default:
      // Job titles and work locations are managed at the organization.
      chain = [];
  }
  if (chain.length === 0) return { scope: organization, ancestors: [] };
  const unique = chain.filter(
    (scope, index) =>
      chain.findIndex((other) => other.type === scope.type && other.id === scope.id) === index,
  );
  return { scope: unique[0]!, ancestors: [...unique.slice(1), organization] };
}

/**
 * R5-A (F1) — where the caller may place a structure record: the parents a record may be created
 * under or moved to. Mirrors the API's creation and move-destination scopes
 * (OrganizationAuthorizationInterceptor.creationScope / updateDestinationScope):
 * - under a business unit (a child unit, a department, a team or a position): `organization.manage`
 *   on that unit;
 * - under a department (a team or a position): on that department;
 * - under a team (a position): on that team;
 * - at the organization itself (a root unit, an organization-wide department or position, and
 *   every job title and work location): on the organization.
 * A grant on an ancestor covers its descendants, as for {@link recordAuthority}. The API decides;
 * this only keeps the screen from offering what it would refuse.
 */
export interface PlacementPermissions {
  organization: boolean;
  unit(id: string): boolean;
  department(id: string): boolean;
  team(id: string): boolean;
}

export function placementPermissions(
  allowed: (authority: RecordAuthority) => boolean,
  organizationId: string,
  structure: StructureLookup,
): PlacementPermissions {
  const under = (resource: 'units' | 'departments' | 'teams', id: string) =>
    allowed(recordAuthority(resource, { id }, organizationId, structure));
  return {
    organization: allowed({ scope: { type: 'ORGANIZATION', id: organizationId }, ancestors: [] }),
    unit: (id) => under('units', id),
    department: (id) => under('departments', id),
    team: (id) => under('teams', id),
  };
}
