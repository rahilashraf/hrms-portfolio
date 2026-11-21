import { Logger } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { accountEmailDeliveryFailed } from '../auth/account-email.service.js';
import { GoogleWorkspaceAccountEmailService } from '../auth/google-account-email.service.js';
import { SmtpAccountEmailService } from '../auth/smtp-account-email.service.js';
import { NotificationTransportError } from '../notifications/notification-email.transport.js';
import { defaultNotificationEmailTransport } from '../notifications/notifications-jobs.js';
import { SmtpNotificationEmailTransport } from '../notifications/smtp-notification-email.transport.js';
import {
  classifySmtpError,
  SmtpConfigurationError,
  SmtpMailer,
  SmtpSendError,
  smtpSettingsFromEnv,
  type SmtpSettings,
} from './smtp-mailer.js';

interface Received {
  from: string;
  to: string[];
  raw: string;
}

/** A local SMTP server (no TLS, no auth) that records what it receives. */
async function startServer(
  options: { rejectRecipient?: boolean } = {},
): Promise<{ port: number; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onRcptTo(address, _session, callback) {
      if (options.rejectRecipient) {
        const error = new Error('Mailbox unavailable') as Error & {
          responseCode: number;
        };
        error.responseCode = 550;
        return callback(error);
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom
            ? session.envelope.mailFrom.address
            : '',
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const settings = (port: number): SmtpSettings => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  user: null,
  password: null,
  from: 'hr@example.com',
});

const bodyOf = (raw: string) =>
  Buffer.from(raw.split('\r\n\r\n')[1]!.replace(/\s+/g, ''), 'base64').toString(
    'utf8',
  );

describe('SMTP settings', () => {
  it('is off without SMTP_HOST and refuses partial or unsafe settings by name only', () => {
    expect(smtpSettingsFromEnv({})).toBeNull();
    expect(
      smtpSettingsFromEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_FROM: 'hr@example.com',
      }),
    ).toEqual({
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      user: null,
      password: null,
      from: 'hr@example.com',
    });
    expect(
      smtpSettingsFromEnv({
        SMTP_HOST: 'smtp.example.com',
        SMTP_SECURITY: 'tls',
        SMTP_USER: 'apikey',
        SMTP_PASSWORD: 'sekret-value',
        SMTP_FROM: 'hr@example.com',
      }),
    ).toMatchObject({ port: 465, security: 'tls', user: 'apikey' });
    for (const env of [
      { SMTP_FROM: 'hr@example.com' },
      { SMTP_HOST: 'smtp.example.com' },
      { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'HR <hr@example.com>' },
      { SMTP_HOST: 'h', SMTP_FROM: 'hr@example.com', SMTP_USER: 'u' },
      { SMTP_HOST: 'h', SMTP_FROM: 'hr@example.com', SMTP_SECURITY: 'ssl' },
      { SMTP_HOST: 'h', SMTP_FROM: 'hr@example.com', SMTP_PORT: 'x' },
      {
        NODE_ENV: 'production',
        SMTP_HOST: 'h',
        SMTP_FROM: 'hr@example.com',
        SMTP_SECURITY: 'none',
      },
    ]) {
      const error = (() => {
        try {
          smtpSettingsFromEnv(env);
        } catch (caught) {
          return caught;
        }
        return null;
      })();
      expect(error, JSON.stringify(env)).toBeInstanceOf(SmtpConfigurationError);
      expect((error as Error).message).not.toContain('sekret');
    }
  });

  it('classifies failures: rejected recipients are permanent, the rest retry', () => {
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 550 })).toEqual(
      new SmtpSendError('SMTP_EENVELOPE_550', false),
    );
    expect(
      classifySmtpError({ code: 'EENVELOPE', responseCode: 451 }).retryable,
    ).toBe(true);
    expect(
      classifySmtpError({ code: 'EAUTH', responseCode: 535 }).retryable,
    ).toBe(true);
    expect(classifySmtpError({ code: 'ECONNECTION' })).toEqual(
      new SmtpSendError('SMTP_ECONNECTION', true),
    );
    expect(classifySmtpError(new Error('boom with hr@example.com')).code).toBe(
      'SMTP_SEND_FAILED',
    );
  });
});

