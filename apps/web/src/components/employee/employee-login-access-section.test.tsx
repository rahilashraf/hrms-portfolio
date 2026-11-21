import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { EmployeeAccount } from '../../lib/employee/types';
import { EmployeeLoginAccessSection } from './employee-login-access-section';

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  inviteAccount: vi.fn(),
  resendAccountInvitation: vi.fn(),
  cancelAccountInvitation: vi.fn(),
  disableAccount: vi.fn(),
  enableAccount: vi.fn(),
  requireAccountPasswordChange: vi.fn(),
  sendAccountPasswordReset: vi.fn(),
  signOutAccount: vi.fn(),
  unlockAccount: vi.fn(),
}));

vi.mock('../../lib/employee/api', () => ({ employeeApi: mocks }));

const NONE = {
  invite: false,
  resend: false,
  cancel: false,
  disable: false,
  enable: false,
  requirePasswordChange: false,
  sendPasswordReset: false,
  signOut: false,
  unlock: false,
};
const account = (overrides: Partial<EmployeeAccount>): EmployeeAccount => ({
  employeeId: 'employee-1',
  status: 'NOT_INVITED',
  email: 'ada@example.com',
  invitationExpiresAt: null,
  lastLoginAt: null,
  mustChangePassword: false,
  lockedUntil: null,
  activeSessionCount: 0,
  actions: NONE,
  ...overrides,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('EmployeeLoginAccessSection', () => {
  it('invites with the address on file and shows the invited status', async () => {
    mocks.account.mockResolvedValue(account({ actions: { ...NONE, invite: true } }));
    mocks.inviteAccount.mockResolvedValue(
      account({
        status: 'INVITED',
        invitationExpiresAt: '2026-10-15T12:00:00.000Z',
        actions: { ...NONE, resend: true, cancel: true },
      }),
    );
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);

    expect(await screen.findByTestId('login-status')).toHaveTextContent('Not invited');
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    const form = screen.getByRole('form', { name: 'Invite employee' });
    expect(within(form).getByLabelText('Email address')).toHaveValue('ada@example.com');
    fireEvent.click(within(form).getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByText('Invitation sent.')).toBeInTheDocument();
    expect(mocks.inviteAccount).toHaveBeenCalledWith('employee-1', 'ada@example.com');
    expect(screen.getByTestId('login-status')).toHaveTextContent('Invited');
    expect(screen.getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });

  it('explains a missing email provider and reloads the true status', async () => {
    mocks.account.mockResolvedValue(account({ actions: { ...NONE, invite: true } }));
    mocks.inviteAccount.mockRejectedValue(
      new AuthApiError('service-unavailable', 503, undefined, {
        code: 'ACCOUNT_EMAIL_UNAVAILABLE',
      }),
    );
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Connect Google Workspace/);
    await waitFor(() => expect(mocks.account).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('login-status')).toHaveTextContent('Not invited');
  });

  it('reports a delivery failure without claiming the invitation was sent', async () => {
    mocks.account.mockResolvedValue(
      account({ status: 'INVITATION_EXPIRED', actions: { ...NONE, resend: true, cancel: true } }),
    );
    mocks.resendAccountInvitation.mockRejectedValue(
      new AuthApiError('service-unavailable', 503, undefined, {
        code: 'ACCOUNT_EMAIL_DELIVERY_FAILED',
      }),
    );
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);

    expect(await screen.findByText(/expired or was not delivered/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be sent/);
    // The address was unchanged, so no new address is sent.
    expect(mocks.resendAccountInvitation).toHaveBeenCalledWith('employee-1', undefined);
    expect(screen.queryByText(/Invitation sent again/)).not.toBeInTheDocument();
  });

  it('cancels an invitation only after confirmation', async () => {
    mocks.account.mockResolvedValue(
      account({ status: 'INVITED', actions: { ...NONE, resend: true, cancel: true } }),
    );
    mocks.cancelAccountInvitation.mockResolvedValue(
      account({ actions: { ...NONE, invite: true } }),
    );
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel invitation' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel the invitation?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep invitation' }));
    expect(mocks.cancelAccountInvitation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel invitation',
      }),
    );
    expect(await screen.findByText('Invitation cancelled.')).toBeInTheDocument();
    expect(screen.getByTestId('login-status')).toHaveTextContent('Not invited');
  });

  it('disables with an optional reason and re-enables after confirmation', async () => {
    mocks.account.mockResolvedValue(
      account({
        status: 'ACTIVE',
        lastLoginAt: '2026-10-01T09:00:00.000Z',
        actions: { ...NONE, disable: true },
      }),
    );
    mocks.disableAccount.mockResolvedValue(
      account({ status: 'DISABLED', actions: { ...NONE, enable: true } }),
    );
    mocks.enableAccount.mockResolvedValue(
      account({ status: 'ACTIVE', actions: { ...NONE, disable: true } }),
    );
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disable login' }));
    const form = screen.getByRole('form', { name: 'Disable login' });
    expect(form).toHaveTextContent(/attendance PIN are kept/);
    fireEvent.change(within(form).getByLabelText('Reason (optional)'), {
      target: { value: 'Left on leave' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Disable login' }));
    await waitFor(() => expect(mocks.disableAccount).toHaveBeenCalled());
    expect(await screen.findByText(/signed out/)).toBeInTheDocument();
    expect(mocks.disableAccount).toHaveBeenCalledWith('employee-1', 'Left on leave');
    expect(screen.getByTestId('login-status')).toHaveTextContent('Disabled');

    fireEvent.click(screen.getByRole('button', { name: 'Enable login' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Re-enable' }),
    );
    expect(await screen.findByText('Login access re-enabled.')).toBeInTheDocument();
    expect(screen.getByTestId('login-status')).toHaveTextContent('Active');
  });

  it('secures an active login: reset link, required change (signing out by default), sign-out and unlock', async () => {
    const active = (overrides: Partial<EmployeeAccount> = {}) =>
      account({
        status: 'ACTIVE',
        activeSessionCount: 2,
        actions: {
          ...NONE,
          disable: true,
          requirePasswordChange: true,
          sendPasswordReset: true,
          signOut: true,
        },
        ...overrides,
      });
    mocks.account.mockResolvedValue(active());
    mocks.sendAccountPasswordReset.mockResolvedValue(active());
    mocks.requireAccountPasswordChange.mockResolvedValue(
      active({
        mustChangePassword: true,
        activeSessionCount: 0,
        actions: { ...NONE, disable: true, sendPasswordReset: true },
      }),
    );
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);
    const security = await screen.findByRole('list', { name: 'Login security' });
    expect(security).toHaveTextContent('2 active sessions');

    fireEvent.click(screen.getByRole('button', { name: 'Send password reset link' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send link' }),
    );
    expect(await screen.findByText(/Password reset link sent/)).toBeInTheDocument();
    expect(mocks.sendAccountPasswordReset).toHaveBeenCalledWith('employee-1');

    fireEvent.click(screen.getByRole('button', { name: 'Require password change' }));
    const form = screen.getByRole('form', { name: 'Require password change' });
    const signOut = within(form).getByLabelText('Sign the employee out everywhere now');
    expect(signOut).toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Require password change' }));
    await waitFor(() =>
      expect(mocks.requireAccountPasswordChange).toHaveBeenCalledWith('employee-1', true),
    );
    expect(await screen.findByText(/signed out everywhere/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Login security' })).toHaveTextContent(
      'Must choose a new password',
    );
    expect(screen.queryByRole('button', { name: 'Require password change' })).toBeNull();
  });

  it('explains a missing email provider when sending a reset link, and keeps the other actions', async () => {
    const active = account({
      status: 'ACTIVE',
      activeSessionCount: 1,
      actions: {
        ...NONE,
        disable: true,
        requirePasswordChange: true,
        sendPasswordReset: true,
        signOut: true,
      },
    });
    mocks.account.mockResolvedValue(active);
    mocks.sendAccountPasswordReset.mockRejectedValue(
      new AuthApiError('service-unavailable', 503, undefined, {
        code: 'ACCOUNT_EMAIL_UNAVAILABLE',
      }),
    );
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Send password reset link' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send link' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Account email is not set up. Connect Google Workspace with Gmail sending for this organization, or ask the system administrator to configure the SMTP server, then try again.',
    );
    expect(screen.queryByText(/Password reset link sent/)).toBeNull();
    // Actions that need no email stay available.
    expect(screen.getByRole('button', { name: 'Require password change' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeEnabled();
  });

  it('can require a change without signing out, and signs out or unlocks after confirmation', async () => {
    const locked = account({
      status: 'ACTIVE',
      activeSessionCount: 1,
      lockedUntil: '2026-10-29T12:00:00.000Z',
      actions: { ...NONE, requirePasswordChange: true, signOut: true, unlock: true },
    });
    mocks.account.mockResolvedValue(locked);
    mocks.requireAccountPasswordChange.mockResolvedValue(locked);
    mocks.signOutAccount.mockResolvedValue({ ...locked, activeSessionCount: 0 });
    mocks.unlockAccount.mockResolvedValue({
      ...locked,
      lockedUntil: null,
      actions: { ...locked.actions, unlock: false },
    });
    render(<EmployeeLoginAccessSection employeeId="employee-1" />);
    expect(await screen.findByRole('list', { name: 'Login security' })).toHaveTextContent(
      /Locked after wrong passwords until/,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Require password change' }));
    const form = screen.getByRole('form', { name: 'Require password change' });
    fireEvent.click(within(form).getByLabelText('Sign the employee out everywhere now'));
    fireEvent.click(within(form).getByRole('button', { name: 'Require password change' }));
    await waitFor(() =>
      expect(mocks.requireAccountPasswordChange).toHaveBeenCalledWith('employee-1', false),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Sign out everywhere',
      }),
    );
    expect(await screen.findByText('All sessions were signed out.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unlock' }),
    );
    expect(await screen.findByText('Login unlocked.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
  });

  it('hides itself where the API refuses (outside scope or one’s own login)', async () => {
    mocks.account.mockRejectedValue(new AuthApiError('forbidden', 403));
    const { container } = render(<EmployeeLoginAccessSection employeeId="employee-1" />);
    await waitFor(() => expect(mocks.account).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  describe('Security remediation M1: scope-limited actions', () => {
    const capability = (allowed: boolean, reason: string | null = null) =>
      ({ allowed, reason }) as NonNullable<EmployeeAccount['capabilities']>['enable'];
    const capabilities = (
      overrides: Partial<NonNullable<EmployeeAccount['capabilities']>>,
    ): NonNullable<EmployeeAccount['capabilities']> => ({
      invite: capability(false),
      resend: capability(false),
      cancel: capability(false),
      disable: capability(false),
      enable: capability(false),
      requirePasswordChange: capability(false),
      sendPasswordReset: capability(false),
      signOut: capability(false),
      unlock: capability(false),
      ...overrides,
    });

    it('lists actions outside the administrator’s scope with safe reasons, and offers no button for them', async () => {
      mocks.account.mockResolvedValue(
        account({
          status: 'ACTIVE',
          activeSessionCount: 2,
          actions: { ...NONE, disable: true, signOut: true },
          capabilities: capabilities({
            disable: capability(true),
            signOut: capability(true),
            sendPasswordReset: capability(false, 'NO_CURRENT_ASSIGNMENT'),
            requirePasswordChange: capability(false, 'NO_CURRENT_ASSIGNMENT'),
          }),
        }),
      );
      render(<EmployeeLoginAccessSection employeeId="employee-1" />);
      const list = await screen.findByRole('list', { name: 'Unavailable login actions' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(list).toHaveTextContent(
        'Send password reset link, Require password change: This needs a current assignment in your administrative scope.',
      );
      expect(screen.getByRole('button', { name: 'Disable login' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Send password reset link' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Require password change' })).toBeNull();
    });

    it('groups reasons and shows nothing when every applicable action is allowed', async () => {
      mocks.account.mockResolvedValueOnce(
        account({
          status: 'DISABLED',
          capabilities: capabilities({
            enable: capability(false, 'ACCESS_OUTSIDE_SCOPE'),
          }),
        }),
      );
      const first = render(<EmployeeLoginAccessSection employeeId="employee-1" />);
      expect(
        await screen.findByRole('list', { name: 'Unavailable login actions' }),
      ).toHaveTextContent(
        'Enable login: This person has access outside your administrative scope.',
      );
      first.unmount();

      mocks.account.mockResolvedValueOnce(
        account({
          status: 'ACTIVE',
          actions: { ...NONE, disable: true },
          capabilities: capabilities({ disable: capability(true) }),
        }),
      );
      render(<EmployeeLoginAccessSection employeeId="employee-1" />);
      expect(await screen.findByRole('button', { name: 'Disable login' })).toBeEnabled();
      expect(screen.queryByTestId('login-access-unavailable')).toBeNull();
    });

    it('shows the server’s safe reason when stale flags meet a refusal, then reloads', async () => {
      const stale = account({
        status: 'DISABLED',
        actions: { ...NONE, enable: true },
        capabilities: capabilities({ enable: capability(true) }),
      });
      const fresh = account({
        status: 'DISABLED',
        capabilities: capabilities({ enable: capability(false, 'ACCESS_OUTSIDE_SCOPE') }),
      });
      mocks.account.mockResolvedValueOnce(stale).mockResolvedValue(fresh);
      mocks.enableAccount.mockRejectedValue(
        new AuthApiError('forbidden', 403, undefined, {
          statusCode: 403,
          code: 'ACCOUNT_OUTSIDE_SCOPE',
          reason: 'ACCESS_OUTSIDE_SCOPE',
          message: 'This person has access outside your administrative scope.',
        }),
      );
      render(<EmployeeLoginAccessSection employeeId="employee-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Enable login' }));
      fireEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Re-enable' }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This person has access outside your administrative scope. An administrator who covers all of their access can do this.',
      );
      expect(
        await screen.findByRole('list', { name: 'Unavailable login actions' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Enable login' })).toBeNull();
      expect(mocks.enableAccount).toHaveBeenCalledTimes(1);
    });

    it('keeps working against a response without capability flags', async () => {
      mocks.account.mockResolvedValue(
        account({ status: 'ACTIVE', actions: { ...NONE, disable: true } }),
      );
      render(<EmployeeLoginAccessSection employeeId="employee-1" />);
      expect(await screen.findByRole('button', { name: 'Disable login' })).toBeEnabled();
      expect(screen.queryByTestId('login-access-unavailable')).toBeNull();
    });
  });
});
