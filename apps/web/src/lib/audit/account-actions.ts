/**
 * Batch 2: readable names of the sign-in and account security actions, for the audit viewer's
 * table and its action suggestions. Unknown actions are shown by their code.
 */
export const ACCOUNT_SECURITY_ACTIONS: Readonly<Record<string, string>> = {
  AUTH_LOGIN_SUCCESS: 'Signed in',
  AUTH_LOGIN_FAILED: 'Sign-in failed',
  AUTH_ACCOUNT_TEMP_LOCKED: 'Locked after wrong passwords',
  AUTH_SESSION_CREATED: 'Session started',
  AUTH_SESSION_REVOKED: 'Session ended',
  AUTH_OTHER_SESSIONS_REVOKED: 'Signed out other sessions',
  AUTH_LOGOUT: 'Signed out',
  AUTH_LOGOUT_ALL: 'Signed out everywhere',
  AUTH_ALL_SESSIONS_REVOKED: 'All sessions ended',
  AUTH_REFRESH_TOKEN_REUSE: 'Reused sign-in token detected',
  AUTH_PASSWORD_CHANGED: 'Password changed',
  AUTH_PASSWORD_CHANGE_FAILED: 'Password change refused',
  AUTH_PASSWORD_RESET_REQUESTED: 'Password reset email',
  AUTH_PASSWORD_RESET_COMPLETED: 'Password reset',
  AUTH_INVITATION_CREATED: 'Invitation created',
  AUTH_INVITATION_ACCEPTED: 'Invitation accepted',
  AUTH_EMAIL_VERIFICATION_SENT: 'Verification email',
  AUTH_EMAIL_VERIFIED: 'Email verified',
  AUTH_RECORDS_PRUNED: 'Old sign-in records deleted',
  EMPLOYEE_ACCOUNT_INVITED: 'Login invited',
  EMPLOYEE_ACCOUNT_INVITATION_RESENT: 'Invitation resent',
  EMPLOYEE_ACCOUNT_INVITATION_CANCELLED: 'Invitation cancelled',
  EMPLOYEE_ACCOUNT_INVITATION_FAILED: 'Invitation not delivered',
  EMPLOYEE_ACCOUNT_DISABLED: 'Login disabled',
  EMPLOYEE_ACCOUNT_ENABLED: 'Login enabled',
  EMPLOYEE_ACCOUNT_PASSWORD_CHANGE_REQUIRED: 'Password change required',
  EMPLOYEE_ACCOUNT_SESSIONS_REVOKED: 'Signed out by an administrator',
  EMPLOYEE_ACCOUNT_PASSWORD_RESET_SENT: 'Reset link sent by an administrator',
  EMPLOYEE_ACCOUNT_PASSWORD_RESET_FAILED: 'Reset link not delivered',
  EMPLOYEE_ACCOUNT_UNLOCKED: 'Login unlocked',
};

export function auditActionLabel(action: string): string | null {
  return Object.hasOwn(ACCOUNT_SECURITY_ACTIONS, action) ? ACCOUNT_SECURITY_ACTIONS[action]! : null;
}