describe('SmtpMailer', () => {
  it('delivers the provider-neutral message to an SMTP server', async () => {
    const server = await startServer();
    try {
      const mailer = new SmtpMailer(settings(server.port));
      const sent = await mailer.send({
        to: 'ada@example.com',
        subject: 'Réinitialiser\r\nBcc: evil@example.com',
        text: 'Line one\nLine two',
        reference: 'notification-1',
      });
      expect(sent.messageId).not.toBeNull();
      expect(server.received).toHaveLength(1);
      const [mail] = server.received;
      expect(mail!.from).toBe('hr@example.com');
      expect(mail!.to).toEqual(['ada@example.com']);
      expect(mail!.raw).toContain('From: hr@example.com');
      expect(mail!.raw).toContain('X-HRMS-Notification: notification-1');
      // The line break in the subject cannot add a header.
      expect(mail!.raw).not.toMatch(/^Bcc:/m);
      expect(bodyOf(mail!.raw)).toBe('Line one\r\nLine two');
    } finally {
      await server.close();
    }
  });

  it('refuses unsafe addresses before connecting and classifies server refusals', async () => {
    const server = await startServer({ rejectRecipient: true });
    try {
      const mailer = new SmtpMailer(settings(server.port));
      await expect(
        mailer.send({
          to: 'ada@example.com>\r\nBcc: evil@example.com',
          subject: 'x',
          text: 'y',
        }),
      ).rejects.toEqual(new SmtpSendError('EMAIL_ADDRESS_INVALID', false));
      const refused = await mailer
        .send({ to: 'gone@example.com', subject: 'x', text: 'y' })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(SmtpSendError);
      expect(refused).toMatchObject({ retryable: false });
      expect(server.received).toEqual([]);
    } finally {
      await server.close();
    }
    // Nothing listening: a retryable connection failure.
    const unreachable = await new SmtpMailer({ ...settings(server.port) })
      .send({ to: 'ada@example.com', subject: 'x', text: 'y' })
      .catch((error: unknown) => error);
    expect(unreachable).toMatchObject({ retryable: true });
  });
});

describe('SMTP delivery of account and notification email', () => {
  it('sends account email with the single-use link in the fragment, logging no token', async () => {
    const server = await startServer();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      const service = new SmtpAccountEmailService(
        new SmtpMailer(settings(server.port)),
        { production: true, webOrigin: 'https://hrms.example.com' },
      );
      await service.sendPasswordReset({
        email: 'ada@example.com',
        token: 'secret-token-value',
        expiresAt: new Date('2030-01-01T00:30:00.000Z'),
        userId: 'user-1',
      });
      const body = bodyOf(server.received[0]!.raw);
      expect(body).toContain(
        'https://hrms.example.com/reset-password#token=secret-token-value',
      );
      expect(server.received[0]!.raw).not.toContain('secret-token-value');

      const failing = new SmtpAccountEmailService(new SmtpMailer(settings(1)), {
        production: true,
        webOrigin: 'https://hrms.example.com',
      });
      await expect(
        failing.sendInvitation({
          email: 'ada@example.com',
          token: 'another-secret-token',
          expiresAt: new Date(),
          userId: 'user-1',
        }),
      ).rejects.toEqual(accountEmailDeliveryFailed());
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('user-1');
      expect(logged).not.toContain('another-secret-token');
      expect(logged).not.toContain('ada@example.com');
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });

  it('uses SMTP when an account has no Gmail sender, and is then available in production', async () => {
    const smtp = {
      assertAvailable: vi.fn(),
      sendInvitation: vi.fn(),
      sendPasswordReset: vi.fn(),
      sendVerification: vi.fn(),
    };
    const fallback = { ...smtp, sendPasswordReset: vi.fn() };
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      roleAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      googleWorkspaceConnection: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const runtime = { connectionFor: vi.fn().mockResolvedValue(null) };
    const service = new GoogleWorkspaceAccountEmailService(
      prisma as never,
      runtime as never,
      {} as never,
      fallback as never,
      {
        production: true,
        webOrigin: 'https://hrms.example.com',
        smtp: smtp as never,
      },
    );
    await expect(service.assertAvailable()).resolves.toBeUndefined();
    const message = {
      email: 'ada@example.com',
      token: 't',
      expiresAt: new Date(),
      userId: '00000000-0000-4000-8000-000000000001',
    };
    await service.sendPasswordReset(message);
    expect(smtp.sendPasswordReset).toHaveBeenCalledWith(message);
    expect(fallback.sendPasswordReset).not.toHaveBeenCalled();

    // Without SMTP, production still refuses (unchanged behaviour).
    const withoutSmtp = new GoogleWorkspaceAccountEmailService(
      prisma as never,
      runtime as never,
      {} as never,
      fallback as never,
      { production: true, webOrigin: 'https://hrms.example.com' },
    );
    await expect(withoutSmtp.sendPasswordReset(message)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ACCOUNT_EMAIL_UNAVAILABLE' }),
    });
  });

  it('routes notifications without a Gmail sender to SMTP and classifies its failures', async () => {
    expect(defaultNotificationEmailTransport({}).provider).toBe('dev-log');
    expect(
      defaultNotificationEmailTransport({
        SMTP_HOST: '127.0.0.1',
        SMTP_FROM: 'hr@example.com',
      }).provider,
    ).toBe('smtp');

    const server = await startServer();
    try {
      const transport = new SmtpNotificationEmailTransport(
        new SmtpMailer(settings(server.port)),
      );
      const result = await transport.send({
        to: 'ada@example.com',
        subject: 'Leave approved',
        text: 'Your leave was approved.',
        notificationId: 'notification-7',
        recipientUserId: 'user-1',
      });
      expect(result.providerReference).toMatch(/^smtp:/);
      expect(server.received[0]!.raw).toContain(
        'X-HRMS-Notification: notification-7',
      );
      const refused = await transport
        .send({
          to: 'bad address@example.com',
          subject: 'x',
          text: 'y',
          notificationId: 'n',
          recipientUserId: 'u',
        })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(NotificationTransportError);
      expect(refused).toMatchObject({
        code: 'EMAIL_ADDRESS_INVALID',
        retryable: false,
      });
    } finally {
      await server.close();
    }
  });
});
