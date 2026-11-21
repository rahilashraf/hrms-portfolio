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
 * Phase 15 HTTP surface: every documents route is authenticated, DTOs are validated (and
 * unknown fields refused) before any service runs, and a user without document grants is
 * refused without learning whether a record exists.
 */
describe('Documents routes (e2e)', () => {
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
    employeeDocument: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    policyDocument: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
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

  it('requires authentication on every documents route', async () => {
    const routes: Array<['get' | 'post' | 'patch', string]> = [
      ['get', '/documents/organizations'],
      ['get', '/documents/me'],
      ['get', '/documents/me/policies'],
      ['post', '/documents/me/provide'],
      ['get', `/documents/types?organizationId=${id}`],
      ['post', '/documents/types'],
      ['post', '/documents/types/initialize'],
      ['patch', `/documents/types/${id}`],
      ['post', `/documents/types/${id}/archive`],
      ['get', `/documents/requirements?organizationId=${id}`],
      ['post', '/documents/requirements'],
      ['post', `/documents/requirements/${id}/archive`],
      ['post', '/documents/records'],
      ['get', `/documents/records/${id}`],
      ['patch', `/documents/records/${id}`],
      ['post', `/documents/records/${id}/versions`],
      ['post', `/documents/records/${id}/archive`],
      ['get', `/documents/employees/${id}`],
      ['get', `/documents/expiring?organizationId=${id}`],
      ['get', `/documents/missing?organizationId=${id}`],
      ['post', `/documents/handoff/${id}`],
      ['get', `/documents/policies?organizationId=${id}`],
      ['post', '/documents/policies'],
      ['patch', `/documents/policies/${id}`],
      ['post', `/documents/policies/${id}/versions`],
      ['post', `/documents/policies/${id}/versions/${id}/publish`],
      ['post', `/documents/policies/${id}/retire`],
      ['post', `/documents/policies/${id}/versions/${id}/acknowledge`],
      ['get', `/documents/policies/${id}/acknowledgements`],
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
    await server()
      .post('/documents/records')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        employeeId: id,
        typeId: id,
        title: 'Agreement',
        version: { provider: 'DROPBOX' },
      })
      .expect(400);
    await server()
      .post('/documents/types')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        code: 'X',
        name: 'x',
        category: 'OTHER',
        defaultConfidentiality: 'TOP_SECRET',
      })
      .expect(400);
    await server()
      .post(`/documents/records/${id}/versions`)
      .set('Authorization', auth)
      .send({ provider: 'MANUAL_REFERENCE', expiresOn: '31/12/2026' })
      .expect(400);
    await server()
      .post(`/documents/records/${id}/versions`)
      .set('Authorization', auth)
      .send({ provider: 'MANUAL_REFERENCE', sizeBytes: -1 })
      .expect(400);
    await server()
      .post(`/documents/policies/${id}/versions/${id}/acknowledge`)
      .set('Authorization', auth)
      .send({ statementAccepted: false })
      .expect(400);
    await server()
      .post(`/documents/records/${id}/archive`)
      .set('Authorization', auth)
      .send({})
      .expect(400);
    await server()
      .post('/documents/me/provide')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        typeId: id,
        title: 'x',
        version: { provider: 'MANUAL_REFERENCE' },
        employeeId: id,
      })
      .expect(400);
    await server()
      .get('/documents/records/not-a-uuid')
      .set('Authorization', auth)
      .expect(400);
  });

  it('refuses users without document grants', async () => {
    const auth = `Bearer ${token}`;
    const server = () => request(app.getHttpServer());
    expect(
      (
        await server()
          .get('/documents/organizations')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toMatchObject({ items: [], uploads: { enabled: expect.any(Boolean) } });
    expect(
      (
        await server()
          .get('/documents/me')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    expect(
      (
        await server()
          .get('/documents/me/policies')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    await server()
      .get(`/documents/types?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await server()
      .get(`/documents/expiring?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await server()
      .get(`/documents/missing?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await server()
      .get(`/documents/records/${id}`)
      .set('Authorization', auth)
      .expect(404);
  });
});
