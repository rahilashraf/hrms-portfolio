import { getUnitPath } from '../authorization/authorization.service.js';
import type {
  AuthorizationTarget,
  EffectiveGrant,
} from '../authorization/authorization.types.js';
import {
  filterReaches,
  grantOrganization,
  permissionsReaching,
  personDisplayName,
  placementFilter,
  placementWhere,
  resolvedPositionWhere,
  unitSubtrees,
} from './workspace-domain.js';

const ORG = 'org-a';
const units = [
  { id: 'U1', organizationId: ORG, parentUnitId: null },
  { id: 'U2', organizationId: ORG, parentUnitId: 'U1' },
  { id: 'U3', organizationId: ORG, parentUnitId: null },
  { id: 'U4', organizationId: ORG, parentUnitId: 'U2' },
];
const departments: Record<string, { unit: string | null }> = {
  D1: { unit: 'U2' },
  D2: { unit: null },
  D3: { unit: 'U3' },
};
const teams: Record<
  string,
  { department: string | null; unit: string | null }
> = {
  T1: { department: 'D1', unit: null },
  T2: { department: null, unit: 'U3' },
  T3: { department: 'D2', unit: null },
  // A team whose own unit disagrees with its department's: resolution uses the department.
  T4: { department: 'D1', unit: 'U3' },
};

interface Position {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
}

// Every placement combination, including ones whose columns disagree with the hierarchy.
const positions: Position[] = [];
for (const unit of [null, 'U1', 'U2', 'U3', 'U4'])
  for (const department of [null, 'D1', 'D2', 'D3'])
    for (const team of [null, 'T1', 'T2', 'T3', 'T4'])
      positions.push({
        id: `${unit}-${department}-${team}`,
        organizationId: ORG,
        organizationalUnitId: unit,
        departmentId: department,
        teamId: team,
      });

const path = (unit: string | null) => (unit ? getUnitPath(units, unit) : []);

/** positionTargets semantics (common/domain-support.ts). */
function placedTarget(p: Position): AuthorizationTarget {
  return {
    type: p.teamId
      ? 'TEAM'
      : p.departmentId
        ? 'DEPARTMENT'
        : p.organizationalUnitId
          ? 'ORGANIZATIONAL_UNIT'
          : 'ORGANIZATION',
    organizationId: ORG,
    unitPathIds: path(p.organizationalUnitId),
    departmentId: p.departmentId,
    teamId: p.teamId,
  };
}

/** scopeForPosition + AuthorizationService.resolveTarget semantics. */
function resolvedTarget(p: Position): AuthorizationTarget {
  if (p.teamId) {
    const team = teams[p.teamId]!;
    const unit = team.department
      ? departments[team.department]!.unit
      : team.unit;
    return {
      type: 'TEAM',
      organizationId: ORG,
      teamId: p.teamId,
      departmentId: team.department,
      unitPathIds: path(unit),
    };
  }
  if (p.departmentId)
    return {
      type: 'DEPARTMENT',
      organizationId: ORG,
      departmentId: p.departmentId,
      unitPathIds: path(departments[p.departmentId]!.unit),
    };
  if (p.organizationalUnitId)
    return {
      type: 'ORGANIZATIONAL_UNIT',
      organizationId: ORG,
      unitPathIds: path(p.organizationalUnitId),
    };
  return { type: 'ORGANIZATION', organizationId: ORG };
}

/** A tiny evaluator of the Prisma conditions the helpers build. */
function matches(where: Record<string, unknown>, row: Position): boolean {
  const relation = (name: string, value: Record<string, unknown>) => {
    if (name === 'team') {
      if (!row.teamId) return false;
      const team = teams[row.teamId]!;
      return evaluate(value, {
        departmentId: team.department,
        organizationalUnitId: team.unit,
        department: team.department,
      });
    }
    if (name === 'department') {
      const id = row.departmentId;
      if (!id) return false;
      return evaluate(value, {
        organizationalUnitId: departments[id]!.unit,
      });
    }
    throw new Error(`unknown relation ${name}`);
  };
  function evaluate(
    condition: Record<string, unknown>,
    fields: Record<string, unknown>,
    top = false,
  ): boolean {
    return Object.entries(condition).every(([key, value]) => {
      if (key === 'OR')
        return (value as Record<string, unknown>[]).some((c) =>
          evaluate(c, fields, top),
        );
      if (key === 'department' && !top) {
        const id = fields.department as string | null;
        if (!id) return false;
        return evaluate(value as Record<string, unknown>, {
          organizationalUnitId: departments[id]!.unit,
        });
      }
      if ((key === 'team' || key === 'department') && top)
        return relation(key, value as Record<string, unknown>);
      const actual = fields[key];
      if (value === null) return actual === null;
      if (value && typeof value === 'object' && 'in' in value)
        return (value as { in: unknown[] }).in.includes(actual);
      return actual === value;
    });
  }
  return evaluate(where, { ...row }, true);
}

const grant = (
  permission: string,
  type: EffectiveGrant['scope']['type'],
  id?: string,
): EffectiveGrant => ({ permission, scope: { type, ...(id ? { id } : {}) } });

