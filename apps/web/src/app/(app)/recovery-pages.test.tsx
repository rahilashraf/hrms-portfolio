import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordPage from './forgot-password/page';
import ResetPasswordPage from './reset-password/page';
import VerifyEmailPage from './verify-email/page';
import AcceptInvitationPage from './accept-invitation/page';
import ResendVerificationPage from './resend-verification/page';

const { api } = vi.hoisted(() => ({
  api: {
    forgotPassword: vi.fn(),
    acceptInvitation: vi.fn(),
    resendVerification: vi.fn(),
    resetPassword: vi.fn(),
    verifyEmail: vi.fn(),
  },
}));

vi.mock('../../lib/auth/api-client', () => api);

describe('recovery pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.forgotPassword.mockResolvedValue({
      message: 'If the account is eligible, recovery instructions will be sent.',
    });
    api.resetPassword.mockResolvedValue({ success: true });
    api.acceptInvitation.mockResolvedValue({ success: true });
    api.resendVerification.mockResolvedValue({
      message: 'If the account requires verification, instructions will be sent.',
    });
    api.verifyEmail.mockResolvedValue({ success: true });
  });

  afterEach(cleanup);

  it('submits the generic forgot-password request response', async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send instructions' }));

    expect(await screen.findByRole('status')).toHaveTextContent('If the account is eligible');
    expect(api.forgotPassword).toHaveBeenCalledWith('person@example.com');
  });

  it('consumes a reset token from the fragment and removes it from the URL', async () => {
    window.history.replaceState(null, '', '/reset-password#token=one-time-token');
    render(<ResetPasswordPage />);

    await waitFor(() => expect(window.location.hash).toBe(''));
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a sufficiently long passphrase' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'a sufficiently long passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() =>
      expect(api.resetPassword).toHaveBeenCalledWith(
        'one-time-token',
        'a sufficiently long passphrase',
      ),
    );
    expect(window.location.href).not.toContain('one-time-token');
  });

  it('verifies an email token from the fragment without retaining it in the URL', async () => {
    window.history.replaceState(null, '', '/verify-email#token=verification-token');
    render(<VerifyEmailPage />);

    expect(await screen.findByText('Your email address is verified.')).toBeInTheDocument();
    expect(api.verifyEmail).toHaveBeenCalledWith('verification-token');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('verification-token');
  });

  it('accepts an invitation using a fragment token', async () => {
    window.history.replaceState(null, '', '/accept-invitation#token=invite-token');
    render(<AcceptInvitationPage />);
    await waitFor(() => expect(window.location.hash).toBe(''));
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'another secure passphrase' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'another secure passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    await waitFor(() =>
      expect(api.acceptInvitation).toHaveBeenCalledWith(
        'invite-token',
        'another secure passphrase',
      ),
    );
  });

  it('resends verification with an enumeration-safe response', async () => {
    render(<ResendVerificationPage />);
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'If the account requires verification',
    );
    expect(api.resendVerification).toHaveBeenCalledWith('person@example.com');
  });
});
