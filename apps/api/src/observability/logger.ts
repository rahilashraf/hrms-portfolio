import { ConsoleLogger, type LoggerService } from '@nestjs/common';

/**
 * Keys masked wherever they appear in structured log params or object messages, at any depth.
 * Request logging never passes bodies, query strings, cookies or headers in the first place;
 * this is the backstop for application code that logs an object.
 */
export const REDACTED_LOG_KEYS = [
  'password',
  'newPassword',
  'passwordHash',
  'pin',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
  'cookies',
  'email',
  'enrollmentCode',
  'credentials',
];

export type LogFormat = 'json' | 'text';

export function resolveLogFormat(
  nodeEnv: string | undefined,
  configured: string | undefined,
): LogFormat {
  if (configured === 'json' || configured === 'text') return configured;
  return nodeEnv === 'production' ? 'json' : 'text';
}

/**
 * Phase 19: JSON lines in production (one object per line: level, timestamp, context, message
 * and flattened structured fields), human-readable text in development.
 */
export function createAppLogger(format: LogFormat): LoggerService {
  return new ConsoleLogger({
    json: format === 'json',
    colors: format === 'text' && process.stdout.isTTY === true,
    structuredParams: true,
    flattenParams: true,
    redact: REDACTED_LOG_KEYS,
  });
}
