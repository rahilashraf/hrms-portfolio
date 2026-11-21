import type { GrantSnapshot } from '../authorization/types';
import type { Workspace, WorkspaceOrganization } from '../workspace/types';
import type { NavContext } from './registry';

/**
 * The navigation context for the selected organization: its permissions plus SYSTEM-scope
 * permissions, its enabled modules and whether the caller is employed there.
 */
export function navContextFromWorkspace(
  workspace: Workspace,
  organization: WorkspaceOrganization | null,
): NavContext {
  return {
    mode: 'workspace',
    permissions: new Set([...workspace.systemPermissions, ...(organization?.permissions ?? [])]),
    enabledModules: new Set(organization?.enabledModules ?? []),
    organizationId: organization?.id ?? null,
    isEmployee: organization ? organization.isEmployee : false,
  };
}

/**
 * Degraded context when the workspace endpoint is unavailable: any permission held anywhere,
 * no module filtering, no organization context (organization-specific items are hidden) and an
 * unknown employment (self-service items stay visible, as they always were).
 */
export function navContextFromSnapshot(snapshot: GrantSnapshot | null): NavContext {
  return {
    mode: 'fallback',
    permissions: new Set(snapshot?.permissions.map((permission) => permission.key) ?? []),
    enabledModules: null,
    organizationId: null,
    isEmployee: null,
  };
}

/** The persisted organization when it is still listed, else the first one. */
export function pickOrganization(
  organizations: readonly WorkspaceOrganization[],
  preferredId: string | null,
): WorkspaceOrganization | null {
  return organizations.find((item) => item.id === preferredId) ?? organizations[0] ?? null;
}

/** Initials for an organization without an icon ("Northwind Academy" → "NA"). */
export function organizationInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [name.slice(0, 2)];
  return letters.join('').toUpperCase() || '?';
}
