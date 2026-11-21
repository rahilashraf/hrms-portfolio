export type ScopeType = 'ORGANIZATION' | 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM';
export interface GrantSnapshot {
  userId: string;
  permissions: Array<{ key: string; scopes: Array<{ type: ScopeType | 'SYSTEM'; id?: string }> }>;
}
export interface Permission {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  /** Phase 20 presentation metadata (product area and human label). */
  area?: string;
  label?: string;
}

/** Phase 20 — a preset of permission keys for the role editor (never a role by itself). */
export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: string[];
  /** Keys the caller does not hold in the organization (so cannot delegate). */
  missingPermissions?: string[];
}
export interface Role {
  id: string;
  organizationId: string | null;
  code: string;
  name: string;
  description: string | null;
  isSystemOwner: boolean;
  archivedAt: string | null;
  permissions?: Array<{ permissionId: string; permission: Permission }>;
}
export interface Assignment {
  id: string;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  organizationId: string | null;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  role?: Role;
  user?: { id: string; email: string; person?: { id: string } };
}
/** A user who can receive roles: active, or invited (roles take effect on activation). */
export interface ActiveUser {
  id: string;
  email: string;
  status: 'ACTIVE' | 'INVITED';
  displayName: string | null;
  employeeNumber: string | null;
}
