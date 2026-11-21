import type {
  AuthorizationTarget,
  RoleAssignmentRow,
  ScopeRef,
} from './authorization.types.js';

export function isAssignmentEffective(
  assignment: Pick<RoleAssignmentRow, 'startsAt' | 'expiresAt' | 'revokedAt'>,
  now: Date,
): boolean {
  return (
    assignment.revokedAt === null &&
    assignment.startsAt.getTime() <= now.getTime() &&
    (assignment.expiresAt === null ||
      assignment.expiresAt.getTime() > now.getTime())
  );
}

export function assignmentScope(
  assignment: Pick<
    RoleAssignmentRow,
    | 'scopeType'
    | 'organizationId'
    | 'organizationalUnitId'
    | 'departmentId'
    | 'teamId'
  >,
): ScopeRef {
  switch (assignment.scopeType) {
    case 'SYSTEM':
      return { type: 'SYSTEM' };
    case 'ORGANIZATION':
      return {
        type: 'ORGANIZATION',
        id: assignment.organizationId ?? undefined,
      };
    case 'ORGANIZATIONAL_UNIT':
      return {
        type: 'ORGANIZATIONAL_UNIT',
        id: assignment.organizationalUnitId ?? undefined,
      };
    case 'DEPARTMENT':
      return { type: 'DEPARTMENT', id: assignment.departmentId ?? undefined };
    case 'TEAM':
      return { type: 'TEAM', id: assignment.teamId ?? undefined };
  }
}

export function scopeContainsTarget(
  scope: ScopeRef,
  target: AuthorizationTarget,
): boolean {
  if (scope.type === 'SYSTEM') return true;
  if (!scope.id) return false;

  switch (scope.type) {
    case 'ORGANIZATION':
      return scope.id === target.organizationId;
    case 'ORGANIZATIONAL_UNIT':
      return target.unitPathIds?.includes(scope.id) ?? false;
    case 'DEPARTMENT':
      return (
        (target.type === 'DEPARTMENT' && target.departmentId === scope.id) ||
        (target.type === 'TEAM' && target.departmentId === scope.id)
      );
    case 'TEAM':
      return target.type === 'TEAM' && target.teamId === scope.id;
  }
}

export function permissionIsGranted(
  grants: readonly { permission: string; scope: ScopeRef }[],
  permissionKey: string,
  target: AuthorizationTarget,
): boolean {
  return grants.some(
    (grant) =>
      grant.permission === permissionKey &&
      scopeContainsTarget(grant.scope, target),
  );
}
