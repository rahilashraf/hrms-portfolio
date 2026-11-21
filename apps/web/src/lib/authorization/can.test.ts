import { describe, expect, it } from 'vitest';
import { canFromSnapshot, hasPermission, type AuthorizationScope } from './can';

const snapshot = {
  userId: 'u1',
  permissions: [
    { key: 'role.read', scopes: [{ type: 'ORGANIZATION' as const, id: 'org-1' }] },
    { key: 'organization.manage', scopes: [{ type: 'SYSTEM' as const }] },
  ],
};

describe('canFromSnapshot', () => {
  it('matches exact and containing known scopes, but not unrelated scopes', () => {
    expect(canFromSnapshot(snapshot, 'role.read', { type: 'ORGANIZATION', id: 'org-1' })).toBe(
      true,
    );
    expect(
      canFromSnapshot(
        snapshot,
        'role.read',
        { type: 'TEAM', id: 'team-1' },
        {
          ancestors: [{ type: 'ORGANIZATION', id: 'org-1' }],
        },
      ),
    ).toBe(true);
    expect(canFromSnapshot(snapshot, 'role.read', { type: 'ORGANIZATION', id: 'org-2' })).toBe(
      false,
    );
  });

  describe('hasPermission', () => {
    const scopes = [
      ['SYSTEM', { type: 'SYSTEM' }],
      ['organization', { type: 'ORGANIZATION', id: 'org-1' }],
      ['organizational unit', { type: 'ORGANIZATIONAL_UNIT', id: 'unit-1' }],
      ['department', { type: 'DEPARTMENT', id: 'department-1' }],
      ['team', { type: 'TEAM', id: 'team-1' }],
    ] as const satisfies ReadonlyArray<[string, AuthorizationScope]>;

    it.each(scopes)('finds employee.read granted at %s scope', (_label, scope) => {
      expect(
        hasPermission(
          {
            userId: 'user-1',
            permissions: [{ key: 'employee.read', scopes: [scope] }],
          },
          'employee.read',
        ),
      ).toBe(true);
    });

    it('returns false without employee.read or with employee.manage only', () => {
      expect(
        hasPermission(
          {
            userId: 'user-1',
            permissions: [{ key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] }],
          },
          'employee.read',
        ),
      ).toBe(false);
      expect(hasPermission(null, 'employee.read')).toBe(false);
    });

    it('does not change scoped can semantics', () => {
      const employeeSnapshot = {
        userId: 'user-1',
        permissions: [{ key: 'employee.read', scopes: [{ type: 'TEAM' as const, id: 'team-1' }] }],
      };
      expect(canFromSnapshot(employeeSnapshot, 'employee.read', { type: 'SYSTEM' })).toBe(false);
      expect(
        canFromSnapshot(employeeSnapshot, 'employee.read', { type: 'TEAM', id: 'team-1' }),
      ).toBe(true);
    });
  });

  it('does not treat a scoped grant as a system grant', () => {
    expect(canFromSnapshot(snapshot, 'role.read')).toBe(false);
    expect(canFromSnapshot(snapshot, 'organization.manage')).toBe(true);
    expect(canFromSnapshot(snapshot, 'organization.read', { type: 'SYSTEM' })).toBe(false);
  });

  it('unions multiple grants without implying a different permission', () => {
    const multiple = {
      ...snapshot,
      permissions: [
        ...snapshot.permissions,
        { key: 'role.read', scopes: [{ type: 'TEAM' as const, id: 'team-2' }] },
      ],
    };
    expect(canFromSnapshot(multiple, 'role.read', { type: 'TEAM', id: 'team-2' })).toBe(true);
    expect(canFromSnapshot(multiple, 'role.manage', { type: 'ORGANIZATION', id: 'org-1' })).toBe(
      false,
    );
  });
});
