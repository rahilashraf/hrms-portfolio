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
 * Phase 14 HTTP surface: every onboarding route is authenticated, DTOs are validated (and
 * unknown fields refused) before any service runs, and a user without onboarding grants is
 * refused.
 */
describe('Onboarding routes (e2e)', () => {
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
    employeeWorkflow: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    employeeWorkflowTask: { findMany: vi.fn(async () => []) },
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

  it('requires authentication on every onboarding route', async () => {
    const routes: Array<['get' | 'post' | 'patch' | 'put', string]> = [
      ['get', '/onboarding/organizations'],
      ['get', '/onboarding/me'],
      ['get', '/onboarding/me/tasks'],
      ['get', `/onboarding/templates?organizationId=${id}`],
      ['post', '/onboarding/templates'],
      ['patch', `/onboarding/templates/${id}`],
      ['post', `/onboarding/templates/${id}/activate`],
      ['post', `/onboarding/templates/${id}/archive`],
      ['post', `/onboarding/templates/${id}/default`],
      ['get', `/onboarding/workflows?organizationId=${id}`],
      ['get', `/onboarding/employees/${id}/workflows`],
      ['post', '/onboarding/workflows/onboarding'],
      ['post', '/onboarding/workflows/offboarding'],
      ['post', `/onboarding/from-hire/${id}`],
      ['get', `/onboarding/workflows/${id}`],
      ['post', `/onboarding/workflows/${id}/cancel`],
      ['post', `/onboarding/workflows/${id}/complete`],
      ['post', `/onboarding/tasks/${id}/start`],
      ['post', `/onboarding/tasks/${id}/complete`],
      ['post', `/onboarding/tasks/${id}/acknowledge`],
      ['post', `/onboarding/tasks/${id}/waive`],
      ['post', `/onboarding/tasks/${id}/reopen`],
      ['put', `/onboarding/tasks/${id}/owner`],
      ['put', `/onboarding/tasks/${id}/due-date`],
      ['post', '/onboarding/task-completions/import'],
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
      .post('/onboarding/templates')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        kind: 'ONBOARDING',
        code: 'X1',
        name: 'x',
        tasks: [{ title: 't', category: 'OTHER', ownerType: 'ROBOT' }],
      })
      .expect(400);
    await server()
      .post('/onboarding/workflows/offboarding')
      .set('Authorization', auth)
      .send({ employmentAssignmentId: id })
      .expect(400);
    await server()
      .post('/onboarding/workflows/onboarding')
      .set('Authorization', auth)
      .send({ employmentAssignmentId: id, extra: true })
      .expect(400);
    await server()
      .post(`/onboarding/tasks/${id}/acknowledge`)
      .set('Authorization', auth)
      .send({ statementAccepted: false })
      .expect(400);
    await server()
      .post(`/onboarding/tasks/${id}/waive`)
      .set('Authorization', auth)
      .send({})
      .expect(400);
    await server()
      .put(`/onboarding/tasks/${id}/due-date`)
      .set('Authorization', auth)
      .send({ dueDate: '31/12/2026', reason: 'x' })
      .expect(400);
    await server()
      .get('/onboarding/workflows/not-a-uuid')
      .set('Authorization', auth)
      .expect(400);
  });

  it('refuses users without onboarding grants', async () => {
    const auth = `Bearer ${token}`;
    expect(
      (
        await request(app.getHttpServer())
          .get('/onboarding/organizations')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    expect(
      (
        await request(app.getHttpServer())
          .get('/onboarding/me')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    await request(app.getHttpServer())
      .get(`/onboarding/templates?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/onboarding/workflows?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/onboarding/workflows/${id}`)
      .set('Authorization', auth)
      .expect(404);
  });
});
