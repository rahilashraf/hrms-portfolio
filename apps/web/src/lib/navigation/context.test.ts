import { afterEach, describe, expect, it } from 'vitest';
import {
  navContextFromSnapshot,
  navContextFromWorkspace,
  organizationInitials,
  pickOrganization,
} from './context';
import {
  PREFERENCE_KEYS,
  readCollapsed,
  readCollapsedGroups,
  readPreference,
  writeCollapsed,
  writeCollapsedGroups,
  writePreference,
} from './preferences';
import type { Workspace } from '../workspace/types';

const org = (id: string, permissions: string[] = []) => ({
  id,
  name: `Org ${id}`,
  code: id,
  timezone: null,
  branding: null,
  enabledModules: ['LEAVE' as const],
  permissions,
  isEmployee: id === 'a',
  isManager: false,
});

describe('navigation context', () => {
  const workspace: Workspace = {
    user: { id: 'u', email: 'u@example.com', displayName: 'U' },
    systemPermissions: ['audit.read'],
    organizations: [org('a', ['leave.read']), org('b', ['payroll.read'])],
  };

  it('combines the selected organization permissions with SYSTEM permissions', () => {
    const context = navContextFromWorkspace(workspace, workspace.organizations[1]!);
    expect([...context.permissions].sort()).toEqual(['audit.read', 'payroll.read']);
    expect(context.organizationId).toBe('b');
    expect(context.isEmployee).toBe(false);
    expect([...context.enabledModules!]).toEqual(['LEAVE']);
  });

  it('has no organization context without organizations', () => {
    const context = navContextFromWorkspace({ ...workspace, organizations: [] }, null);
    expect(context.organizationId).toBeNull();
    expect(context.isEmployee).toBe(false);
    expect(context.enabledModules?.size).toBe(0);
  });

  it('degrades to the snapshot with unknown employment and no module filter', () => {
    const context = navContextFromSnapshot({
      userId: 'u',
      permissions: [{ key: 'leave.read', scopes: [{ type: 'TEAM', id: 't' }] }],
    });
    expect(context).toMatchObject({
      mode: 'fallback',
      enabledModules: null,
      organizationId: null,
      isEmployee: null,
    });
    expect(context.permissions.has('leave.read')).toBe(true);
  });

  it('keeps the persisted organization only while it is listed', () => {
    expect(pickOrganization(workspace.organizations, 'b')?.id).toBe('b');
    expect(pickOrganization(workspace.organizations, 'gone')?.id).toBe('a');
    expect(pickOrganization([], 'b')).toBeNull();
  });

  it('derives initials', () => {
    expect(organizationInitials('Northwind Academy')).toBe('NA');
    expect(organizationInitials('Camp')).toBe('CA');
  });
});

describe('shell preferences', () => {
  afterEach(() => window.localStorage.clear());

  it('persists the collapsed sidebar and collapsed groups', () => {
    expect(readCollapsed()).toBe(false);
    writeCollapsed(true);
    expect(readCollapsed()).toBe(true);
    expect(readCollapsedGroups()).toBeNull();
    writeCollapsedGroups(['pay', 'talent']);
    expect(readCollapsedGroups()).toEqual(['pay', 'talent']);
  });

  it('ignores corrupt values and unavailable storage', () => {
    window.localStorage.setItem(PREFERENCE_KEYS.collapsedGroups, '{not json');
    expect(readCollapsedGroups()).toBeNull();
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(readPreference(PREFERENCE_KEYS.organization)).toBeNull();
      expect(() => writePreference(PREFERENCE_KEYS.organization, 'x')).not.toThrow();
      expect(readCollapsed()).toBe(false);
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });
});
