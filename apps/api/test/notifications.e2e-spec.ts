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
 * Phase 16 HTTP surface: every notifications route is authenticated, DTOs are validated (and
 * unknown fields refused) before any service runs, a user's inbox holds only their own
 * notifications (others' are not found) and organization administration needs the
 * notification.* permissions.
 */
describe('Notifications routes (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const id = '00000000-0000-4000-8000-000000000001';
  const prisma = {
    notification: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    notificationPreference: { findMany: vi.fn(async () => []) },
    organization: { findMany: vi.fn(async () => []) },
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

  it('requires authentication on every notifications route', async () => {
    const routes: Array<['get' | 'post' | 'patch' | 'put', string]> = [
      ['get', '/notifications/me'],
      ['get', '/notifications/me/unread-count'],
      ['post', `/notifications/me/${id}/read`],
      ['post', '/notifications/me/read-all'],
      ['post', `/notifications/me/${id}/archive`],
      ['get', '/notifications/me/preferences'],
      ['put', '/notifications/me/preferences'],
      ['get', '/notifications/organizations'],
      ['get', `/notifications/templates?organizationId=${id}`],
      ['post', '/notifications/templates'],
      ['patch', `/notifications/templates/${id}`],
      ['post', `/notifications/templates/${id}/archive`],
      [
        'get',
        `/notifications/templates/preview?organizationId=${id}&key=onboarding.tasks-due`,
      ],
      ['get', `/notifications/settings?organizationId=${id}`],
      ['put', '/notifications/settings'],
      // Batch 8: the read-only delivery log.
      ['get', `/notifications/deliveries?organizationId=${id}`],
      ['get', `/notifications/deliveries/${id}`],
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
      .get('/notifications/me?limit=500')
      .set('Authorization', auth)
      .expect(400);
    await server()
      .get('/notifications/me?unreadOnly=maybe')
      .set('Authorization', auth)
      .expect(400);
    await server()
      .post('/notifications/me/not-a-uuid/read')
      .set('Authorization', auth)
      .expect(400);
    await server()
      .put('/notifications/me/preferences')
      .set('Authorization', auth)
      .send({ preferences: [{ category: 'MARKETING', emailEnabled: false }] })
      .expect(400);
    await server()
      .put('/notifications/me/preferences')
      .set('Authorization', auth)
      .send({ preferences: [{ category: 'ONBOARDING', emailEnabled: 'no' }] })
      .expect(400);
    await server()
      .put('/notifications/me/preferences')
      .set('Authorization', auth)
      .send({
        preferences: [{ category: 'ONBOARDING', emailEnabled: false }],
        userId: id,
      })
      .expect(400);
    await server()
      .post('/notifications/templates')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        key: 'Not A Key',
        subjectTemplate: 's',
        bodyTemplate: 'b',
      })
      .expect(400);
    await server()
      .post('/notifications/templates')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        key: 'onboarding.tasks-due',
        subjectTemplate: 's',
        bodyTemplate: 'x'.repeat(2001),
      })
      .expect(400);
    await server()
      .patch(`/notifications/templates/${id}`)
      .set('Authorization', auth)
      .send({ mandatory: true })
      .expect(400);
    await server()
      .put('/notifications/settings')
      .set('Authorization', auth)
      .send({ organizationId: 'nope', emailEnabled: false })
      .expect(400);
    await server()
      .put('/notifications/settings')
      .set('Authorization', auth)
      .send({ organizationId: id, emailEnabled: 'off' })
      .expect(400);
    await server()
      .get('/notifications/templates')
      .set('Authorization', auth)
      .expect(400);
  });

  it('serves the caller only their own notifications and refuses administration without grants', async () => {
    const auth = `Bearer ${token}`;
    const server = () => request(app.getHttpServer());
    expect(
      (
        await server()
          .get('/notifications/me')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [], nextCursor: null });
    expect(prisma.notification.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ recipientUserId: 'user-1' }),
      }),
    );
    expect(
      (
        await server()
          .get('/notifications/me/unread-count')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ unread: 0 });
    // Someone else's (or a missing) notification is not found.
    await server()
      .post(`/notifications/me/${id}/read`)
      .set('Authorization', auth)
      .expect(404);
    await server()
      .post(`/notifications/me/${id}/archive`)
      .set('Authorization', auth)
      .expect(404);
    expect(prisma.notification.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id, recipientUserId: 'user-1' },
      }),
    );
    const preferences = (
      await server()
        .get('/notifications/me/preferences')
        .set('Authorization', auth)
        .expect(200)
    ).body;
    expect(preferences.inApp).toBe('ALWAYS');
    expect(
      preferences.items.find(
        (item: { category: string }) => item.category === 'SECURITY',
      ),
    ).toEqual({
      category: 'SECURITY',
      mandatory: true,
      configurable: false,
      emailEnabled: true,
    });
    expect(
      (
        await server()
          .get('/notifications/organizations')
          .set('Authorization', auth)
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    await server()
      .get(`/notifications/templates?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
    await server()
      .get(
        `/notifications/templates/preview?organizationId=${id}&key=onboarding.tasks-due`,
      )
      .set('Authorization', auth)
      .expect(403);
    await server()
      .post('/notifications/templates')
      .set('Authorization', auth)
      .send({
        organizationId: id,
        key: 'onboarding.tasks-due',
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      })
      .expect(403);
    await server()
      .get(`/notifications/settings?organizationId=${id}`)
      .set('Authorization', auth)
      .expect(403);
  });
});
