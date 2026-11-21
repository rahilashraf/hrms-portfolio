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
 * Phase 13 HTTP surface: every recruitment route is authenticated, DTOs are validated (and
 * unknown fields refused) before any service runs, and a user without recruitment grants is
 * refused — never shown another organization's data.
 */
describe('Recruitment routes (e2e)', () => {
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
    jobOpening: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
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

  it('requires authentication on every recruitment route', async () => {
    const routes: Array<['get' | 'post' | 'patch' | 'put' | 'delete', string]> =
      [
        ['get', '/recruitment/organizations'],
        ['get', `/recruitment/dashboard?organizationId=${id}`],
        ['get', `/recruitment/stages?organizationId=${id}`],
        ['post', '/recruitment/stages'],
        ['post', '/recruitment/stages/initialize'],
        ['post', '/recruitment/stages/reorder'],
        ['patch', `/recruitment/stages/${id}`],
        ['post', `/recruitment/stages/${id}/archive`],
        ['get', `/recruitment/openings?organizationId=${id}`],
        ['post', '/recruitment/openings'],
        ['get', `/recruitment/openings/${id}`],
        ['patch', `/recruitment/openings/${id}`],
        ['post', `/recruitment/openings/${id}/open`],
        ['get', `/recruitment/candidates?organizationId=${id}`],
        ['post', '/recruitment/candidates'],
        ['get', `/recruitment/candidates/${id}`],
        ['patch', `/recruitment/candidates/${id}`],
        ['put', `/recruitment/candidates/${id}/internal-employee`],
        ['post', `/recruitment/candidates/${id}/merge`],
        ['post', `/recruitment/candidates/${id}/documents`],
        ['post', `/recruitment/documents/${id}/remove`],
        ['get', `/recruitment/applications?organizationId=${id}`],
        ['post', '/recruitment/applications'],
        ['get', `/recruitment/applications/${id}`],
        ['post', `/recruitment/applications/${id}/stage`],
        ['put', `/recruitment/applications/${id}/screening`],
        ['post', `/recruitment/applications/${id}/withdraw`],
        ['post', `/recruitment/applications/${id}/reject`],
        ['post', `/recruitment/applications/${id}/offers`],
        ['patch', `/recruitment/offers/${id}`],
        ['post', `/recruitment/offers/${id}/accept`],
        ['post', `/recruitment/applications/${id}/hire`],
        ['get', '/recruitment/me/interviews'],
        ['post', `/recruitment/applications/${id}/interviews`],
        ['patch', `/recruitment/interviews/${id}`],
        ['post', `/recruitment/interviews/${id}/complete`],
        ['post', `/recruitment/interviews/${id}/cancel`],
        ['post', `/recruitment/interviews/${id}/interviewers`],
        ['delete', `/recruitment/interviews/${id}/interviewers/${id}`],
        ['get', `/recruitment/interviews/${id}/feedback`],
        ['put', `/recruitment/interviews/${id}/feedback/me`],
        ['post', `/recruitment/interviews/${id}/feedback/me/submit`],
        ['post', `/recruitment/feedback/${id}/reopen`],
        ['get', `/recruitment/intake-sources?organizationId=${id}`],
        ['post', '/recruitment/intake-sources'],
        ['post', `/recruitment/intake-sources/${id}/import`],
        ['get', `/recruitment/intake?organizationId=${id}`],
        ['post', `/recruitment/intake/${id}/assign-opening`],
        ['post', `/recruitment/intake/${id}/reject`],
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
    // Unknown fields and malformed shapes are refused.
    await server()
      .post('/recruitment/openings')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        code: 'REQ-1',
        title: 'Teacher',
        employmentType: 'FULL_TIME',
        isAdmin: true,
      })
      .expect(400);
    await server()
      .post('/recruitment/openings')
      .set('Authorization', auth)
      .send({
        organizationId: 'not-a-uuid',
        code: 'REQ-1',
        title: 'Teacher',
        employmentType: 'INTERN',
      })
      .expect(400);
    await server()
      .post(`/recruitment/openings/${id}/delete`)
      .set('Authorization', auth)
      .send({})
      .expect(400);
    await server()
      .post(`/recruitment/offers/${id}/hire`)
      .set('Authorization', auth)
      .send({})
      .expect(400);
    await server()
      .get('/recruitment/applications/not-a-uuid')
      .set('Authorization', auth)
      .expect(400);
    await server()
      .post(`/recruitment/applications/${id}/offers`)
      .set('Authorization', auth)
      .send({
        positionId: id,
        employmentType: 'FULL_TIME',
        startDate: '01/04/2026',
        payBasis: 'SALARY',
        rateAmount: '1',
        currency: 'CAD',
      })
      .expect(400);
    await server()
      .put(`/recruitment/interviews/${id}/feedback/me`)
      .set('Authorization', auth)
      .send({ rating: 9, recommendation: 'MAYBE' })
      .expect(400);
    await server()
      .post(`/recruitment/intake-sources/${id}/import`)
      .set('Authorization', auth)
      .send({
        submissions: [
          {
            externalResponseId: 'r1',
            submittedAt: '2026-01-01T00:00:00Z',
            candidate: { firstName: 'A' },
          },
        ],
      })
      .expect(400);
    await server()
      .post(`/recruitment/applications/${id}/withdraw`)
      .set('Authorization', auth)
      .send({})
      .expect(400);
  });

  it('refuses users without recruitment grants and shows them no organizations', async () => {
    const auth = `Bearer ${token}`;
    const organizations = await request(app.getHttpServer())
      .get('/recruitment/organizations')
      .set('Authorization', auth)
      .expect(200);
    expect(organizations.body).toEqual({ items: [] });
    await request(app.getHttpServer())
      .get(`/recruitment/dashboard?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/recruitment/stages?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/recruitment/intake?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/recruitment/openings/${id}`)
      .set('Authorization', auth)
      .expect(404);
  });
});
