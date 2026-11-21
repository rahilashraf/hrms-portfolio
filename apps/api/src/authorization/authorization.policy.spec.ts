import { describe, expect, it } from 'vitest';
import {
  assignmentScope,
  isAssignmentEffective,
  permissionIsGranted,
  scopeContainsTarget,
} from './authorization.policy.js';
import { getUnitPath } from './authorization.service.js';
import type {
  AuthorizationTarget,
  RoleAssignmentRow,
  ScopeRef,
  StructuralRow,
} from './authorization.types.js';

const target = (
  type: AuthorizationTarget['type'],
  values: Partial<AuthorizationTarget> = {},
): AuthorizationTarget => ({
  type,
  organizationId: 'org-1',
  ...values,
});

describe('authorization scope policy', () => {
  const nestedDepartment = target('DEPARTMENT', {
    departmentId: 'dept-nested',
    unitPathIds: ['unit-child', 'unit-root'],
  });
  const organizationDepartment = target('DEPARTMENT', {
    departmentId: 'dept-org',
    unitPathIds: [],
  });
  const departmentTeam = target('TEAM', {
    teamId: 'team-dept',
    departmentId: 'dept-nested',
    unitPathIds: ['unit-child', 'unit-root'],
  });
  const directUnitTeam = target('TEAM', {
    teamId: 'team-unit',
    departmentId: null,
    unitPathIds: ['unit-child', 'unit-root'],
  });

  it('applies exact downward organizational containment', () => {
    expect(
      scopeContainsTarget(
        { type: 'ORGANIZATION', id: 'org-1' },
        organizationDepartment,
      ),
    ).toBe(true);
    expect(
      scopeContainsTarget(
        { type: 'ORGANIZATIONAL_UNIT', id: 'unit-root' },
        nestedDepartment,
      ),
    ).toBe(true);
    expect(
      scopeContainsTarget(
        { type: 'ORGANIZATIONAL_UNIT', id: 'unit-child' },
        directUnitTeam,
      ),
    ).toBe(true);
    expect(
      scopeContainsTarget(
        { type: 'ORGANIZATIONAL_UNIT', id: 'unit-root' },
        organizationDepartment,
      ),
    ).toBe(false);
  });

  it('limits department scope to its teams and team scope to itself', () => {
    expect(
      scopeContainsTarget(
        { type: 'DEPARTMENT', id: 'dept-nested' },
        departmentTeam,
      ),
    ).toBe(true);
    expect(
      scopeContainsTarget(
        { type: 'DEPARTMENT', id: 'dept-nested' },
        directUnitTeam,
      ),
    ).toBe(false);
    expect(
      scopeContainsTarget({ type: 'TEAM', id: 'team-dept' }, departmentTeam),
    ).toBe(true);
    expect(
      scopeContainsTarget({ type: 'TEAM', id: 'team-dept' }, directUnitTeam),
    ).toBe(false);
  });

  it('unions grants by exact permission key without privilege implication', () => {
    const grants = [
      {
        permission: 'organization.manage',
        scope: { type: 'ORGANIZATION', id: 'org-1' } satisfies ScopeRef,
      },
      {
        permission: 'role.read',
        scope: { type: 'DEPARTMENT', id: 'dept-nested' } satisfies ScopeRef,
      },
    ];
    expect(
      permissionIsGranted(grants, 'organization.manage', nestedDepartment),
    ).toBe(true);
    expect(
      permissionIsGranted(grants, 'organization.read', nestedDepartment),
    ).toBe(false);
    expect(permissionIsGranted(grants, 'role.read', departmentTeam)).toBe(true);
  });

  it('treats effective dates as start-inclusive and expiry-exclusive', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const assignment = {
      startsAt: now,
      expiresAt: new Date(now.getTime() + 1),
      revokedAt: null,
    };
    expect(isAssignmentEffective(assignment, now)).toBe(true);
    expect(isAssignmentEffective({ ...assignment, expiresAt: now }, now)).toBe(
      false,
    );
    expect(isAssignmentEffective({ ...assignment, revokedAt: now }, now)).toBe(
      false,
    );
    expect(
      isAssignmentEffective(
        { ...assignment, startsAt: new Date(now.getTime() + 1) },
        now,
      ),
    ).toBe(false);
  });

  it('maps persisted scope columns and safely resolves unit ancestry', () => {
    const assignment = {
      scopeType: 'ORGANIZATIONAL_UNIT',
      organizationId: 'org-1',
      organizationalUnitId: 'unit-root',
      departmentId: null,
      teamId: null,
    } as RoleAssignmentRow;
    expect(assignmentScope(assignment)).toEqual({
      type: 'ORGANIZATIONAL_UNIT',
      id: 'unit-root',
    });
    const units: StructuralRow[] = [
      { id: 'unit-root', organizationId: 'org-1', parentUnitId: null },
      { id: 'unit-child', organizationId: 'org-1', parentUnitId: 'unit-root' },
    ];
    expect(getUnitPath(units, 'unit-child')).toEqual([
      'unit-child',
      'unit-root',
    ]);
    expect(
      getUnitPath(
        [
          { id: 'a', organizationId: 'org-1', parentUnitId: 'b' },
          { id: 'b', organizationId: 'org-1', parentUnitId: 'a' },
        ],
        'a',
      ),
    ).toEqual([]);
  });
});
