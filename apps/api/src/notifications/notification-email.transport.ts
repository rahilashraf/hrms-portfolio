import { Logger } from '@nestjs/common';

/**
 * Phase 16 — the email transport boundary of notifications, aligned with the account email
 * boundary (auth/account-email.service.ts): an abstract class used as the provider token, with
 * a development implementation by default. Real providers (SMTP, Gmail API…) are adapters
 * registered later; nothing here calls an external service.
 */
export interface NotificationEmailMessage {
  to: string;
  subject: string;
  text: string;
  /** For provider-side correlation and logging only. */
  notificationId: string;
  recipientUserId: string;
  /**
   * Phase 16.5: the notification's organization, so a routing transport sends through that
   * organization's own provider (e.g. its Google Workspace Gmail connection).
   */
  organizationId?: string;
}

export interface NotificationEmailResult {
  providerReference: string | null;
}

/**
 * A classified transport failure. `retryable` failures (timeouts, rate limits, provider
 * outages) are retried with backoff; permanent ones (rejected address, invalid message) fail
 * the delivery. `safeMessage` must never contain the payload, addresses or credentials.
 */
export class NotificationTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly safeMessage?: string,
  ) {
    super(safeMessage ?? code);
    this.name = 'NotificationTransportError';
  }
}

export abstract class NotificationEmailTransport {
  /** A short provider name recorded on each attempt (e.g. 'dev-log', 'smtp'). */
  abstract readonly provider: string;
  abstract send(
    message: NotificationEmailMessage,
  ): Promise<NotificationEmailResult>;

  /**
   * Batch 8 (D3): the provider that will handle the organization's email, recorded on the
   * attempt (a routing transport answers with the provider it routes to).
   */
  async providerFor(organizationId: string): Promise<string> {
    void organizationId;
    return this.provider;
  }
}

/** Batch 8 (D2): the code of a send refused because no email provider is configured. */
export const EMAIL_PROVIDER_NOT_CONFIGURED = 'EMAIL_PROVIDER_NOT_CONFIGURED';

/** Classifies anything a transport throws: unknown errors are retryable and kept generic. */
export function classifyTransportError(error: unknown) {
  if (error instanceof NotificationTransportError)
    return {
      code: error.code,
      retryable: error.retryable,
      message: error.safeMessage ?? null,
    };
  return {
    code: 'TRANSPORT_ERROR',
    retryable: true,
    message: 'Unexpected transport error.',
  };
}

/**
 * Development transport: logs only the notification and recipient ids (never the address,
 * subject or body) and keeps the ids in memory for inspection. Refuses to run in production,
 * where a real provider adapter must be configured. Batch 8 (D2): the delivery worker records
 * that refusal as SUPPRESSED (EMAIL_PROVIDER_NOT_CONFIGURED) and warns; it never retries it.
 */
export class DevNotificationEmailTransport extends NotificationEmailTransport {
  readonly provider = 'dev-log';
  readonly sent: Array<{ notificationId: string; recipientUserId: string }> =
    [];
  private readonly logger = new Logger('NotificationEmail');

  constructor(
    private readonly production = process.env.NODE_ENV === 'production',
  ) {
    super();
  }

  /** Batch 8 (review L6): in production this transport sends nothing — no provider. */
  override async providerFor() {
    return this.production ? 'none' : this.provider;
  }

  async send(message: NotificationEmailMessage) {
    if (this.production) {
      throw new NotificationTransportError(
        EMAIL_PROVIDER_NOT_CONFIGURED,
        false,
        'No email provider is configured.',
      );
    }
    this.sent.push({
      notificationId: message.notificationId,
      recipientUserId: message.recipientUserId,
    });
    this.logger.log(
      `Email notification ${message.notificationId} for user ${message.recipientUserId} (dev transport, not sent).`,
    );
    return { providerReference: `dev-${message.notificationId}` };
  }
}
