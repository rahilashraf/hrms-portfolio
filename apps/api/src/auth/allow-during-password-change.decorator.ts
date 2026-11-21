import { SetMetadata } from '@nestjs/common';

export const ALLOW_DURING_PASSWORD_CHANGE = 'hrms:allow-during-password-change';

/**
 * Batch 2: marks an authenticated route a user who must change their password may still use
 * (their identity, the password change itself, signing out and their sessions). Every other
 * route answers 403 PASSWORD_CHANGE_REQUIRED until the password is changed.
 */
export const AllowDuringPasswordChange = () =>
  SetMetadata(ALLOW_DURING_PASSWORD_CHANGE, true);
