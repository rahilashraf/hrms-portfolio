import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { AccountSessions } from './account-sessions';
import { ChangePasswordForm } from './change-password-form';
import { RequiredPasswordChange } from './required-password-change';

const mocks = vi.hoisted(() => ({
  api: {
    changePassword: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
  },
  auth: {
    status: 'authenticated' as 'authenticated' | 'unauthenticated',
    identity: { id: 'user-1', email: 'ada@example.com', mustChangePassword: true },
    logout: vi.fn(),
    passwordChanged: vi.fn(),
  },
  replace: vi.fn(),
}));

vi.mock('../../lib/auth/api-client', () => mocks.api);
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => mocks.auth }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));

const CURRENT = 'Correct-Horse-Battery-42!';
const NEXT = 'Another-Long-Passphrase-7';

function fill(current: string, next: string, confirmation = next) {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: confirmation },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.status = 'authenticated';
  mocks.auth.identity = { id: 'user-1', email: 'ada@example.com', mustChangePassword: true };
});
afterEach(cleanup);

describe('ChangePasswordForm', () => {
  it('validates on the field before calling the API', async () => {
    render(<ChangePasswordForm onChanged={vi.fn()} />);
    fill('', 'short', 'different');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Enter your current password.')).toBeInTheDocument();
    expect(screen.getByText('Use 12 to 128 characters.')).toBeInTheDocument();
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');

    fill(CURRENT, CURRENT);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Choose a password different from the current one.'),
    ).toBeInTheDocument();
    expect(mocks.api.changePassword).not.toHaveBeenCalled();
  });

  it('changes the password and reports the sessions signed out', async () => {
    mocks.api.changePassword.mockResolvedValue({ success: true, revokedSessionCount: 2 });
    const onChanged = vi.fn();
    render(<ChangePasswordForm onChanged={onChanged} />);
    fill(CURRENT, NEXT);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ revokedSessionCount: 2 }));
    expect(mocks.api.changePassword).toHaveBeenCalledWith(CURRENT, NEXT);
    // The form is cleared: no password stays on screen.
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('shows the API refusals on the right field or as a form message', async () => {
    render(<ChangePasswordForm onChanged={vi.fn()} />);
    mocks.api.changePassword.mockRejectedValueOnce(
      new AuthApiError('validation', 400, undefined, { code: 'CURRENT_PASSWORD_INVALID' }),
    );
    fill('wrong-password', NEXT);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The current password is incorrect.')).toBeInTheDocument();

    mocks.api.changePassword.mockRejectedValueOnce(
      new AuthApiError('rate-limited', 429, undefined, {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 600,
      }),
    );
    fill(CURRENT, NEXT);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Too many attempts — please wait about 10 minutes and try again.'),
    ).toBeInTheDocument();

    mocks.api.changePassword.mockRejectedValueOnce(
      new AuthApiError('conflict', 409, undefined, { code: 'PASSWORD_CHANGED_CONCURRENTLY' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/changed meanwhile/)).toBeInTheDocument();
  });
});

describe('AccountSessions', () => {
  const sessions = [
    {
      id: 'session-current',
      current: true,
      createdAt: '2026-10-29T08:00:00.000Z',
      lastUsedAt: '2026-10-29T09:00:00.000Z',
      expiresAt: '2026-11-28T08:00:00.000Z',
      ipAddress: '203.0.113.9',
      browser: 'Firefox',
      os: 'Windows',
    },
    {
      id: 'session-phone',
      current: false,
      createdAt: '2026-10-20T08:00:00.000Z',
      lastUsedAt: '2026-10-28T19:00:00.000Z',
      expiresAt: '2026-11-19T08:00:00.000Z',
      ipAddress: null,
      browser: 'Safari',
      os: 'iOS',
    },
  ];

  it('lists the sessions and signs out another one after confirmation', async () => {
    mocks.api.listSessions
      .mockResolvedValueOnce({ items: sessions })
      .mockResolvedValueOnce({ items: [sessions[0]] });
    mocks.api.revokeSession.mockResolvedValue({ success: true });
    render(<AccountSessions />);
    const list = await screen.findByRole('list', { name: 'Your sessions' });
    expect(within(list).getByText('This device')).toBeInTheDocument();
    expect(within(list).getByText(/from 203\.0\.113\.9/)).toBeInTheDocument();
    // The current session has no "Sign out" here (the shell's sign-out ends it).
    expect(within(list).getAllByRole('button')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out session' }));
    await waitFor(() => expect(mocks.api.revokeSession).toHaveBeenCalledWith('session-phone'));
    expect(await screen.findByText('Safari on iOS was signed out.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out all other sessions' })).toBeNull();
  });

  it('signs out every other session only when confirmed', async () => {
    mocks.api.listSessions.mockResolvedValue({ items: sessions });
    mocks.api.revokeOtherSessions.mockResolvedValue({ success: true, revokedSessionCount: 1 });
    render(<AccountSessions />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out all other sessions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mocks.api.revokeOtherSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all other sessions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out other sessions' }));
    expect(await screen.findByText('One other session was signed out.')).toBeInTheDocument();
  });
});

describe('RequiredPasswordChange', () => {
  it('requires the new password, then marks it changed and opens the dashboard', async () => {
    mocks.api.changePassword.mockResolvedValue({ success: true, revokedSessionCount: 0 });
    render(<RequiredPasswordChange />);
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    fill(CURRENT, NEXT);
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    await waitFor(() => expect(mocks.auth.passwordChanged).toHaveBeenCalled());
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('lets the user sign out instead, and sends a signed-out visitor to sign in', async () => {
    mocks.auth.logout.mockResolvedValue(undefined);
    render(<RequiredPasswordChange />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));

    cleanup();
    mocks.replace.mockClear();
    mocks.auth.status = 'unauthenticated';
    render(<RequiredPasswordChange />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login'));
  });
});
