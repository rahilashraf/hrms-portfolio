import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Phase 18 HTTP surface: every feature-management route is authenticated, DTOs are validated
 * (unknown fields refused) before any service runs, users without feature.read / feature.manage
 * are refused, and a disabled module answers 403 { code: 'FEATURE_DISABLED', module }.
 */
describe('Feature management routes (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const id = '00000000-0000-4000-8000-000000000001';
  let disabledModules: string[] = [];
  const prisma: Record<string, unknown> = {
    user: {
      findUnique: vi.fn(async () => ({
        email: 'nobody@example.com',
        personId: 'person-1',
        person: { employee: null },
      })),
    },
    organization: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id, archivedAt: null })),
    },
    organizationModuleSetting: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId_module: { module: string } };
        }) =>
          disabledModules.includes(where.organizationId_module.module)
            ? { enabled: false }
            : null,
      ),
      findMany: vi.fn(async () => []),
    },
    payrollCalendar: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(
      async (run: (client: unknown) => Promise<unknown>): Promise<unknown> =>
        run(prisma),
    ),
  };
  const authorization = {
    effectiveGrants: vi.fn(async () => []),
    canAccess: vi.fn(async () => false),
    getCurrentGrantSnapshot: vi.fn(async () => ({
      userId: 'user-1',
      permissions: [],
    })),
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
      .useValue({ client: { eval: vi.fn().mockResolvedValue(1) } })
      .overrideProvider(SessionsService)
      .useValue({
        findActiveByIdAndUser: vi.fn().mockResolvedValue({ id: 'session-1' }),
      })
      .overrideProvider(AuthorizationService)
      .useValue(authorization)
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
    await app?.close();
  });

  const routes: Array<['get' | 'put' | 'post', string]> = [
    ['get', '/admin/features/organizations'],
    ['get', `/admin/features?organizationId=${id}`],
    ['get', `/admin/features/history?organizationId=${id}`],
    ['put', '/admin/features/modules/PAYROLL'],
    ['put', '/admin/features/settings/documents.selfServiceProvide'],
    ['post', '/admin/features/settings/documents.selfServiceProvide/reset'],
  ];

  it('requires authentication on every feature route', async () => {
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
    const bad: Array<['get' | 'put' | 'post', string, unknown]> = [
      ['get', '/admin/features', undefined],
      ['get', '/admin/features?organizationId=not-a-uuid', undefined],
      [
        'get',
        `/admin/features/history?organizationId=${id}&limit=0`,
        undefined,
      ],
      [
        'get',
        `/admin/features/history?organizationId=${id}&before=yesterday`,
        undefined,
      ],
      ['put', '/admin/features/modules/PAYROLL', { enabled: false }],
      [
        'put',
        '/admin/features/modules/PAYROLL',
        { organizationId: id, enabled: 'no', expectedVersion: 0 },
      ],
      [
        'put',
        '/admin/features/modules/PAYROLL',
        { organizationId: id, enabled: false, expectedVersion: -1 },
      ],
      [
        'put',
        '/admin/features/modules/PAYROLL',
        { organizationId: id, enabled: false },
      ],
      [
        'put',
        '/admin/features/modules/PAYROLL',
        { organizationId: id, enabled: false, expectedVersion: 0, extra: 1 },
      ],
      [
        'put',
        '/admin/features/settings/documents.selfServiceProvide',
        { organizationId: id, expectedVersion: 0 },
      ],
      [
        'put',
        '/admin/features/settings/documents.selfServiceProvide',
        { organizationId: id, value: true, expectedVersion: 1.5 },
      ],
      [
        'post',
        '/admin/features/settings/documents.selfServiceProvide/reset',
        { organizationId: id },
      ],
      // Security remediation M2: the reason and confirmation of a guarded setting are typed.
      [
        'put',
        '/admin/features/settings/payroll.dualControl',
        { organizationId: id, value: false, expectedVersion: 0, reason: 12 },
      ],
      [
        'put',
        '/admin/features/settings/payroll.dualControl',
        {
          organizationId: id,
          value: false,
          expectedVersion: 0,
          reason: 'x'.repeat(501),
        },
      ],
      [
        'put',
        '/admin/features/settings/payroll.dualControl',
        {
          organizationId: id,
          value: false,
          expectedVersion: 0,
          confirm: 'yes',
        },
      ],
    ];
    for (const [method, path, body] of bad) {
      const response = await server()
        [method](path)
        .set('Authorization', auth)
        .send(body as object);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(400);
    }
  });

  it('refuses users without feature grants (no domain permission implies them)', async () => {
    const auth = `Bearer ${token}`;
    const server = () => request(app.getHttpServer());
    expect(
      (
        await server()
          .get('/admin/features/organizations')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    await server()
      .get(`/admin/features?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await server()
      .get(`/admin/features/history?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await server()
      .put('/admin/features/modules/PAYROLL')
      .set('Authorization', auth)
      .send({ organizationId: id, enabled: false, expectedVersion: 0 })
      .expect(403);
    await server()
      .put('/admin/features/settings/documents.selfServiceProvide')
      .set('Authorization', auth)
      .send({ organizationId: id, value: false, expectedVersion: 0 })
      .expect(403);
    await server()
      .post('/admin/features/settings/documents.selfServiceProvide/reset')
      .set('Authorization', auth)
      .send({ organizationId: id, expectedVersion: 0 })
      .expect(403);
  });

  it('refuses unknown modules and settings, and invalid values, with domain codes', async () => {
    const auth = `Bearer ${token}`;
    const server = () => request(app.getHttpServer());
    expect(
      (
        await server()
          .put('/admin/features/modules/EMPLOYEES')
          .set('Authorization', auth)
          .send({ organizationId: id, enabled: false, expectedVersion: 0 })
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'FEATURE_MODULE_UNKNOWN' });
    expect(
      (
        await server()
          .put('/admin/features/settings/time.selfClock')
          .set('Authorization', auth)
          .send({ organizationId: id, value: true, expectedVersion: 0 })
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'SETTING_UNKNOWN' });
    expect(
      (
        await server()
          .put('/admin/features/settings/documents.selfServiceProvide')
          .set('Authorization', auth)
          .send({ organizationId: id, value: 'false', expectedVersion: 0 })
          .expect(400)
      ).body,
    ).toMatchObject({
      code: 'SETTING_VALUE_INVALID',
      key: 'documents.selfServiceProvide',
    });
  });

  it('answers 403 FEATURE_DISABLED (with the module) on a gated domain route', async () => {
    const auth = `Bearer ${token}`;
    authorization.canAccess.mockResolvedValue(true);
    try {
      disabledModules = [];
      await request(app.getHttpServer())
        .get(`/payroll/calendars?organizationId=${id}`)
        .set('Authorization', auth)
        .expect(200);
      disabledModules = ['PAYROLL'];
      const response = await request(app.getHttpServer())
        .get(`/payroll/calendars?organizationId=${id}`)
        .set('Authorization', auth)
        .expect(403);
      expect(response.body).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        code: 'FEATURE_DISABLED',
        message: 'Payroll is disabled for this organization.',
        module: 'PAYROLL',
      });
    } finally {
      authorization.canAccess.mockResolvedValue(false);
      disabledModules = [];
    }
  });
});
