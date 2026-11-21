import { HttpException, HttpStatus, SetMetadata } from '@nestjs/common';

/**
 * Phase 19 — abuse protection for sensitive or expensive routes (not an API gateway).
 *
 * A policy is a fixed window counted in Redis under a key derived from the request:
 * - `ip`: the client address (`request.ip`, which honours the deliberate TRUST_PROXY_HOPS);
 * - `user`: the authenticated user (from a valid bearer token), else the client address;
 * - `email`: the normalized `email` field of the JSON body, else the client address.
 * Every identifier is hashed before it becomes part of a Redis key.
 *
 * Fail mode when Redis is unavailable:
 * - `closed` (503 RATE_LIMIT_UNAVAILABLE) for unauthenticated credential and recovery flows,
 *   where an unlimited window would enable brute force or email flooding, and for the kiosk
 *   (Batch R2, KIOSK-1): kiosk identification, enrollment and interactions already need Redis,
 *   so without it the kiosk cannot record attendance anyway, and an unlimited per-address window
 *   would only expose the device and PIN checks to unthrottled traffic;
 * - `open` (allowed, with a throttled warning) for authenticated routes and the token refresh,
 *   where a Redis outage must not take the product down and other controls still apply.
 */
export type RateLimitKey = 'ip' | 'user' | 'email';
export type RateLimitFailMode = 'open' | 'closed';

export interface RateLimitPolicy {
  /** Stable identifier: part of the Redis key and of metrics labels. */
  name: string;
  limit: number;
  windowMs: number;
  key: RateLimitKey;
  failMode: RateLimitFailMode;
}

export const RATE_LIMIT_METADATA = 'hrms:rate-limit';

/** Applies one or more policies to a route (all must allow the request). */
export const RateLimit = (...policies: RateLimitPolicy[]) =>
  SetMetadata(RATE_LIMIT_METADATA, policies);

/** 429 with a Retry-After header (set by RateLimitExceptionFilter). */
export class RateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please wait and try again.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class RateLimitUnavailableException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        code: 'RATE_LIMIT_UNAVAILABLE',
        message:
          'This action is temporarily unavailable. Please try again shortly.',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

const MINUTE = 60_000;

function policy(
  name: string,
  limit: number,
  windowMs: number,
  key: RateLimitKey,
  failMode: RateLimitFailMode,
): RateLimitPolicy {
  return { name, limit, windowMs, key, failMode };
}

/**
 * The route policies. Limits are generous for legitimate use (shared office NAT addresses,
 * several browser tabs) and tight where each request costs a password hash, an email or an
 * external API call. Login and kiosk identification/enrollment keep their dedicated limiters
 * (auth/login-rate-limiter.service.ts, kiosk/kiosk-rate-limiter.service.ts).
 */
export const RATE_LIMITS = {
  authRefresh: [policy('auth.refresh', 120, MINUTE, 'ip', 'open')],
  authLogoutAll: [policy('auth.logout-all', 10, MINUTE, 'user', 'open')],
  // Batch 2: each request checks a password, so it is limited even though it is authenticated,
  // and refused when Redis is down.
  authChangePassword: [
    policy('auth.change-password', 5, 15 * MINUTE, 'user', 'closed'),
  ],
  authSessions: [policy('auth.sessions', 60, MINUTE, 'user', 'open')],
  // Batch 2: administrator actions that send an account email (invitations, reset links).
  employeeAccountEmail: [
    policy('employee.account.email', 30, 60 * MINUTE, 'user', 'open'),
  ],
  authForgotPassword: [
    policy('auth.forgot-password.ip', 10, 15 * MINUTE, 'ip', 'closed'),
    policy('auth.forgot-password.email', 3, 60 * MINUTE, 'email', 'closed'),
  ],
  authResetPassword: [
    policy('auth.reset-password', 10, 15 * MINUTE, 'ip', 'closed'),
  ],
  authAcceptInvitation: [
    policy('auth.accept-invitation', 10, 15 * MINUTE, 'ip', 'closed'),
  ],
  authVerifyEmail: [
    policy('auth.verify-email', 20, 15 * MINUTE, 'ip', 'closed'),
  ],
  authResendVerification: [
    policy('auth.resend-verification', 10, 15 * MINUTE, 'ip', 'closed'),
  ],
  kioskDevice: [policy('kiosk.device', 300, MINUTE, 'ip', 'closed')],
  // Batch 9: document files — uploads, download-URL issuance and local downloads.
  documentUpload: [policy('documents.upload', 30, MINUTE, 'user', 'open')],
  documentViewUrl: [policy('documents.view-url', 120, MINUTE, 'user', 'open')],
  documentFileDownload: [
    policy('documents.file-download', 120, MINUTE, 'ip', 'open'),
  ],
  googleOAuth: [policy('google.oauth', 10, 10 * MINUTE, 'user', 'open')],
  googleOAuthCallback: [
    policy('google.oauth-callback', 30, 10 * MINUTE, 'ip', 'open'),
  ],
  googleManual: [policy('google.manual', 20, 10 * MINUTE, 'user', 'open')],
  notificationsReadAll: [
    policy('notifications.read-all', 30, MINUTE, 'user', 'open'),
  ],
  reportCsvExport: [
    policy('reports.export-csv', 30, 10 * MINUTE, 'user', 'open'),
  ],
  reportSheetsExport: [
    policy('reports.export-sheets', 10, 10 * MINUTE, 'user', 'open'),
  ],
  intakeImport: [policy('intake.import', 20, 10 * MINUTE, 'user', 'open')],
  documentsProvide: [
    policy('documents.provide', 30, 10 * MINUTE, 'user', 'open'),
  ],
  /** Phase 20: the unauthenticated login-page branding (cheap, read-only). */
  publicBranding: [policy('public.branding', 120, MINUTE, 'ip', 'open')],
} satisfies Record<string, RateLimitPolicy[]>;
