'use client';

import type { ReactNode } from 'react';
import { hasPermission } from '../../lib/authorization/can';
import { useAuth } from '../../providers/auth-provider';
import { Forbidden } from '../auth/forbidden';
import { PageContainer, type PageWidth } from './page-container';
import { LoadingState } from './states';

/**
 * Batch 10A — what a page shows while the caller's permissions are being checked, and when they
 * do not include the page. PRESENTATION ONLY: it decides which screen to render, never what the
 * caller may do. The API checks every request itself; content behind this gate is still loaded
 * from endpoints that enforce their own permissions.
 *
 * While loading it renders a loading state in the page's own container width (no "Access
 * denied" flash and no width jump); once known, either the page or the shared denied state.
 */
export function PermissionGate({
  loading,
  allowed,
  width = 'default',
  loadingLabel = 'Checking your access…',
  deniedTitle,
  deniedMessage,
  deniedExtra,
  children,
}: {
  loading: boolean;
  allowed: boolean;
  width?: PageWidth;
  loadingLabel?: string;
  deniedTitle?: string;
  deniedMessage?: string;
  /** Shown after the denied message (e.g. a shortcut the caller may still use). */
  deniedExtra?: ReactNode;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <PageContainer width={width}>
        <LoadingState label={loadingLabel} />
      </PageContainer>
    );
  }
  if (!allowed) {
    return (
      // The denied state brings its own vertical spacing.
      <PageContainer width={width} padded={false}>
        <Forbidden title={deniedTitle} message={deniedMessage} />
        {deniedExtra && <div className="pb-10">{deniedExtra}</div>}
      </PageContainer>
    );
  }
  return <>{children}</>;
}

/** `PermissionGate` for "any of these permissions anywhere" (the common page-level check). */
export function RequirePermission({
  anyOf,
  width,
  deniedTitle,
  deniedMessage,
  deniedExtra,
  children,
}: {
  anyOf: readonly string[];
  width?: PageWidth;
  deniedTitle?: string;
  deniedMessage?: string;
  deniedExtra?: ReactNode;
  children: ReactNode;
}) {
  const { authorization, authorizationLoading } = useAuth();
  return (
    <PermissionGate
      loading={authorizationLoading}
      allowed={anyOf.some((key) => hasPermission(authorization, key))}
      width={width}
      deniedTitle={deniedTitle}
      deniedMessage={deniedMessage}
      deniedExtra={deniedExtra}
    >
      {children}
    </PermissionGate>
  );
}
