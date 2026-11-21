import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccessTokenService } from '../auth/access-token.service.js';
import { InMemoryMetricsService } from '../observability/metrics.service.js';
import type { RedisService } from '../redis/redis.service.js';
import {
  RATE_LIMIT_METADATA,
  RATE_LIMITS,
  RateLimit,
  RateLimitedException,
  RateLimitUnavailableException,
  type RateLimitPolicy,
} from './rate-limit.js';
import { RateLimitExceptionFilter } from './rate-limit.filter.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RATE_LIMIT_SCRIPT, RateLimitService } from './rate-limit.service.js';

/** Executes RATE_LIMIT_SCRIPT's fixed-window semantics in memory. */
function fakeRedis(now: () => number = Date.now) {
  const counters = new Map<string, { count: number; expiresAt: number }>();
  const evalScript = vi.fn(
    async (
      script: string,
      keyCount: number,
      ...args: Array<string | number>
    ) => {
      expect(script).toBe(RATE_LIMIT_SCRIPT);
      const keys = args.slice(0, keyCount) as string[];
      const argv = args.slice(keyCount).map(Number);
      let blocked = 0;
      keys.forEach((key, index) => {
        const window = argv[index * 2]!;
        const limit = argv[index * 2 + 1]!;
        let entry = counters.get(key);
        if (!entry || entry.expiresAt <= now()) {
          entry = { count: 0, expiresAt: now() + window };
          counters.set(key, entry);
        }
        entry.count += 1;
        const ttl = entry.expiresAt - now();
        if (entry.count > limit && ttl > blocked) blocked = ttl;
      });
      return blocked > 0 ? -blocked : 1;
    },
  );
  return {
    counters,
    evalScript,
    service: { client: { eval: evalScript } } as unknown as RedisService,
  };
}

function httpContext(
  request: Record<string, unknown>,
  handler: () => void,
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function routeWith(...policies: RateLimitPolicy[]) {
  const handler = () => undefined;
  RateLimit(...policies)(handler);
  return handler;
}

function createGuard(redis: RedisService, users: Record<string, string> = {}) {
  const metrics = new InMemoryMetricsService();
  const accessTokens = {
    verify: vi.fn(async (token: string) => {
      const userId = users[token];
      if (!userId) throw new Error('invalid');
      return { userId, sessionId: 'session-1' };
    }),
  } as unknown as AccessTokenService;
  const limiter = new RateLimitService(redis, metrics);
  return {
    metrics,
    limiter,
    guard: new RateLimitGuard(new Reflector(), limiter, accessTokens, metrics),
  };
}

const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: 'test.route',
  limit: 2,
  windowMs: 60_000,
  key: 'ip',
  failMode: 'open',
  ...overrides,
});

