'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  getCurrentIdentity,
  login as loginRequest,
  logout as logoutRequest,
  logoutAll as logoutAllRequest,
  refreshAccessToken,
  setAccessToken,
  setPasswordChangeRequiredHandler,
  setSessionExpiredHandler,
} from '../lib/auth/api-client';
import type { AuthIdentity } from '../lib/auth/types';
import { authorizationApi } from '../lib/authorization/api';
import type { GrantSnapshot, ScopeType } from '../lib/authorization/types';
import { canFromSnapshot } from '../lib/authorization/can';

export interface AuthorizationScopeContext {
  /** Known containing scopes, ordered from broadest to narrowest. */
  ancestors?: Array<{ type: ScopeType | 'SYSTEM'; id?: string }>;
  organizationId?: string;
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  identity: AuthIdentity | null;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  clearAuth(): void;
  /** Batch 2: the password was changed (a required change is met). */
  passwordChanged(): void;
  authorization: GrantSnapshot | null;
  authorizationLoading: boolean;
  authorizationError: string | null;
  refreshAuthorization(): Promise<void>;
  can(
    permission: string,
    scope?: { type: ScopeType | 'SYSTEM'; id?: string },
    context?: AuthorizationScopeContext,
  ): boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const bootstrapStarted = useRef(false);
  const [authorization, setAuthorization] = useState<GrantSnapshot | null>(null);
  const [authorizationLoading, setAuthorizationLoading] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);

  const clearAuth = useCallback(() => {
    setAccessToken(null);
    setIdentity(null);
    setStatus('unauthenticated');
    setAuthorization(null);
    // Batch 10A: a failure of the previous account's snapshot must not mark the next sign-in's
    // (not yet requested) snapshot as finished.
    setAuthorizationError(null);
  }, []);

  const refreshAuthorization = useCallback(async () => {
    if (!identity) return;
    setAuthorizationLoading(true);
    try {
      setAuthorization(await authorizationApi.snapshot());
      setAuthorizationError(null);
    } catch (error) {
      setAuthorizationError(
        error instanceof Error ? error.message : 'Unable to load authorization.',
      );
    } finally {
      setAuthorizationLoading(false);
    }
  }, [identity]);

  const passwordChanged = useCallback(() => {
    setIdentity((current) => (current ? { ...current, mustChangePassword: false } : current));
  }, []);

  useEffect(() => {
    // Batch 2: the API refused a request until the password is changed (e.g. an administrator
    // required it while this session was open); the route guard then shows the change form.
    setPasswordChangeRequiredHandler(() =>
      setIdentity((current) =>
        current && !current.mustChangePassword ? { ...current, mustChangePassword: true } : current,
      ),
    );
    return () => setPasswordChangeRequiredHandler(() => undefined);
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(clearAuth);
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;

    void (async () => {
      const token = await refreshAccessToken();
      if (!token) {
        clearAuth();
        return;
      }
      try {
        const current = await getCurrentIdentity();
        setIdentity(current);
        setStatus('authenticated');
      } catch {
        clearAuth();
      }
    })();

    return () => setSessionExpiredHandler(() => undefined);
  }, [clearAuth]);

  useEffect(() => {
    // The authorization snapshot is refused until a required password change is made.
    if (status === 'authenticated' && identity && !identity.mustChangePassword) {
      const timer = window.setTimeout(() => void refreshAuthorization(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [status, identity, refreshAuthorization]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    setAccessToken(result.accessToken);
    setAuthorizationError(null);
    setIdentity(result.identity);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const logoutAll = useCallback(async () => {
    try {
      await logoutAllRequest();
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const can = useCallback(
    (
      permission: string,
      scope?: { type: ScopeType | 'SYSTEM'; id?: string },
      context?: AuthorizationScopeContext,
    ) => {
      return canFromSnapshot(authorization, permission, scope, context);
    },
    [authorization],
  );

  // Batch 10A: between signing in and the snapshot request starting (it is deferred a tick),
  // there is no snapshot and no request yet. Report that as loading, not as "no permissions", so
  // pages never flash "Access denied" before their content. A failed request is not loading.
  const snapshotPending =
    status === 'authenticated' &&
    identity !== null &&
    !identity.mustChangePassword &&
    authorization === null &&
    authorizationError === null;
  const authorizationLoadingState = authorizationLoading || snapshotPending;

  const value = useMemo(
    () => ({
      status,
      identity,
      login,
      logout,
      logoutAll,
      clearAuth,
      passwordChanged,
      authorization,
      authorizationLoading: authorizationLoadingState,
      authorizationError,
      refreshAuthorization,
      can,
    }),
    [
      passwordChanged,
      status,
      identity,
      login,
      logout,
      logoutAll,
      clearAuth,
      authorization,
      authorizationLoadingState,
      authorizationError,
      refreshAuthorization,
      can,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}
