import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MetricsService } from '../observability/metrics.service.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Fixed windows, all counted atomically in one script. Every key is incremented; the result is
 * 1 when every window allows the request, else the negative remaining time (ms) of the longest
 * exceeded window (so the caller can send Retry-After). A key that lost its expiry is repaired.
 */
export const RATE_LIMIT_SCRIPT = `
local blocked = 0
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[(i - 1) * 2 + 1])
  local limit = tonumber(ARGV[(i - 1) * 2 + 2])
  local count = redis.call('INCR', key)
  local ttl = redis.call('PTTL', key)
  if count == 1 or ttl < 0 then
    redis.call('PEXPIRE', key, window)
    ttl = window
  end
  if count > limit and ttl > blocked then blocked = ttl end
end
if blocked > 0 then return -blocked end
return 1
`;

export interface RateLimitWindow {
  key: string;
  limit: number;
  windowMs: number;
}

export type RateLimitDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Redis could not answer; the caller applies the policy's fail mode. */
export class RateLimitBackendError extends Error {
  constructor() {
    super('Rate limit backend unavailable');
  }
}

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private lastFailOpenWarningAt = 0;

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  async consume(windows: RateLimitWindow[]): Promise<RateLimitDecision> {
    if (windows.length === 0) return { allowed: true };
    let result: unknown;
    try {
      result = await this.redis.client.eval(
        RATE_LIMIT_SCRIPT,
        windows.length,
        ...windows.map((window) => window.key),
        ...windows.flatMap((window) => [window.windowMs, window.limit]),
      );
    } catch {
      throw new RateLimitBackendError();
    }
    if (result === 1) return { allowed: true };
    const remainingMs =
      typeof result === 'number' && result < 0
        ? -result
        : Math.max(...windows.map((window) => window.windowMs));
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
  }

  /** Logged at most once a minute so an outage does not flood the logs. */
  warnFailOpen(policy: string): void {
    this.metrics.increment('rate_limit_fail_open_total', { policy });
    const now = Date.now();
    if (now - this.lastFailOpenWarningAt >= 60_000) {
      this.lastFailOpenWarningAt = now;
      this.logger.warn(
        `Rate limiting unavailable (Redis); allowing requests for fail-open policies (first: ${policy})`,
      );
    }
  }
}
