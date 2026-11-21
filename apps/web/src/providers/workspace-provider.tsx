'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  navContextFromSnapshot,
  navContextFromWorkspace,
  pickOrganization,
} from '../lib/navigation/context';
import { PREFERENCE_KEYS, readPreference, writePreference } from '../lib/navigation/preferences';
import type { NavContext } from '../lib/navigation/registry';
import { workspaceApi } from '../lib/workspace/api';
import type { Workspace, WorkspaceOrganization } from '../lib/workspace/types';
import { useAuth } from './auth-provider';

export type WorkspaceStatus = 'loading' | 'ready' | 'fallback';

interface WorkspaceContextValue {
  /** `fallback`: GET /auth/me/workspace failed and the authorization snapshot is used. */
  status: WorkspaceStatus;
  workspace: Workspace | null;
  organizations: readonly WorkspaceOrganization[];
  selectedOrganization: WorkspaceOrganization | null;
  selectOrganization(organizationId: string): void;
  /** `null` while the context is still loading. */
  navContext: NavContext | null;
  refresh(): Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Loads the caller's workspace context for the shell. It never gates access: the API stays
 * authoritative, and when the endpoint is unavailable the shell degrades to the authorization
 * snapshot instead of failing.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, authorization, authorizationLoading } = useAuth();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>('loading');
  const [preferredId, setPreferredId] = useState<string | null>(() =>
    readPreference(PREFERENCE_KEYS.organization),
  );

  const refresh = useCallback(async () => {
    try {
      const next = await workspaceApi.current();
      setWorkspace(next);
      setStatus('ready');
    } catch {
      setWorkspace(null);
      setStatus('fallback');
    }
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [authStatus, refresh]);

  const organizations = useMemo(() => workspace?.organizations ?? [], [workspace]);
  const selectedOrganization = useMemo(
    () => pickOrganization(organizations, preferredId),
    [organizations, preferredId],
  );

  const selectOrganization = useCallback((organizationId: string) => {
    setPreferredId(organizationId);
    writePreference(PREFERENCE_KEYS.organization, organizationId);
  }, []);

  const navContext = useMemo<NavContext | null>(() => {
    if (status === 'ready' && workspace) {
      return navContextFromWorkspace(workspace, selectedOrganization);
    }
    if (status === 'fallback' && !authorizationLoading) {
      return navContextFromSnapshot(authorization);
    }
    return null;
  }, [status, workspace, selectedOrganization, authorization, authorizationLoading]);

  const value = useMemo(
    () => ({
      status,
      workspace,
      organizations,
      selectedOrganization,
      selectOrganization,
      navContext,
      refresh,
    }),
    [
      status,
      workspace,
      organizations,
      selectedOrganization,
      selectOrganization,
      navContext,
      refresh,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}

/** For components that may render outside the shell (e.g. in unit tests). */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
