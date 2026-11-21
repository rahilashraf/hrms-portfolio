import { apiRequest } from '../auth/api-client';
import type {
  ActiveUser,
  Assignment,
  GrantSnapshot,
  Permission,
  Role,
  RoleTemplate,
  ScopeType,
} from './types';

const enc = encodeURIComponent;
export const authorizationApi = {
  snapshot: () => apiRequest<GrantSnapshot>('/auth/me/authorization'),
  permissions: (organizationId: string) =>
    apiRequest<Permission[]>(`/authorization/permissions?organizationId=${enc(organizationId)}`),
  roleTemplates: (organizationId: string) =>
    apiRequest<{ items: RoleTemplate[] }>(
      `/authorization/role-templates?organizationId=${enc(organizationId)}`,
    ).then((result) => result.items),
  roles: (organizationId: string, includeArchived = false) =>
    apiRequest<Role[]>(
      `/authorization/organizations/${enc(organizationId)}/roles?includeArchived=${includeArchived}`,
    ),
  role: (id: string) => apiRequest<Role>(`/authorization/roles/${enc(id)}`),
  createRole: (
    organizationId: string,
    body: { code: string; name: string; description?: string; permissionKeys: string[] },
  ) =>
    apiRequest<Role>(`/authorization/organizations/${enc(organizationId)}/roles`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateRole: (id: string, body: { name?: string; description?: string | null }) =>
    apiRequest<Role>(`/authorization/roles/${enc(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  replacePermissions: (id: string, permissionKeys: string[]) =>
    apiRequest<Role>(`/authorization/roles/${enc(id)}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissionKeys }),
    }),
  archive: (id: string) =>
    apiRequest<void>(`/authorization/roles/${enc(id)}/archive`, { method: 'POST' }),
  reactivate: (id: string) =>
    apiRequest<void>(`/authorization/roles/${enc(id)}/reactivate`, { method: 'POST' }),
  assignments: (roleId: string, includeRevoked = true, afterId?: string) =>
    apiRequest<{ items: Assignment[]; nextCursor: string | null }>(
      `/authorization/roles/${enc(roleId)}/assignments?includeRevoked=${includeRevoked}${afterId ? `&afterId=${enc(afterId)}` : ''}`,
    ),
  assignment: (id: string) => apiRequest<Assignment>(`/authorization/assignments/${enc(id)}`),
  /** Batch 3B: one page of the user search (the picker follows `nextCursor`). */
  searchUsers: (organizationId: string, query: string, afterId?: string | null, limit = 25) =>
    apiRequest<{ items: ActiveUser[]; nextCursor: string | null }>(
      `/authorization/users?organizationId=${enc(organizationId)}&query=${enc(query)}&limit=${limit}${afterId ? `&afterId=${enc(afterId)}` : ''}`,
    ),
  users: (organizationId: string, query: string) =>
    apiRequest<{ items: ActiveUser[] }>(
      `/authorization/users?organizationId=${enc(organizationId)}&query=${enc(query)}`,
    ).then((r) => r.items),
  createAssignment: (body: {
    userId: string;
    roleId: string;
    scope: { type: ScopeType; id: string };
    startsAt?: string;
    expiresAt?: string | null;
  }) =>
    apiRequest<Assignment>('/authorization/assignments', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revoke: (id: string, reason?: string) =>
    apiRequest<void>(`/authorization/assignments/${enc(id)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};
