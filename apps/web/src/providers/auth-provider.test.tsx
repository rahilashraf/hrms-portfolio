import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-provider';
import { ProtectedRoute } from '../components/auth/protected-route';
import LoginPage from '../app/(app)/login/page';
import DashboardPage from '../app/(app)/(authenticated)/dashboard/page';
import { AuthApiError } from '../lib/auth/types';

const { routerReplace, api } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
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
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn() }),
}));

vi.mock('../lib/auth/api-client', () => api);

const identity = {
  id: 'user-1',
  personId: 'person-1',
  email: 'person@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

function AuthState() {
  const auth = useAuth();
  return (
    <>
      <div data-testid="status">{auth.status}</div>
      <div>{auth.identity?.email}</div>
      <button onClick={() => void auth.login('person@example.com', 'valid-password')}>
        Context login
      </button>
      <button onClick={() => void auth.logout().catch(() => undefined)}>Context logout</button>
    </>
  );
}

describe('AuthProvider and protected navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.refreshAccessToken.mockResolvedValue('access-token');
    api.getCurrentIdentity.mockResolvedValue(identity);
    api.login.mockResolvedValue({ accessToken: 'login-token', identity });
    api.logout.mockResolvedValue(undefined);
    api.logoutAll.mockResolvedValue(undefined);
    api.refreshAccessToken.mockImplementation(async () => {
      api.setAccessToken('access-token');
      return 'access-token';
    });
  });

  afterEach(cleanup);

  it('bootstraps from the HttpOnly refresh cookie and fetches the identity', async () => {
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(api.refreshAccessToken).toHaveBeenCalledOnce();
    expect(api.getCurrentIdentity).toHaveBeenCalledOnce();
    expect(api.setAccessToken).toHaveBeenCalledWith('access-token');
  });

  it('resolves failed bootstrap as unauthenticated without rendering protected content', async () => {
    api.refreshAccessToken.mockResolvedValue(null);
    render(
      <AuthProvider>
        <ProtectedRoute>
          <div>Protected content</div>
        </ProtectedRoute>
      </AuthProvider>,
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(api.getCurrentIdentity).not.toHaveBeenCalled();
  });

  it('logs in successfully and keeps the returned access token in memory', async () => {
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    fireEvent.click(screen.getByRole('button', { name: 'Context login' }));

    await waitFor(() => expect(api.setAccessToken).toHaveBeenCalledWith('login-token'));
    expect(api.login).toHaveBeenCalledWith('person@example.com', 'valid-password');
    expect(screen.getByText('person@example.com')).toBeInTheDocument();
  });

  it('redirects authenticated users away from login', async () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/dashboard'));
  });

  it('shows a generic invalid-credentials message on login failure', async () => {
    api.refreshAccessToken.mockResolvedValue(null);
    api.login.mockRejectedValue(new AuthApiError('invalid-credentials', 401));
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    await screen.findByRole('heading', { name: 'Sign in to your account' });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'person@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'incorrect-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or password is incorrect.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('401');
  });

  it('clears local auth after logout even if the logout request fails', async () => {
    api.logout.mockRejectedValue(new Error('network unavailable'));
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    fireEvent.click(screen.getByRole('button', { name: 'Context logout' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(api.setAccessToken).toHaveBeenLastCalledWith(null);
  });

  it('sends a user who must change their password to the change form before anything loads', async () => {
    api.getCurrentIdentity.mockResolvedValue({
      ...identity,
      mustChangePassword: true,
    });
    render(
      <AuthProvider>
        <ProtectedRoute>
          <DashboardPage />
        </ProtectedRoute>
      </AuthProvider>,
    );

    expect(await screen.findByText(/opening the password change/i)).toBeInTheDocument();
    // The redirect runs in an effect after that text renders: wait for it.
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/account/change-password'));
    expect(screen.queryByRole('heading', { name: /welcome/i })).not.toBeInTheDocument();
  });
});
