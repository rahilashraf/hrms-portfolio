import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessTokenService } from '../auth/access-token.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import { normalizeEmail } from '../users/users.service.js';
import {
  RATE_LIMIT_METADATA,
  RateLimitedException,
  RateLimitUnavailableException,
  type RateLimitPolicy,
} from './rate-limit.js';
import {
  hashIdentifier,
  RateLimitBackendError,
  RateLimitService,
  type RateLimitWindow,
} from './rate-limit.service.js';

type RateLimitedRequest = Request & { auth?: { userId: string } };

/**
 * Global guard; a no-op for routes without @RateLimit. Runs before the route's own guards, so
 * a flood is refused before any session lookup. The user of a `user` policy comes from a
 * verified bearer token (signature and expiry only — the AccessTokenGuard still decides
 * authentication); without one the request is counted by client address instead.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly accessTokens: AccessTokenService,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const policies = this.reflector.getAllAndMerge<RateLimitPolicy[]>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!policies || policies.length === 0) return true;

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    const windows: RateLimitWindow[] = [];
    for (const policy of policies) {
      windows.push({
        key: `rl:${policy.name}:${await this.subject(policy, request)}`,
        limit: policy.limit,
        windowMs: policy.windowMs,
      });
    }

    try {
      const decision = await this.limiter.consume(windows);
      if (!decision.allowed) {
        this.metrics.increment('rate_limit_rejected_total', {
          policy: policies[0]!.name,
        });
        throw new RateLimitedException(decision.retryAfterSeconds);
      }
      return true;
    } catch (error) {
      if (!(error instanceof RateLimitBackendError)) throw error;
      if (policies.some((policy) => policy.failMode === 'closed')) {
        this.metrics.increment('rate_limit_fail_closed_total', {
          policy: policies[0]!.name,
        });
        throw new RateLimitUnavailableException();
      }
      this.limiter.warnFailOpen(policies[0]!.name);
      return true;
    }
  }

  /** `<kind>:<sha256>` — never a raw address, user id or email in Redis. */
  private async subject(
    policy: RateLimitPolicy,
    request: RateLimitedRequest,
  ): Promise<string> {
    if (policy.key === 'user') {
      const userId = await this.userId(request);
      if (userId) return `user:${hashIdentifier(userId)}`;
    }
    if (policy.key === 'email') {
      const email = (request.body as { email?: unknown } | undefined)?.email;
      if (typeof email === 'string' && email.trim().length > 0) {
        return `email:${hashIdentifier(normalizeEmail(email))}`;
      }
    }
    return `ip:${hashIdentifier(request.ip ?? 'unknown')}`;
  }

  private async userId(request: RateLimitedRequest): Promise<string | null> {
    if (request.auth?.userId) return request.auth.userId;
    const match = request.headers.authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match) return null;
    try {
      return (await this.accessTokens.verify(match[1]!)).userId;
    } catch {
      return null;
    }
  }
}