describe('rate limiting', () => {
  it('allows routes without a policy without touching Redis', async () => {
    const redis = fakeRedis();
    const { guard } = createGuard(redis.service);
    await expect(
      guard.canActivate(
        httpContext({ ip: '192.0.2.1', headers: {} }, () => undefined),
      ),
    ).resolves.toBe(true);
    expect(redis.evalScript).not.toHaveBeenCalled();
  });

  it('refuses the request over the limit with 429 RATE_LIMITED and a retry delay', async () => {
    let clock = 1_000_000;
    const redis = fakeRedis(() => clock);
    const { guard, metrics } = createGuard(redis.service);
    const handler = routeWith(policy());
    const request = { ip: '192.0.2.1', headers: {} };
    await guard.canActivate(httpContext(request, handler));
    await guard.canActivate(httpContext(request, handler));
    clock += 15_000;
    const refused = await guard
      .canActivate(httpContext(request, handler))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RateLimitedException);
    expect((refused as RateLimitedException).getStatus()).toBe(429);
    expect((refused as RateLimitedException).getResponse()).toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect((refused as RateLimitedException).retryAfterSeconds).toBe(45);
    expect(
      metrics.counters.get('rate_limit_rejected_total{policy=test.route}'),
    ).toBe(1);

    // Another address has its own window; the window resets after it expires.
    await expect(
      guard.canActivate(httpContext({ ip: '192.0.2.2', headers: {} }, handler)),
    ).resolves.toBe(true);
    clock += 60_000;
    await expect(
      guard.canActivate(httpContext(request, handler)),
    ).resolves.toBe(true);
  });

  it('hashes every identifier in the Redis key', async () => {
    const redis = fakeRedis();
    const { guard } = createGuard(redis.service, { 'token-a': 'user-a' });
    await guard.canActivate(
      httpContext(
        { ip: '192.0.2.1', headers: {} },
        routeWith(policy({ name: 'p.ip' })),
      ),
    );
    await guard.canActivate(
      httpContext(
        { ip: '192.0.2.1', headers: { authorization: 'Bearer token-a' } },
        routeWith(policy({ name: 'p.user', key: 'user' })),
      ),
    );
    await guard.canActivate(
      httpContext(
        {
          ip: '192.0.2.1',
          headers: {},
          body: { email: ' Person@Example.com ' },
        },
        routeWith(policy({ name: 'p.email', key: 'email' })),
      ),
    );
    const keys = [...redis.counters.keys()];
    expect(keys).toEqual([
      expect.stringMatching(/^rl:p\.ip:ip:[a-f0-9]{64}$/),
      expect.stringMatching(/^rl:p\.user:user:[a-f0-9]{64}$/),
      expect.stringMatching(/^rl:p\.email:email:[a-f0-9]{64}$/),
    ]);
    expect(keys.join(' ')).not.toMatch(/192\.0\.2\.1|user-a|example\.com/i);
  });

  it('counts users separately and falls back to the address without a valid token', async () => {
    const redis = fakeRedis();
    const { guard } = createGuard(redis.service, {
      'token-a': 'user-a',
      'token-b': 'user-b',
    });
    const handler = routeWith(policy({ key: 'user', limit: 1 }));
    const as = (authorization?: string) =>
      httpContext(
        {
          ip: '192.0.2.1',
          headers: authorization ? { authorization } : {},
        },
        handler,
      );
    await expect(guard.canActivate(as('Bearer token-a'))).resolves.toBe(true);
    await expect(guard.canActivate(as('Bearer token-b'))).resolves.toBe(true);
    await expect(
      guard.canActivate(as('Bearer token-a')),
    ).rejects.toBeInstanceOf(RateLimitedException);
    // Unauthenticated (or forged) requests share the address bucket.
    await expect(guard.canActivate(as('Bearer forged'))).resolves.toBe(true);
    await expect(guard.canActivate(as())).rejects.toBeInstanceOf(
      RateLimitedException,
    );
  });

  it('uses the same email bucket whatever the case or spacing', async () => {
    const redis = fakeRedis();
    const { guard } = createGuard(redis.service);
    const handler = routeWith(policy({ key: 'email', limit: 1 }));
    await guard.canActivate(
      httpContext(
        { ip: '192.0.2.1', headers: {}, body: { email: 'a@example.com' } },
        handler,
      ),
    );
    await expect(
      guard.canActivate(
        httpContext(
          { ip: '192.0.2.9', headers: {}, body: { email: ' A@Example.COM' } },
          handler,
        ),
      ),
    ).rejects.toBeInstanceOf(RateLimitedException);
  });

  it('fails open for open policies and closed when any policy is closed', async () => {
    const failing = {
      client: { eval: vi.fn().mockRejectedValue(new Error('redis down')) },
    } as unknown as RedisService;
    const { guard, metrics } = createGuard(failing);
    const request = { ip: '192.0.2.1', headers: {} };
    await expect(
      guard.canActivate(httpContext(request, routeWith(policy()))),
    ).resolves.toBe(true);
    expect(
      metrics.counters.get('rate_limit_fail_open_total{policy=test.route}'),
    ).toBe(1);
    await expect(
      guard.canActivate(
        httpContext(
          request,
          routeWith(policy(), policy({ name: 'strict', failMode: 'closed' })),
        ),
      ),
    ).rejects.toBeInstanceOf(RateLimitUnavailableException);
  });

  it('Batch R2 (KIOSK-1): fails the kiosk closed on connection errors and timeouts, recovers, and leaves other routes open', async () => {
    let failure: Error | null = new Error(
      'connect ECONNREFUSED 127.0.0.1:6380',
    );
    const healthy = fakeRedis();
    const redis = {
      client: {
        eval: vi.fn(async (...args: Parameters<typeof healthy.evalScript>) => {
          if (failure) throw failure;
          return healthy.evalScript(...args);
        }),
      },
    } as unknown as RedisService;
    const { guard, metrics } = createGuard(redis);
    const kiosk = routeWith(...RATE_LIMITS.kioskDevice);
    const authenticatedRoute = routeWith(...RATE_LIMITS.documentUpload);
    const request = { ip: '192.0.2.10', headers: {} };

    // Connection refused: the kiosk answers 503, an ordinary authenticated route stays available.
    await expect(
      guard.canActivate(httpContext(request, kiosk)),
    ).rejects.toBeInstanceOf(RateLimitUnavailableException);
    await expect(
      guard.canActivate(httpContext(request, authenticatedRoute)),
    ).resolves.toBe(true);
    expect(
      metrics.counters.get('rate_limit_fail_closed_total{policy=kiosk.device}'),
    ).toBe(1);

    // A command timeout (ioredis commandTimeout) is treated the same way.
    failure = new Error('Command timed out');
    const refused = await guard
      .canActivate(httpContext(request, kiosk))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RateLimitUnavailableException);
    expect((refused as RateLimitUnavailableException).getStatus()).toBe(503);

    // Redis is back: the kiosk is limited normally again.
    failure = null;
    await expect(guard.canActivate(httpContext(request, kiosk))).resolves.toBe(
      true,
    );
  });

  it('answers 429 with Retry-After and the stable error code', () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    new RateLimitExceptionFilter().catch(new RateLimitedException(30), {
      switchToHttp: () => ({ getResponse: () => response }),
    } as never);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 429, code: 'RATE_LIMITED' }),
    );
  });

  it('fails credential and recovery flows closed and everything else open', () => {
    const closed = new Set([
      'authForgotPassword',
      'authResetPassword',
      'authAcceptInvitation',
      'authVerifyEmail',
      'authResendVerification',
      // Batch 2: authenticated, but every request checks a password.
      'authChangePassword',
      // Batch R2 (KIOSK-1): every kiosk route, which already depends on Redis.
      'kioskDevice',
    ]);
    for (const [name, policies] of Object.entries(RATE_LIMITS)) {
      for (const entry of policies as RateLimitPolicy[]) {
        expect(entry.failMode, name).toBe(closed.has(name) ? 'closed' : 'open');
        expect(entry.limit).toBeGreaterThan(0);
        expect(entry.windowMs).toBeGreaterThanOrEqual(60_000);
      }
    }
    const names = Object.values(RATE_LIMITS).flatMap((policies) =>
      (policies as RateLimitPolicy[]).map((entry) => entry.name),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('stores policies as route metadata', () => {
    const handler = routeWith(...RATE_LIMITS.authForgotPassword);
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA, handler)).toEqual(
      RATE_LIMITS.authForgotPassword,
    );
  });
});
