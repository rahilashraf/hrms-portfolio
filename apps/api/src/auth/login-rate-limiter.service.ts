import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RateLimitedException } from '../rate-limit/rate-limit.js';
import { RedisService } from '../redis/redis.service.js';
import { normalizeEmail } from '../users/users.service.js';

const LOGIN_LIMIT_SCRIPT = `
local ipCount = redis.call('INCR', KEYS[1])
if ipCount == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local emailCount = redis.call('INCR', KEYS[2])
if emailCount == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
local blocked = 0
if ipCount > tonumber(ARGV[3]) then blocked = redis.call('PTTL', KEYS[1]) end
if emailCount > tonumber(ARGV[4]) then
  local ttl = redis.call('PTTL', KEYS[2])
  if ttl > blocked then blocked = ttl end
end
if blocked > 0 then return -blocked end
if ipCount > tonumber(ARGV[3]) or emailCount > tonumber(ARGV[4]) then return 0 end
return 1
`;

const RESEND_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if count > tonumber(ARGV[2]) then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl > 0 then return -ttl end
  return 0
end
return 1
`;

export const LOGIN_IP_LIMIT = 10;
export const LOGIN_IP_WINDOW_MS = 60_000;
export const LOGIN_IP_EMAIL_LIMIT = 5;
export const LOGIN_IP_EMAIL_WINDOW_MS = 15 * 60_000;
export const VERIFICATION_RESEND_LIMIT = 3;
export const VERIFICATION_RESEND_WINDOW_MS = 60 * 60_000;

@Injectable()
export class LoginRateLimiterService {
  constructor(private readonly redis: RedisService) {}

  async assertLoginAllowed(ip: string, email: string): Promise<void> {
    const ipHash = digest(ip);
    const emailHash = digest(normalizeEmail(email));
    try {
      const allowed = await this.redis.client.eval(
        LOGIN_LIMIT_SCRIPT,
        2,
        `auth:rate:login:ip:${ipHash}`,
        `auth:rate:login:ip-email:${ipHash}:${emailHash}`,
        LOGIN_IP_WINDOW_MS,
        LOGIN_IP_EMAIL_WINDOW_MS,
        LOGIN_IP_LIMIT,
        LOGIN_IP_EMAIL_LIMIT,
      );
      if (allowed !== 1) {
        throw new RateLimitedException(
          retryAfterSeconds(allowed, LOGIN_IP_EMAIL_WINDOW_MS),
        );
      }
    } catch (error) {
      if (error instanceof RateLimitedException) throw error;
      throw new ServiceUnavailableException(
        'Authentication temporarily unavailable',
      );
    }
  }

  async assertVerificationResendAllowed(
    ip: string,
    email: string,
  ): Promise<void> {
    const key = `auth:rate:verification-resend:${digest(ip)}:${digest(normalizeEmail(email))}`;
    try {
      const allowed = await this.redis.client.eval(
        RESEND_LIMIT_SCRIPT,
        1,
        key,
        VERIFICATION_RESEND_WINDOW_MS,
        VERIFICATION_RESEND_LIMIT,
      );
      if (allowed !== 1) {
        throw new RateLimitedException(
          retryAfterSeconds(allowed, VERIFICATION_RESEND_WINDOW_MS),
        );
      }
    } catch (error) {
      if (error instanceof RateLimitedException) throw error;
      throw new ServiceUnavailableException(
        'Authentication temporarily unavailable',
      );
    }
  }
}

/** The script answers 1 (allowed) or the negative remaining window (ms) when throttled. */
function retryAfterSeconds(result: unknown, fallbackMs: number): number {
  const remainingMs =
    typeof result === 'number' && result < 0 ? -result : fallbackMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
