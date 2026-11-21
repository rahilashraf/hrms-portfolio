import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-provider';

/**
 * Batch 10A — between sign-in and the authorization snapshot arriving, the provider reports
 * "loading", never "loaded without permissions"; that state is what made pages flash "Access
 * denied". A failed snapshot is not loading (pages then show their denied/error state).
 */
const { api, snapshot } = vi.hoisted(() => ({
  api: {
    getCurrentIdentity: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    refreshAccessToken: vi.fn(),
    setAccessToken: vi.fn(),
    setSessionExpiredHandler: vi.fn(),
    setPasswordChangeRequiredHandler: vi.fn(),
  },
  snapshot: vi.fn(),
}));
vi.mock('../lib/auth/api-client', () => api);
vi.mock('../lib/authorization/api', () => ({ authorizationApi: { snapshot } }));

const identity = {
  id: 'user-1',
  personId: 'person-1',
  email: 'person@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const frames: Array<{ status: string; loading: boolean; hasSnapshot: boolean }> = [];
function Probe() {
  const auth = useAuth();
  frames.push({
    status: auth.status,
    loading: auth.authorizationLoading,
    hasSnapshot: auth.authorization !== null,
  });
  return (
    <>
      <p data-testid="state">
        {auth.status}/{auth.authorizationLoading ? 'loading' : 'ready'}/
        {auth.authorization ? 'snapshot' : 'none'}
      </p>
      <button type="button" onClick={() => void auth.logout()}>
        Sign out
      </button>
      <button type="button" onClick={() => void auth.login('b@example.com', 'secret-password')}>
        Sign in
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  frames.length = 0;
  api.refreshAccessToken.mockResolvedValue('token');
  api.getCurrentIdentity.mockResolvedValue(identity);
});
afterEach(cleanup);

describe('AuthProvider authorization loading (Batch 10A)', () => {
  it('never reports "authenticated, not loading, no snapshot" before the snapshot arrives', async () => {
    let release!: (value: unknown) => void;
    snapshot.mockReturnValue(new Promise((resolve) => (release = resolve)));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated/loading/none'),
    );
    release({ userId: 'user-1', permissions: [{ key: 'organization.read', scopes: [] }] });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated/ready/snapshot'),
    );
    const flash = frames.filter(
      (frame) => frame.status === 'authenticated' && !frame.loading && !frame.hasSnapshot,
    );
    expect(flash).toEqual([]);
  });

  it('stops loading when the snapshot fails (the page then shows its error/denied state)', async () => {
    snapshot.mockRejectedValue(new Error('unavailable'));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated/ready/none'),
    );
  });

  it('is not loading while a required password change blocks the snapshot', async () => {
    api.getCurrentIdentity.mockResolvedValue({ ...identity, mustChangePassword: true });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated/ready/none'),
    );
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("a failed snapshot of one account does not end the next sign-in's loading early", async () => {
    snapshot.mockRejectedValueOnce(new Error('unavailable'));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated/ready/none'),
    );
    api.logout.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('unauthenticated/ready/none'),
    );
    let release!: (value: unknown) => void;
    snapshot.mockReturnValue(new Promise((resolve) => (release = resolve)));
    api.login.mockResolvedValue({ accessToken: 't2', identity: { ...identity, id: 'user-2' } });
    frames.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated/loading/none'),
    );
    release({ userId: 'user-2', permissions: [] });
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated/ready/snapshot'),
    );
    expect(
      frames.filter((f) => f.status === 'authenticated' && !f.loading && !f.hasSnapshot),
    ).toEqual([]);
  });
});
