import { Logger } from '@nestjs/common';
import { SmtpMailer, SmtpSendError } from '../email/smtp-mailer.js';
import {
  accountEmailContent,
  accountEmailLink,
} from './account-email-content.js';
import {
  AccountEmailService,
  accountEmailDeliveryFailed,
  type AccountEmailKind,
  type AccountEmailMessage,
} from './account-email.service.js';

/**
 * Batch 2 (D1): account email (invitations, password resets, verification) through the
 * deployment's SMTP server — used when the account has no Google Workspace Gmail sender. Only
 * the account id and an error code are ever logged.
 */
export class SmtpAccountEmailService extends AccountEmailService {
  private readonly logger = new Logger('AccountEmail');

  constructor(
    private readonly mailer: SmtpMailer,
    private readonly settings: { production: boolean; webOrigin?: string },
  ) {
    super();
  }

  assertAvailable(): void {}

  sendInvitation(message: AccountEmailMessage) {
    return this.send('invitation', message);
  }

  sendPasswordReset(message: AccountEmailMessage) {
    return this.send('password-reset', message);
  }

  sendVerification(message: AccountEmailMessage) {
    return this.send('verification', message);
  }

  private async send(kind: AccountEmailKind, message: AccountEmailMessage) {
    const content = accountEmailContent(
      kind,
      accountEmailLink(kind, message.token, this.settings),
      message.expiresAt,
    );
    try {
      await this.mailer.send({
        to: message.email,
        subject: content.subject,
        text: content.text,
      });
    } catch (error) {
      const code =
        error instanceof SmtpSendError ? error.code : 'SMTP_SEND_FAILED';
      this.logger.warn(
        `Account email (${kind}) for user ${message.userId ?? 'unknown'} via SMTP failed: ${code}`,
      );
      throw accountEmailDeliveryFailed();
    }
  }
}
