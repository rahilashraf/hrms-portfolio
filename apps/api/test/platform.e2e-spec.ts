import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { configureHttpApplication } from '../src/config/http-application.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { InMemoryMetricsService } from '../src/observability/metrics.service.js';
import { RATE_LIMIT_SCRIPT } from '../src/rate-limit/rate-limit.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

const WEB_ORIGIN = 'http://localhost:3000';

/**
 * Phase 19 HTTP boundary: probes, security headers, CORS, request ids, body limits, rate
 * limiting (429 with Retry-After; fail open or closed per route class) and safe request logs,
 * through the same pipeline main.ts configures.
 */
describe('Platform hardening (e2e)', () => {
  let app: INestApplication<App>;
  let tokenA: string;
  let tokenB: string;
  const metrics = new InMemoryMetricsService();
  const counters = new Map<string, number>();
  let redisDown = false;
  const redis = {
    client: {
      ping: vi.fn(async () => {
        if (redisDown) throw new Error('down');
        return 'PONG';
      }),
      eval: vi.fn(
        async (
          script: string,
          keyCount: number,
          ...args: Array<string | number>
        ) => {
          if (redisDown) throw new Error('down');
          if (script !== RATE_LIMIT_SCRIPT) return 1;
          const keys = args.slice(0, keyCount) as string[];
          const argv = args.slice(keyCount).map(Number);
          let blocked = 0;
          keys.forEach((key, index) => {
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            if (count > argv[index * 2 + 1]!) blocked = argv[index * 2]!;
          });
          return blocked > 0 ? -blocked : 1;
        },
      ),
    },
  };
  const prisma = {
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
    user: { findUnique: vi.fn(async () => null) },
    organization: { findMany: vi.fn(async () => []) },
    notification: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://hrms:hrms_dev_password@localhost:5436/hrms';
    process.env.JWT_ACCESS_SECRET =
      'e2e-only-deterministic-secret-value-at-least-32';
    process.env.REDIS_URL ??= 'redis://localhost:6380';
    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(redis)
      .overrideProvider(SessionsService)
      .useValue({
        findActiveByIdAndUser: vi.fn().mockResolvedValue({ id: 'session-1' }),
      })
      .overrideProvider(AuthorizationService)
      .useValue({
        effectiveGrants: vi.fn(async () => []),
        getCurrentGrantSnapshot: vi.fn(async () => ({
          userId: 'user-a',
          permissions: [],
        })),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    configureHttpApplication(app, {
      production: false,
      webOrigin: WEB_ORIGIN,
      trustProxyHops: 0,
      metrics,
    });
    await app.init();
    const tokens = app.get(AccessTokenService);
    tokenA = await tokens.issue({ userId: 'user-a', sessionId: 'session-1' });
    tokenB = await tokens.issue({ userId: 'user-b', sessionId: 'session-1' });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    counters.clear();
    redisDown = false;
  });

  const server = () => request(app.getHttpServer());

  it('serves liveness without authentication or dependencies', async () => {
    prisma.$queryRaw.mockClear();
    const response = await server().get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports readiness per component, 503 without internal details', async () => {
    const ready = await server().get('/ready').expect(200);
    expect(ready.body).toEqual({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });

    prisma.$queryRaw.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'),
    );
    redisDown = true;
    const down = await server().get('/ready').expect(503);
    expect(down.body).toEqual({
      status: 'not_ready',
      checks: { database: 'down', redis: 'down' },
    });
    expect(JSON.stringify(down.body)).not.toMatch(/ECONNREFUSED|secret|5432/);
  });

  it('sends the API security headers on every response, including errors', async () => {
    for (const path of ['/health', '/auth/me', '/does-not-exist']) {
      const response = await server().get(path);
      expect(response.headers['x-content-type-options'], path).toBe('nosniff');
      expect(response.headers['referrer-policy'], path).toBe('no-referrer');
      expect(response.headers['x-frame-options'], path).toBe('DENY');
      expect(response.headers['content-security-policy'], path).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers['cache-control'], path).toBe('no-store');
      expect(response.headers['x-powered-by'], path).toBeUndefined();
      // HSTS is a production-only header (the API is behind HTTPS there).
      expect(
        response.headers['strict-transport-security'],
        path,
      ).toBeUndefined();
    }
  });

  it('marks authenticated personal-data responses no-store', async () => {
    for (const path of ['/documents/me', '/notifications/me', '/auth/me']) {
      const response = await server()
        .get(path)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(response.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('allows credentialed CORS only from the web origin', async () => {
    const allowed = await server()
      .options('/auth/refresh')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const foreign = await server()
      .options('/auth/refresh')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(foreign.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example.com',
    );
    const exposed = await server().get('/health').set('Origin', WEB_ORIGIN);
    expect(exposed.headers['access-control-expose-headers']).toContain(
      'Retry-After',
    );
  });

  it('accepts a safe request id, replaces an unsafe one and echoes it', async () => {
    const kept = await server()
      .get('/health')
      .set('X-Request-Id', 'req-123.abc');
    expect(kept.headers['x-request-id']).toBe('req-123.abc');

    const replaced = await server()
      .get('/health')
      .set('X-Request-Id', '<script>alert(1)</script>');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const generated = await server().get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses oversized bodies before any route runs', async () => {
    const response = await server()
      .post('/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(1_100_000) }));
    expect(response.status).toBe(413);
    expect(response.text).not.toMatch(/at .*node_modules|<pre>/);
  });

  it('throttles password reset by address with 429, Retry-After and RATE_LIMITED', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await server().post('/auth/reset-password').send({});
      expect(response.status).toBe(400);
    }
    const limited = await server().post('/auth/reset-password').send({});
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['retry-after']).toBe(String(15 * 60));
  });

  it('throttles forgot-password per email across addresses', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await server()
        .post('/auth/forgot-password')
        .send({ email: 'person@example.com' });
    }
    const limited = await server()
      .post('/auth/forgot-password')
      .send({ email: ' PERSON@example.com' });
    expect(limited.status).toBe(429);
    const other = await server()
      .post('/auth/forgot-password')
      .send({ email: 'other@example.com' });
    expect(other.status).not.toBe(429);
  });

  it('fails credential flows closed and authenticated routes open without Redis', async () => {
    redisDown = true;
    const closed = await server().post('/auth/reset-password').send({});
    expect(closed.status).toBe(503);
    expect(closed.body).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });

    const open = await server()
      .post('/notifications/me/read-all')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(open.status).toBe(200);
  });

  it('counts authenticated limits per user', async () => {
    const readAll = (token: string) =>
      server()
        .post('/notifications/me/read-all')
        .set('Authorization', `Bearer ${token}`)
        .send({});
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await readAll(tokenA)).status).toBe(200);
    }
    expect((await readAll(tokenA)).status).toBe(429);
    expect((await readAll(tokenB)).status).toBe(200);
  });

  it('logs one safe structured line per request', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capture = (_message: unknown, fields: unknown) => {
      if (fields && typeof fields === 'object')
        lines.push(fields as Record<string, unknown>);
    };
    const spies = [
      vi.spyOn(Logger.prototype, 'log').mockImplementation(capture),
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
    ];
    try {
      await server()
        .get('/documents/me?token=super-secret-token')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Cookie', 'hrms_refresh=refresh-secret')
        .set('X-Request-Id', 'trace-1');
      await server().post('/auth/forgot-password').send({
        email: 'person@example.com',
      });
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    const documents = lines.find((line) => line.requestId === 'trace-1');
    expect(documents).toMatchObject({
      method: 'GET',
      route: '/documents/me',
      userId: 'user-a',
    });
    expect(typeof documents?.status).toBe('number');
    expect(typeof documents?.durationMs).toBe('number');
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toMatch(
      /super-secret-token|refresh-secret|Bearer|person@example\.com/,
    );
    expect(metrics.counters.size).toBeGreaterThan(0);
  });
});
