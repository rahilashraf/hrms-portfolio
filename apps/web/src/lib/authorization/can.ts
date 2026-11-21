import type { GrantSnapshot, ScopeType } from './types';

export type AuthorizationScope = { type: ScopeType | 'SYSTEM'; id?: string };
export interface AuthorizationContext {
  ancestors?: AuthorizationScope[];
}

export function hasPermission(
  snapshot: GrantSnapshot | null | undefined,
  permission: string,
): boolean {
  return snapshot?.permissions.some((item) => item.key === permission) ?? false;
}

export function canFromSnapshot(
  snapshot: GrantSnapshot | null | undefined,
  permission: string,
  scope?: AuthorizationScope,
  context?: AuthorizationContext,
): boolean {
  const grants = snapshot?.permissions.filter((item) => item.key === permission) ?? [];
  if (!scope)
    return grants.some((grant) => grant.scopes.some((candidate) => candidate.type === 'SYSTEM'));
  return grants.some((grant) =>
    grant.scopes.some((candidate) => {
      if (candidate.type === 'SYSTEM') return true;
      if (candidate.type === scope.type && candidate.id === scope.id) return true;
      return (
        context?.ancestors?.some(
          (ancestor) => ancestor.type === candidate.type && ancestor.id === candidate.id,
        ) ?? false
      );
    }),
  );
}
