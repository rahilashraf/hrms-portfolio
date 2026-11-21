import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { GOOGLE_API_CLIENT } from '../src/integrations/google/google-api.client.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Phase 16.5 HTTP surface: every Google Workspace route except the OAuth redirect callback is
 * authenticated; DTOs are validated (unknown fields refused) before any service runs; a user
 * without integration grants is refused (403 at organization level, 404 for a binding); and
 * without the OAuth client / encryption key the deployment answers 503. No Google API is ever
 * reached (the client is replaced by one that fails the test if called).
 */
describe('Google Workspace routes (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const id = '00000000-0000-4000-8000-000000000001';
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        email: 'nobody@example.com',
        personId: 'person-1',
        person: { employee: null },
      })),
    },
    googleFormBinding: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    googleWorkspaceConnection: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    organization: { findMany: vi.fn(async () => []) },
    organizationalUnit: { count: vi.fn(async () => 0) },
    department: { count: vi.fn(async () => 0) },
    team: { count: vi.fn(async () => 0) },
  };
  const authorization = {
    effectiveGrants: vi.fn(async () => []),
    getCurrentGrantSnapshot: vi.fn(async () => ({
      userId: 'user-1',
      permissions: [],
    })),
  };
  const forbidden = () => {
    throw new Error('No Google API may be called in route tests.');
  };
  const google = Object.fromEntries(
    [
      'exchangeAuthorizationCode',
      'refreshAccessToken',
      'jwtBearerToken',
      'revokeToken',
      'getForm',
      'listFormResponses',
      'getDriveFile',
      'createSpreadsheet',
      'appendValues',
      'sendGmailMessage',
    ].map((name) => [name, vi.fn(forbidden)]),
  );

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://hrms:hrms_dev_password@localhost:5436/hrms';
    process.env.JWT_ACCESS_SECRET =
      'e2e-only-deterministic-secret-value-at-least-32';
    process.env.REDIS_URL ??= 'redis://localhost:6380';
    // The deployment is not configured for Google in this suite.
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue({ client: { eval: vi.fn().mockResolvedValue(1) } })
      .overrideProvider(SessionsService)
      .useValue({
        findActiveByIdAndUser: vi.fn().mockResolvedValue({ id: 'session-1' }),
      })
      .overrideProvider(AuthorizationService)
      .useValue(authorization)
      .overrideProvider(GOOGLE_API_CLIENT)
      .useValue(google)
      .compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    token = await app
      .get(AccessTokenService)
      .issue({ userId: 'user-1', sessionId: 'session-1' });
  });

  afterAll(async () => {
    for (const fn of Object.values(google)) expect(fn).not.toHaveBeenCalled();
    await app?.close();
  });

  it('requires authentication on every administration route', async () => {
    const routes: Array<['get' | 'post' | 'patch', string]> = [
      ['get', '/integrations/google/organizations'],
      ['get', `/integrations/google/status?organizationId=${id}`],
      ['post', '/integrations/google/oauth/start'],
      ['post', '/integrations/google/oauth/complete'],
      ['post', '/integrations/google/service-account'],
      ['post', '/integrations/google/disconnect'],
      ['post', '/integrations/google/health-check'],
      ['get', `/integrations/google/sources?organizationId=${id}`],
      ['get', `/integrations/google/bindings?organizationId=${id}`],
      ['post', '/integrations/google/bindings'],
      ['patch', `/integrations/google/bindings/${id}`],
      ['post', `/integrations/google/bindings/${id}/archive`],
      ['post', `/integrations/google/bindings/${id}/sync`],
      ['get', `/integrations/google/sync-runs?organizationId=${id}`],
    ];
    for (const [method, path] of routes) {
      const response = await request(app.getHttpServer())
        [method](path)
        .send({});
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it('validates requests before any service runs', async () => {
    const auth = `Bearer ${token}`;
    const server = () => request(app.getHttpServer());
    const bad: Array<['get' | 'post' | 'patch', string, object]> = [
      ['get', '/integrations/google/status', {}],
      ['get', '/integrations/google/status?organizationId=nope', {}],
      [
        'post',
        '/integrations/google/oauth/start',
        { organizationId: id, capabilities: [] },
      ],
      [
        'post',
        '/integrations/google/oauth/start',
        { organizationId: id, capabilities: ['DRIVE_FULL_ACCESS'] },
      ],
      [
        'post',
        '/integrations/google/oauth/start',
        {
          organizationId: id,
          capabilities: ['FORMS'],
          redirectUri: 'https://evil.example',
        },
      ],
      ['post', '/integrations/google/oauth/complete', { state: 'short' }],
      [
        'post',
        '/integrations/google/service-account',
        {
          organizationId: id,
          keyJson: '{}',
          impersonatedUser: 'not-an-email',
          capabilities: ['FORMS'],
        },
      ],
      ['post', '/integrations/google/disconnect', { organizationId: 'x' }],
      ['post', '/integrations/google/health-check', {}],
      [
        'post',
        '/integrations/google/bindings',
        {
          organizationId: id,
          formId: 'short',
          target: 'ONBOARDING_TASKS',
          mapping: { schemaVersion: 1, fields: [] },
        },
      ],
      [
        'post',
        '/integrations/google/bindings',
        {
          organizationId: id,
          formId: 'form-1234567890',
          target: 'PAYROLL',
          mapping: { schemaVersion: 1, fields: [] },
        },
      ],
      [
        'post',
        '/integrations/google/bindings',
        {
          organizationId: id,
          formId: 'form-1234567890',
          target: 'ONBOARDING_TASKS',
          mapping: { schemaVersion: 2, fields: [] },
        },
      ],
      [
        'post',
        '/integrations/google/bindings',
        {
          organizationId: id,
          formId: 'form-1234567890',
          target: 'ONBOARDING_TASKS',
          mapping: {
            schemaVersion: 1,
            fields: [{ questionId: 'q 1', field: 'respondentEmail' }],
          },
        },
      ],
      [
        'post',
        '/integrations/google/bindings',
        {
          organizationId: id,
          formId: 'form-1234567890',
          target: 'ONBOARDING_TASKS',
          mapping: {
            schemaVersion: 1,
            fields: [{ questionId: 'q1', field: 'respondentEmail', raw: 'x' }],
          },
        },
      ],
      ['patch', `/integrations/google/bindings/${id}`, { enabled: 'yes' }],
      [
        'patch',
        `/integrations/google/bindings/${id}`,
        { formId: 'form-1234567890' },
      ],
      ['patch', '/integrations/google/bindings/not-a-uuid', { enabled: true }],
      ['post', '/integrations/google/bindings/not-a-uuid/sync', {}],
      [
        'get',
        `/integrations/google/sync-runs?organizationId=${id}&limit=500`,
        {},
      ],
      [
        'get',
        `/integrations/google/sync-runs?organizationId=${id}&bindingId=x`,
        {},
      ],
    ];
    for (const [method, path, body] of bad) {
      const response = await server()
        [method](path)
        .set('Authorization', auth)
        .send(body);
      expect(
        response.status,
        `${method.toUpperCase()} ${path} ${JSON.stringify(body)}`,
      ).toBe(400);
    }
  });

  it('answers 503 when the deployment has no OAuth client or encryption key', async () => {
    const auth = `Bearer ${token}`;
    const server = () => request(app.getHttpServer());
    const start = await server()
      .post('/integrations/google/oauth/start')
      .set('Authorization', auth)
      .send({ organizationId: id, capabilities: ['FORMS'] })
      .expect(503);
    expect(start.body.code).toBe('GOOGLE_OAUTH_NOT_CONFIGURED');
    expect(start.headers['set-cookie']).toBeUndefined();
    expect(
      (
        await server()
          .post('/integrations/google/oauth/complete')
          .set('Authorization', auth)
          .send({ state: 'a'.repeat(43), code: 'code' })
          .expect(503)
      ).body.code,
    ).toBe('GOOGLE_OAUTH_NOT_CONFIGURED');
    // The redirect callback is the one unauthenticated route; unconfigured it redirects the
    // browser back to the admin page with the error code instead of answering raw JSON.
    const callback = await server()
      .get(
        `/integrations/google/oauth/callback?state=${'a'.repeat(43)}&code=x&scope=openid&authuser=0`,
      )
      .expect(302);
    expect(callback.headers.location).toMatch(
      /\/settings\/integrations\/google\?result=error&code=GOOGLE_OAUTH_NOT_CONFIGURED$/,
    );
    expect(
      (
        await server()
          .post('/integrations/google/service-account')
          .set('Authorization', auth)
          .send({
            organizationId: id,
            keyJson: '{"type":"service_account"}',
            impersonatedUser: 'hr-bot@school.example',
            capabilities: ['FORMS'],
          })
          .expect(503)
      ).body.code,
    ).toBe('INTEGRATION_ENCRYPTION_NOT_CONFIGURED');
  });

  it('refuses users without integration grants without revealing bindings', async () => {
    const auth = `Bearer ${token}`;
    const server = () => request(app.getHttpServer());
    expect(
      (
        await server()
          .get('/integrations/google/organizations')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    for (const path of [
      `/integrations/google/status?organizationId=${id}`,
      `/integrations/google/bindings?organizationId=${id}`,
      `/integrations/google/sources?organizationId=${id}`,
      `/integrations/google/sync-runs?organizationId=${id}`,
    ]) {
      await server().get(path).set('Authorization', auth).expect(403);
    }
    for (const path of [
      '/integrations/google/disconnect',
      '/integrations/google/health-check',
    ]) {
      await server()
        .post(path)
        .set('Authorization', auth)
        .send({ organizationId: id })
        .expect(403);
    }
    await server()
      .post('/integrations/google/bindings')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        formId: 'form-1234567890',
        target: 'ONBOARDING_TASKS',
        mapping: { schemaVersion: 1, fields: [] },
      })
      .expect(403);
    await server()
      .patch(`/integrations/google/bindings/${id}`)
      .set('Authorization', auth)
      .send({ enabled: false })
      .expect(404);
    await server()
      .post(`/integrations/google/bindings/${id}/archive`)
      .set('Authorization', auth)
      .expect(404);
    await server()
      .post(`/integrations/google/bindings/${id}/sync`)
      .set('Authorization', auth)
      .expect(404);
  });
});
