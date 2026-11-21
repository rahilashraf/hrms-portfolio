export const ROLE_ASSIGNMENT_SCOPE_TYPES = [
  'SYSTEM',
  'ORGANIZATION',
  'ORGANIZATIONAL_UNIT',
  'DEPARTMENT',
  'TEAM',
] as const;

export type RoleAssignmentScopeType =
  (typeof ROLE_ASSIGNMENT_SCOPE_TYPES)[number];

export interface ScopeRef {
  type: RoleAssignmentScopeType;
  id?: string;
}

export interface AuthorizationScope {
  type: RoleAssignmentScopeType;
  id?: string;
  organizationId?: string;
}

export interface AuthorizationTarget {
  type: Exclude<RoleAssignmentScopeType, 'SYSTEM'>;
  organizationId: string;
  unitPathIds?: readonly string[];
  departmentId?: string | null;
  teamId?: string | null;
}

export interface EffectiveGrant {
  permission: string;
  scope: Pick<ScopeRef, 'type' | 'id'>;
}

export interface CurrentGrantSnapshot {
  userId: string;
  permissions: Array<{
    key: string;
    scopes: ScopeRef[];
  }>;
}

export interface RequestAuditContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

export interface PermissionRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface RoleRow {
  id: string;
  organizationId: string | null;
  code: string;
  name: string;
  description: string | null;
  isSystemOwner: boolean;
  archivedAt: Date | null;
}

export interface RolePermissionRow {
  permissionId: string;
  permission: PermissionRow;
}

export interface RoleAssignmentRow {
  id: string;
  userId: string;
  roleId: string;
  roleOrganizationId: string | null;
  scopeType: RoleAssignmentScopeType;
  organizationId: string | null;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  startsAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  role?: RoleRow & { permissions?: RolePermissionRow[] };
}

export interface StructuralRow {
  id: string;
  organizationId: string;
  parentUnitId?: string | null;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  archivedAt?: Date | null;
}
