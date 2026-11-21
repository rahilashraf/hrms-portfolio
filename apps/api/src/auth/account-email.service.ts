import { ServiceUnavailableException } from '@nestjs/common';

export interface AccountEmailMessage {
  email: string;
  token: string;
  expiresAt: Date;
  /** The account the message is for: routes it through one of its employee organizations. */
  userId?: string;
  /**
   * Organizations to send from, in preference order (e.g. the ones an inviting administrator
   * manages the employee in). When given, only these are used.
   */
  organizationIds?: readonly string[];
}

export type AccountEmailKind = 'invitation' | 'password-reset' | 'verification';

/**
 * Account email boundary (invitations, password resets, email verification). The message
 * carries a single-use token; implementations never log the token, the address or the body.
 */
export abstract class AccountEmailService {
  /** Throws (503) when no provider can deliver account email in this deployment. */
  abstract assertAvailable(): void | Promise<void>;
  abstract sendPasswordReset(message: AccountEmailMessage): Promise<void>;
  abstract sendInvitation(message: AccountEmailMessage): Promise<void>;
  abstract sendVerification(message: AccountEmailMessage): Promise<void>;
}

/** No provider can deliver account email (configuration problem). */
export function accountEmailUnavailable(detail?: string) {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: 'ACCOUNT_EMAIL_UNAVAILABLE',
    message:
      detail ??
      'Account email is not configured: connect Google Workspace with Gmail sending for the organization, or configure the deployment SMTP server.',
  });
}

/** The provider was reached but did not deliver the message (retry later). */
export function accountEmailDeliveryFailed() {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: 'ACCOUNT_EMAIL_DELIVERY_FAILED',
    message: 'The email could not be sent. Try again later.',
  });
}
