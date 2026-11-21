import { createTransport, type Transporter } from 'nodemailer';
import {
  buildPlainTextMessage,
  isEmailAddress,
  MessageHeaderError,
} from '../integrations/google/google-workspace-domain.js';

/**
 * Batch 2 (D1) — a deployment-wide SMTP server, used for account and notification email when an
 * organization has no Google Workspace Gmail connection. Works with any standard provider (a
 * company mail server, Microsoft 365, Amazon SES, SendGrid, Postmark, Mailgun…).
 *
 * Messages are built by the provider-neutral `buildPlainTextMessage` (plain addresses only, an
 * encoded subject, a base64 body), so no caller value can inject a header, and sent as-is.
 * Credentials, addresses, subjects and bodies are never logged or put in errors.
 */
export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  password: string | null;
  from: string;
}

export class SmtpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpConfigurationError';
  }
}

const DEFAULT_PORTS: Record<SmtpSecurity, number> = {
  tls: 465,
  starttls: 587,
  none: 25,
};

/**
 * The SMTP settings in the environment, or null when SMTP is not configured (no SMTP_HOST).
 * Partial or unsafe settings throw (naming the variable, never its value). The same rules are
 * validated at API start-up by packages/config.
 */
export function smtpSettingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SmtpSettings | null {
  const value = (key: string) => {
    const raw = env[key]?.trim();
    return raw ? raw : null;
  };
  const host = value('SMTP_HOST');
  const configured = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURITY',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
  ].filter((key) => value(key) !== null);
  if (!host) {
    if (configured.length > 0)
      throw new SmtpConfigurationError(
        `SMTP_HOST is required when ${configured[0]} is set.`,
      );
    return null;
  }
  const security = (value('SMTP_SECURITY') ?? 'starttls').toLowerCase();
  if (security !== 'tls' && security !== 'starttls' && security !== 'none')
    throw new SmtpConfigurationError(
      'SMTP_SECURITY must be tls, starttls or none.',
    );
  if (security === 'none' && env.NODE_ENV === 'production')
    throw new SmtpConfigurationError(
      'SMTP_SECURITY=none is not allowed in production; use tls or starttls.',
    );
  const portValue = value('SMTP_PORT');
  const port = portValue === null ? DEFAULT_PORTS[security] : Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new SmtpConfigurationError('SMTP_PORT must be a port number.');
  const user = value('SMTP_USER');
  const password = env.SMTP_PASSWORD ? env.SMTP_PASSWORD : null;
  if ((user === null) !== (password === null))
    throw new SmtpConfigurationError(
      'SMTP_USER and SMTP_PASSWORD are configured together.',
    );
  const from = value('SMTP_FROM');
  if (!from || !isEmailAddress(from) || /[\s<>"]/.test(from))
    throw new SmtpConfigurationError(
      'SMTP_FROM must be a plain sender address (for example hr@example.com).',
    );
  return { host, port, security, user, password, from };
}

/** A classified send failure: `retryable` (try again later) or permanent (e.g. rejected recipient). */
export class SmtpSendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'SmtpSendError';
  }
}

type SendMail = Pick<Transporter, 'sendMail'>;

export class SmtpMailer {
  private readonly transporter: SendMail;

  constructor(
    readonly settings: SmtpSettings,
    transporter?: SendMail,
  ) {
    this.transporter =
      transporter ??
      createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.security === 'tls',
        requireTLS: settings.security === 'starttls',
        ignoreTLS: settings.security === 'none',
        ...(settings.user && settings.password
          ? { auth: { user: settings.user, pass: settings.password } }
          : {}),
        // Certificates are always verified; old protocol versions are refused.
        tls: { minVersion: 'TLSv1.2' },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        logger: false,
        debug: false,
      });
  }

  /** Sends one plain-text message; returns the server's message id when it gives one. */
  async send(message: {
    to: string;
    subject: string;
    text: string;
    reference?: string;
  }): Promise<{ messageId: string | null }> {
    let raw: Buffer;
    try {
      raw = Buffer.from(
        buildPlainTextMessage({
          from: this.settings.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          messageId: message.reference,
        }),
        'base64url',
      );
    } catch (error) {
      if (error instanceof MessageHeaderError)
        throw new SmtpSendError(error.code, false);
      throw error;
    }
    try {
      const info = (await this.transporter.sendMail({
        envelope: { from: this.settings.from, to: [message.to] },
        raw,
      })) as { messageId?: unknown };
      return {
        messageId:
          typeof info.messageId === 'string'
            ? info.messageId.slice(0, 180)
            : null,
      };
    } catch (error) {
      throw classifySmtpError(error);
    }
  }
}

/**
 * Maps a nodemailer failure to a safe code: a permanent 5xx answer to the envelope or message
 * (a rejected recipient or content) is not retried; connection, authentication, timeout and 4xx
 * failures are (a configuration fix or a transient outage resolves them).
 */
export function classifySmtpError(error: unknown): SmtpSendError {
  const details = error as { code?: unknown; responseCode?: unknown };
  const code =
    typeof details.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(details.code)
      ? `SMTP_${details.code}`
      : 'SMTP_SEND_FAILED';
  const responseCode =
    typeof details.responseCode === 'number' ? details.responseCode : null;
  const permanent =
    responseCode !== null &&
    responseCode >= 500 &&
    (details.code === 'EENVELOPE' || details.code === 'EMESSAGE');
  return new SmtpSendError(
    responseCode !== null ? `${code}_${responseCode}` : code,
    !permanent,
  );
}
