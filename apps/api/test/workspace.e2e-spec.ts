import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { DEFAULT_PUBLIC_BRANDING } from '../src/branding/branding-domain.js';
import { configureHttpApplication } from '../src/config/http-application.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { InMemoryMetricsService } from '../src/observability/metrics.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Phase 20 HTTP surface: the workspace, dashboard, setup, capability, branding and role
 * template routes are authenticated and validated; a caller without grants learns nothing;
 * the public login branding is reachable without credentials, rate limited, returns only
 * public fields and is the one route with a short public Cache-Control.
 */
describe('Phase 20 routes (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const id = '00000000-0000-4000-8000-000000000001';
  const empty = { findMany: vi.fn(async () => []) };
  const prisma: Record<string, unknown> & {
    organization: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  } = {
    $transaction: vi.fn(async (run: (client: unknown) => unknown) =>
      run(prisma),
    ),
    user: {
      findUnique: vi.fn(async () => ({
        id: 'user-1',
        email: 'nobody@example.com',
        person: {
          firstName: null,
          lastName: null,
          preferredName: null,
          employee: null,
        },
      })),
    },
    organization: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    organizationModuleSetting: empty,
    organizationalUnit: empty,
    department: empty,
    team: empty,
    employmentAssignment: { findMany: vi.fn(async () => []) },
    employee: { findUnique: vi.fn(async () => null) },
  };
  const authorization = {
    effectiveGrants: vi.fn(async () => []),
    effectivePermissionKeys: vi.fn(async () => []),
  };
  const redisEval = vi.fn().mockResolvedValue(1);

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
      .useValue({ client: { eval: redisEval } })
      .overrideProvider(SessionsService)
      .useValue({
        findActiveByIdAndUser: vi.fn().mockResolvedValue({ id: 'session-1' }),
      })
      .overrideProvider(AuthorizationService)
      .useValue(authorization)
      .compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    configureHttpApplication(app, {
      production: false,
      webOrigin: 'http://localhost:3000',
      trustProxyHops: 0,
      metrics: new InMemoryMetricsService(),
    });
    await app.init();
    token = await app
      .get(AccessTokenService)
      .issue({ userId: 'user-1', sessionId: 'session-1' });
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());
  const auth = () => `Bearer ${token}`;

  it('requires authentication on every Phase 20 route except the public branding', async () => {
    const routes: Array<['get' | 'put', string]> = [
      ['get', '/auth/me/workspace'],
      ['get', `/dashboard?organizationId=${id}`],
      ['get', `/organizations/${id}/setup`],
      ['get', `/organizations/${id}/branding`],
      ['put', `/organizations/${id}/branding`],
      ['get', `/employees/${id}/capabilities`],
      ['get', '/authorization/role-templates'],
      ['get', `/authorization/permissions?organizationId=${id}`],
    ];
    for (const [method, path] of routes) {
      const response = await server()[method](path).send({});
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it('serves generic public branding without credentials, with a short public cache', async () => {
    const response = await server().get('/public/branding');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULT_PUBLIC_BRANDING);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    // The Phase 19 security headers still apply.
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    // Counted by the rate limiter (by address).
    expect(redisEval).toHaveBeenCalled();
    // Every other route keeps no-store.
    const other = await server()
      .get('/auth/me/workspace')
      .set('Authorization', auth());
    expect(other.headers['cache-control']).toBe('no-store');
  });

  it('returns only the public fields of an opted-in organization', async () => {
    prisma.organization.findUnique.mockResolvedValueOnce({
      name: 'Acme Inc',
      archivedAt: null,
      branding: {
        displayName: 'Acme',
        shortName: null,
        loginLogoUrl: 'https://cdn.example.com/login.svg',
        iconUrl: null,
        primaryColor: '#112233',
        secondaryColor: null,
        loginSubtitle: null,
        websiteUrl: null,
        supportEmail: null,
        publicLoginEnabled: true,
      },
    });
    const response = await server().get('/public/branding?organization=acme');
    expect(response.status).toBe(200);
    expect(prisma.organization.findUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { code: 'ACME' } }),
    );
    expect(response.body).toEqual({
      ...DEFAULT_PUBLIC_BRANDING,
      source: 'ORGANIZATION',
      displayName: 'Acme',
      shortName: 'Acme',
      loginLogoUrl: 'https://cdn.example.com/login.svg',
      primaryColor: '#112233',
    });
  });

  it('validates the public query', async () => {
    for (const query of [
      'organization=%3Cscript%3E',
      'organization=a',
      'extra=1',
    ])
      expect(
        (await server().get(`/public/branding?${query}`)).status,
        query,
      ).toBe(400);
  });

  it('validates requests before any service runs', async () => {
    const put = (path: string, body: Record<string, unknown>) =>
      server().put(path).set('Authorization', auth()).send(body);
    expect(
      (await put(`/organizations/${id}/branding`, { displayName: 'A' })).status,
    ).toBe(400);
    expect(
      (
        await put(`/organizations/${id}/branding`, {
          expectedVersion: 0,
          unknown: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put(`/organizations/${id}/branding`, {
          expectedVersion: 0,
          publicLoginEnabled: 'yes',
        })
      ).status,
    ).toBe(400);
    expect(
      (await put('/organizations/not-a-uuid/branding', { expectedVersion: 0 }))
        .status,
    ).toBe(400);
    for (const path of [
      '/dashboard',
      '/dashboard?organizationId=nope',
      '/organizations/nope/setup',
      '/employees/nope/capabilities',
      '/authorization/role-templates?organizationId=nope',
    ])
      expect(
        (await server().get(path).set('Authorization', auth())).status,
        path,
      ).toBe(400);
  });

  it('refuses a caller without grants without revealing anything', async () => {
    const get = (path: string) =>
      server().get(path).set('Authorization', auth());
    const workspace = await get('/auth/me/workspace');
    expect(workspace.status).toBe(200);
    expect(workspace.body).toMatchObject({
      user: { id: 'user-1', displayName: 'nobody@example.com' },
      systemPermissions: [],
      organizations: [],
    });
    for (const path of [
      `/dashboard?organizationId=${id}`,
      `/organizations/${id}/setup`,
      `/organizations/${id}/branding`,
      `/employees/${id}/capabilities`,
    ])
      expect((await get(path)).status, path).toBe(404);
    expect(
      (
        await server()
          .put(`/organizations/${id}/branding`)
          .set('Authorization', auth())
          .send({ expectedVersion: 0 })
      ).status,
    ).toBe(404);
    expect((await get('/authorization/role-templates')).status).toBe(403);
  });
});
