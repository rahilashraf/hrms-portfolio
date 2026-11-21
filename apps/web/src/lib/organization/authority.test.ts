import { describe, expect, it } from 'vitest';
import { canFromSnapshot } from '../authorization/can';
import type { GrantSnapshot } from '../authorization/types';
import { placementPermissions, recordAuthority, type StructureLookup } from './authority';

const structure: StructureLookup = {
  units: [
    { id: 'unit-root', parentUnitId: null },
    { id: 'unit-child', parentUnitId: 'unit-root' },
  ],
  departments: [{ id: 'dept-1', organizationalUnitId: 'unit-child' }],
  teams: [
    { id: 'team-dept', departmentId: 'dept-1', organizationalUnitId: null },
    { id: 'team-unit', departmentId: null, organizationalUnitId: 'unit-root' },
  ],
};

const grant = (type: string, id?: string): GrantSnapshot =>
  ({
    permissions: [{ key: 'organization.manage', scopes: [{ type, ...(id ? { id } : {}) }] }],
  }) as unknown as GrantSnapshot;

function may(snapshot: GrantSnapshot, ...args: Parameters<typeof recordAuthority>) {
  const { scope, ancestors } = recordAuthority(...args);
  return canFromSnapshot(snapshot, 'organization.manage', scope, { ancestors });
}

describe('recordAuthority (Batch 5C)', () => {
  it('lets an organization-wide manager act on every record (the organization is always an ancestor)', () => {
    const org = grant('ORGANIZATION', 'org-1');
    expect(may(org, 'teams', { id: 'team-dept' }, 'org-1', structure)).toBe(true);
    expect(may(org, 'units', { id: 'unit-child' }, 'org-1', structure)).toBe(true);
    expect(may(org, 'departments', { id: 'dept-1' }, 'org-1', structure)).toBe(true);
    expect(may(org, 'positions', { id: 'p', teamId: 'team-dept' }, 'org-1', structure)).toBe(true);
    expect(may(org, 'job-titles', { id: 'jt' }, 'org-1', structure)).toBe(true);
    expect(may(org, 'work-locations', { id: 'wl' }, 'org-1', structure)).toBe(true);
    // Another organization's grant never matches.
    expect(
      may(grant('ORGANIZATION', 'org-2'), 'teams', { id: 'team-dept' }, 'org-1', structure),
    ).toBe(false);
  });

  it('walks departments and the whole business-unit chain', () => {
    const root = grant('ORGANIZATIONAL_UNIT', 'unit-root');
    expect(may(root, 'teams', { id: 'team-dept' }, 'org-1', structure)).toBe(true);
    expect(may(root, 'teams', { id: 'team-unit' }, 'org-1', structure)).toBe(true);
    expect(may(root, 'departments', { id: 'dept-1' }, 'org-1', structure)).toBe(true);
    expect(may(root, 'units', { id: 'unit-child' }, 'org-1', structure)).toBe(true);
    expect(may(root, 'positions', { id: 'p', departmentId: 'dept-1' }, 'org-1', structure)).toBe(
      true,
    );
    const department = grant('DEPARTMENT', 'dept-1');
    expect(may(department, 'teams', { id: 'team-dept' }, 'org-1', structure)).toBe(true);
    expect(may(department, 'teams', { id: 'team-unit' }, 'org-1', structure)).toBe(false);
    expect(may(department, 'departments', { id: 'dept-1' }, 'org-1', structure)).toBe(true);
    // Narrower grants never cover a wider record.
    expect(may(department, 'units', { id: 'unit-child' }, 'org-1', structure)).toBe(false);
    expect(
      may(grant('TEAM', 'team-dept'), 'departments', { id: 'dept-1' }, 'org-1', structure),
    ).toBe(false);
  });

  it('keeps organization-level records at the organization and never shows actions to scoped grants there', () => {
    expect(recordAuthority('job-titles', { id: 'jt' }, 'org-1', structure)).toEqual({
      scope: { type: 'ORGANIZATION', id: 'org-1' },
      ancestors: [],
    });
    const unit = grant('ORGANIZATIONAL_UNIT', 'unit-root');
    expect(may(unit, 'work-locations', { id: 'wl' }, 'org-1', structure)).toBe(false);
    expect(may(unit, 'positions', { id: 'p' }, 'org-1', structure)).toBe(false);
  });

  it('leaves out ancestors it cannot see (conservative) and survives cycles', () => {
    const hidden: StructureLookup = { units: [], departments: [], teams: [] };
    expect(
      may(
        grant('DEPARTMENT', 'dept-1'),
        'teams',
        { id: 't', departmentId: 'dept-1' },
        'org-1',
        hidden,
      ),
    ).toBe(true);
    expect(
      may(
        grant('ORGANIZATIONAL_UNIT', 'unit-child'),
        'teams',
        { id: 't', departmentId: 'dept-1' },
        'org-1',
        hidden,
      ),
    ).toBe(false);
    const cyclic: StructureLookup = {
      units: [
        { id: 'a', parentUnitId: 'b' },
        { id: 'b', parentUnitId: 'a' },
      ],
      departments: [],
      teams: [],
    };
    expect(recordAuthority('units', { id: 'a' }, 'org-1', cyclic).ancestors).toEqual([
      { type: 'ORGANIZATIONAL_UNIT', id: 'b' },
      { type: 'ORGANIZATION', id: 'org-1' },
    ]);
  });
});

describe('placementPermissions (R5-A F1)', () => {
  const placeWith = (snapshot: GrantSnapshot) =>
    placementPermissions(
      ({ scope, ancestors }) =>
        canFromSnapshot(snapshot, 'organization.manage', scope, { ancestors }),
      'org-1',
      structure,
    );

  it('lets an organization manager place records anywhere, including at the organization', () => {
    const place = placeWith(grant('ORGANIZATION', 'org-1'));
    expect(place.organization).toBe(true);
    expect(place.unit('unit-child')).toBe(true);
    expect(place.department('dept-1')).toBe(true);
    expect(place.team('team-unit')).toBe(true);
  });

  it('limits a scoped manager to parents inside the scope, never the organization', () => {
    const unit = placeWith(grant('ORGANIZATIONAL_UNIT', 'unit-child'));
    expect(unit.organization).toBe(false);
    expect(unit.unit('unit-child')).toBe(true);
    expect(unit.unit('unit-root')).toBe(false);
    expect(unit.department('dept-1')).toBe(true);
    expect(unit.team('team-dept')).toBe(true);
    expect(unit.team('team-unit')).toBe(false);

    const team = placeWith(grant('TEAM', 'team-dept'));
    expect(team.team('team-dept')).toBe(true);
    expect(team.department('dept-1')).toBe(false);
    expect(team.unit('unit-child')).toBe(false);
    expect(team.organization).toBe(false);
  });

  it('never matches another organization', () => {
    const other = placeWith(grant('ORGANIZATION', 'org-2'));
    expect(other.organization).toBe(false);
    expect(other.unit('unit-root')).toBe(false);
  });
});
