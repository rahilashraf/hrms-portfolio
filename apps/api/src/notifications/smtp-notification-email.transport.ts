import { SmtpMailer, SmtpSendError } from '../email/smtp-mailer.js';
import {
  NotificationEmailTransport,
  NotificationTransportError,
  type NotificationEmailMessage,
} from './notification-email.transport.js';

/**
 * Batch 2 (D1): notification email through the deployment's SMTP server, for organizations
 * without a Google Workspace Gmail connection. Failures are classified for the delivery retry
 * policy (rejected recipients are permanent; outages, timeouts and authentication retry).
 */
export class SmtpNotificationEmailTransport extends NotificationEmailTransport {
  readonly provider = 'smtp';

  constructor(private readonly mailer: SmtpMailer) {
    super();
  }

  async send(message: NotificationEmailMessage) {
    try {
      const sent = await this.mailer.send({
        to: message.to,
        subject: message.subject,
        text: message.text,
        reference: message.notificationId,
      });
      return {
        providerReference: sent.messageId ? `smtp:${sent.messageId}` : null,
      };
    } catch (error) {
      if (error instanceof SmtpSendError)
        throw new NotificationTransportError(
          error.code,
          error.retryable,
          'The SMTP server refused or failed the send.',
        );
      throw error;
    }
  }
}