const scopes: EffectiveGrant[][] = [
  [],
  [grant('employee.read', 'SYSTEM')],
  [grant('employee.read', 'ORGANIZATION', ORG)],
  [grant('employee.read', 'ORGANIZATION', 'org-b')],
  ...['U1', 'U2', 'U3', 'U4'].map((id) => [
    grant('employee.read', 'ORGANIZATIONAL_UNIT', id),
  ]),
  ...['D1', 'D2', 'D3'].map((id) => [grant('employee.read', 'DEPARTMENT', id)]),
  ...['T1', 'T2', 'T3', 'T4'].map((id) => [grant('employee.read', 'TEAM', id)]),
  [
    grant('employee.read', 'TEAM', 'T2'),
    grant('employee.read', 'DEPARTMENT', 'D2'),
    grant('employee.read', 'ORGANIZATIONAL_UNIT', 'U2'),
  ],
  // A different permission never counts.
  [grant('employee.manage', 'ORGANIZATION', ORG)],
];

describe('placement filters', () => {
  it.each(scopes.map((grants, index) => [index, grants] as const))(
    'placementWhere mirrors positionTargets + permissionIsGranted (case %i)',
    (_index, grants) => {
      const where = placementWhere(
        placementFilter(grants, ['employee.read'], ORG, units),
      );
      for (const position of positions) {
        const expected = filterReaches(
          grants,
          ['employee.read'],
          placedTarget(position),
        );
        const actual =
          where !== null &&
          matches({ organizationId: ORG, ...where }, position);
        expect(actual, position.id).toBe(expected);
      }
    },
  );

  it.each(scopes.map((grants, index) => [index, grants] as const))(
    'resolvedPositionWhere mirrors scopeForPosition + resolveTarget (case %i)',
    (_index, grants) => {
      const where = resolvedPositionWhere(
        placementFilter(grants, ['employee.read'], ORG, units),
      );
      for (const position of positions) {
        const expected = filterReaches(
          grants,
          ['employee.read'],
          resolvedTarget(position),
        );
        const actual =
          where !== null &&
          matches({ organizationId: ORG, ...where }, position);
        expect(actual, position.id).toBe(expected);
      }
    },
  );

  it('classifies NONE / ALL / SOME', () => {
    expect(placementFilter([], ['x'], ORG, units)).toEqual({ kind: 'NONE' });
    expect(placementFilter([grant('x', 'SYSTEM')], ['x'], ORG, units)).toEqual({
      kind: 'ALL',
    });
    expect(
      placementFilter([grant('x', 'ORGANIZATION', 'other')], ['x'], ORG, units),
    ).toEqual({ kind: 'NONE' });
    expect(
      placementFilter(
        [grant('x', 'ORGANIZATIONAL_UNIT', 'U1')],
        ['x'],
        ORG,
        units,
      ),
    ).toEqual({
      kind: 'SOME',
      unitIds: expect.arrayContaining(['U1', 'U2', 'U4']),
      departmentIds: [],
      teamIds: [],
    });
    // A unit of another organization is not among this organization's units.
    expect(
      placementFilter(
        [grant('x', 'ORGANIZATIONAL_UNIT', 'foreign')],
        ['x'],
        ORG,
        units,
      ),
    ).toEqual({ kind: 'NONE' });
  });

  it('computes unit subtrees safely with cycles', () => {
    expect(
      unitSubtrees(
        [
          { id: 'A', parentUnitId: 'B' },
          { id: 'B', parentUnitId: 'A' },
        ],
        ['A'],
      ).sort(),
    ).toEqual(['A', 'B']);
  });
});

describe('grants → organizations', () => {
  const lookup = {
    units: new Map([['U1', ORG]]),
    departments: new Map([['D9', 'org-b']]),
    teams: new Map<string, string>(),
  };

  it('maps each scope to its organization (SYSTEM reaches all)', () => {
    expect(grantOrganization(grant('k', 'SYSTEM'), lookup)).toBeNull();
    expect(grantOrganization(grant('k', 'ORGANIZATION', ORG), lookup)).toBe(
      ORG,
    );
    expect(
      grantOrganization(grant('k', 'ORGANIZATIONAL_UNIT', 'U1'), lookup),
    ).toBe(ORG);
    expect(grantOrganization(grant('k', 'TEAM', 'unknown'), lookup)).toBe(
      undefined,
    );
  });

  it('lists the keys reaching an organization, sorted and unique', () => {
    const grants = [
      grant('b.read', 'ORGANIZATIONAL_UNIT', 'U1'),
      grant('a.read', 'SYSTEM'),
      grant('b.read', 'ORGANIZATION', ORG),
      grant('c.read', 'DEPARTMENT', 'D9'),
    ];
    expect(permissionsReaching(grants, lookup, ORG)).toEqual([
      'a.read',
      'b.read',
    ]);
    expect(permissionsReaching(grants, lookup, 'org-b')).toEqual([
      'a.read',
      'c.read',
    ]);
  });
});

describe('personDisplayName', () => {
  it('prefers the preferred name, then first + last, then the fallback', () => {
    expect(
      personDisplayName(
        { firstName: 'Robert', lastName: 'Ng', preferredName: 'Bob' },
        'x@example.com',
      ),
    ).toBe('Bob Ng');
    expect(personDisplayName({ firstName: 'Ann' }, 'x')).toBe('Ann');
    expect(personDisplayName(null, 'x@example.com')).toBe('x@example.com');
  });
});
