import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service.js';
import { SmtpMailer, smtpSettingsFromEnv } from '../email/smtp-mailer.js';
import type { GoogleApiClient } from '../integrations/google/google-api.client.js';
import type { GoogleWorkspaceRuntime } from '../integrations/google/google-workspace-runtime.js';
import type { AccountEmailService } from './account-email.service.js';
import { DevAccountEmailService } from './dev-account-email.service.js';
import { GoogleWorkspaceAccountEmailService } from './google-account-email.service.js';
import { SmtpAccountEmailService } from './smtp-account-email.service.js';

export const EMAIL_ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'WEB_ORIGIN',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURITY',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
] as const;

/**
 * The account email service, composed the same way in the API and the worker: each account's
 * Google Workspace Gmail sender, else the deployment's SMTP server (Batch 2), else the
 * development service (503 in production).
 */
export function createAccountEmailService(options: {
  prisma: PrismaService;
  runtime: GoogleWorkspaceRuntime;
  api: GoogleApiClient;
  env: Record<string, string | undefined>;
  fallback?: AccountEmailService;
}): AccountEmailService {
  const production = options.env.NODE_ENV === 'production';
  const webOrigin = options.env.WEB_ORIGIN || undefined;
  const smtpSettings = smtpSettingsFromEnv(options.env);
  const smtp = smtpSettings
    ? new SmtpAccountEmailService(new SmtpMailer(smtpSettings), {
        production,
        webOrigin,
      })
    : undefined;
  const fallback =
    options.fallback ??
    new DevAccountEmailService({
      getOrThrow: () => options.env.NODE_ENV ?? 'development',
    } as unknown as ConfigService);
  return new GoogleWorkspaceAccountEmailService(
    options.prisma,
    options.runtime,
    options.api,
    fallback,
    { production, webOrigin, smtp },
  );
}

/** The email settings of a validated configuration, as an environment record. */
export function emailEnvironment(config: ConfigService) {
  return Object.fromEntries(
    EMAIL_ENVIRONMENT_KEYS.map((key) => {
      const value = config.get<string | number>(key);
      return [
        key,
        value === undefined || value === null ? undefined : String(value),
      ];
    }),
  ) as Record<string, string | undefined>;
}
