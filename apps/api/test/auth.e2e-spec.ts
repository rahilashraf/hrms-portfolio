import cookieParser from 'cookie-parser';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AccountSessionsService } from '../src/auth/account-sessions.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { OrganizationService } from '../src/organization/organization.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';

describe('AuthController (e2e)', () => {
  let app: INestApplication<App>;
  const auth = {
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    me: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
    acceptInvitation: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    changePassword: vi.fn(),
  };
  const accountSessions = {
    list: vi.fn(),
    revoke: vi.fn(),
    revokeOthers: vi.fn(),
  };
  const sessions = {
    findActiveByIdAndUser: vi.fn().mockResolvedValue({ id: 'session-1' }),
  };
  const organization = {
    listOrganizations: vi.fn().mockResolvedValue([]),
    listOrganizationalUnits: vi.fn().mockResolvedValue([]),
    listDepartments: vi.fn().mockResolvedValue([]),
    getOrganization: vi.fn().mockResolvedValue({ id: 'org-1' }),
    updateOrganization: vi.fn().mockResolvedValue({ id: 'org-1' }),
    getOrganizationalUnit: vi.fn().mockResolvedValue({ id: 'unit-1' }),
    updateOrganizationalUnit: vi.fn().mockResolvedValue({ id: 'unit-1' }),
    getDepartment: vi.fn().mockResolvedValue({ id: 'department-1' }),
    updateDepartment: vi.fn().mockResolvedValue({ id: 'department-1' }),
    getTeam: vi.fn().mockResolvedValue({ id: 'team-1' }),
    updateTeam: vi.fn().mockResolvedValue({ id: 'team-1' }),
    getJobTitle: vi.fn().mockResolvedValue({ id: 'job-title-1' }),
    updateJobTitle: vi.fn().mockResolvedValue({ id: 'job-title-1' }),
    getPosition: vi.fn().mockResolvedValue({ id: 'position-1' }),
    updatePosition: vi.fn().mockResolvedValue({ id: 'position-1' }),
    getWorkLocation: vi.fn().mockResolvedValue({ id: 'work-location-1' }),
    updateWorkLocation: vi.fn().mockResolvedValue({ id: 'work-location-1' }),
    getStructure: vi.fn().mockResolvedValue([]),
  };
  const grants = new Set<string>();
  const grantKey = (permission: string, type: string, id?: string) =>
    `${permission}:${type}:${id ?? ''}`;
  const hasGrant = (permission: string, scope: { type: string; id?: string }) =>
    grants.has(grantKey(permission, scope.type, scope.id));
  const authorization = {
    getCurrentGrantSnapshot: vi.fn().mockResolvedValue({
      userId: 'user-1',
      permissions: [],
    }),
    assertAccess: vi.fn(
      async (
        userId: string,
        permission: string,
        scope: { type: string; id?: string },
      ) => {
        if (!hasGrant(permission, scope)) throw new ForbiddenException();
      },
    ),
    canAccess: vi.fn(
      async (
        _userId: string,
        permission: string,
        scope: { type: string; id?: string },
      ) => hasGrant(permission, scope),
    ),
  };
  const prisma = {
    organization: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
    organizationalUnit: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
    department: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
    team: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
    jobTitle: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
    position: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        teamId: null,
        departmentId: null,
        organizationalUnitId: null,
      })),
    },
    workLocation: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
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
      .overrideProvider(AuthService)
      .useValue(auth)
      .overrideProvider(AccountSessionsService)
      .useValue(accountSessions)
      .overrideProvider(SessionsService)
      .useValue(sessions)
      .overrideProvider(OrganizationService)
      .useValue(organization)
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sessions.findActiveByIdAndUser.mockResolvedValue({ id: 'session-1' });
    organization.listOrganizations.mockResolvedValue([]);
    organization.listOrganizationalUnits.mockResolvedValue([]);
    grants.clear();
    vi.mocked(authorization.assertAccess).mockClear();
    vi.mocked(authorization.canAccess).mockClear();
  });

  it('logs in, sets the refresh cookie, and returns the access token', async () => {
    auth.login.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'opaque-refresh-token',
      identity: { id: 'user-1', mustChangePassword: true },
    });

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'person@example.com', password: 'secret' })
      .expect(201);

    expect(response.body).toEqual({
      accessToken: 'access-token',
      identity: { id: 'user-1', mustChangePassword: true },
    });
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][0]).toContain('Path=/auth');
    expect(response.body).not.toHaveProperty('refreshToken');
  });

  it('validates login DTOs and rejects mismatched browser origins', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', 'https://attacker.example')
      .send({ email: 'person@example.com', password: 'secret' })
      .expect(403);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('bounds credential inputs well above the password policy (Batch 2)', async () => {
    const long = 'x'.repeat(1025);
    for (const [path, body] of [
      ['/auth/login', { email: 'person@example.com', password: long }],
      ['/auth/reset-password', { token: 't', newPassword: long }],
      ['/auth/accept-invitation', { token: 'x'.repeat(513), password: 'p' }],
      ['/auth/verify-email', { token: 'x'.repeat(513) }],
    ] as const) {
      await request(app.getHttpServer())
        .post(path)
        .set('Origin', 'http://localhost:3000')
        .send(body)
        .expect(400);
    }
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.resetPassword).not.toHaveBeenCalled();
    expect(auth.acceptInvitation).not.toHaveBeenCalled();
    expect(auth.verifyEmail).not.toHaveBeenCalled();
  });

  it('changes the password for the signed-in session only, also while a change is required (Batch 2)', async () => {
    const token = await app.get(AccessTokenService).issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    auth.changePassword.mockResolvedValue({
      success: true,
      revokedSessionCount: 2,
    });
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .send({ currentPassword: 'a', newPassword: 'b' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'Another-Long-Passphrase-7' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'a', newPassword: 'b', userId: 'someone-else' })
      .expect(400);
    expect(auth.changePassword).not.toHaveBeenCalled();

    sessions.findActiveByIdAndUser.mockResolvedValue({
      id: 'session-1',
      mustChangePassword: true,
    });
    const response = await request(app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'Correct-Horse-Battery-42!',
        newPassword: 'Another-Long-Passphrase-7',
      })
      .expect(200);
    expect(response.body).toEqual({ success: true, revokedSessionCount: 2 });
    expect(auth.changePassword).toHaveBeenCalledWith(
      { userId: 'user-1', sessionId: 'session-1' },
      'Correct-Horse-Battery-42!',
      'Another-Long-Passphrase-7',
      expect.objectContaining({}),
    );
    // Anything else answers 403 until the password is changed.
    const blocked = await request(app.getHttpServer())
      .get('/organizations')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(blocked.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('serves the signed-in user their own sessions (Batch 2)', async () => {
    const token = await app.get(AccessTokenService).issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    const identity = { userId: 'user-1', sessionId: 'session-1' };
    accountSessions.list.mockResolvedValue({ items: [] });
    accountSessions.revoke.mockResolvedValue({ success: true });
    accountSessions.revokeOthers.mockResolvedValue({
      success: true,
      revokedSessionCount: 0,
    });
    await request(app.getHttpServer()).get('/auth/sessions').expect(401);
    await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { items: [] });
    expect(accountSessions.list).toHaveBeenCalledWith(identity);
    await request(app.getHttpServer())
      .delete('/auth/sessions/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    const other = '00000000-0000-4000-8000-000000000009';
    await request(app.getHttpServer())
      .delete(`/auth/sessions/${other}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(accountSessions.revoke).toHaveBeenCalledWith(
      identity,
      other,
      expect.objectContaining({}),
    );
    await request(app.getHttpServer())
      .post('/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'https://attacker.example')
      .expect(403);
    await request(app.getHttpServer())
      .post('/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'http://localhost:3000')
      .expect(200);
    expect(accountSessions.revokeOthers).toHaveBeenCalledTimes(1);
  });

  it('refreshes without replacing the cookie when service returns no new token', async () => {
    auth.refresh.mockResolvedValue({ accessToken: 'new-access-token' });

    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', 'hrms_refresh=old-refresh')
      .expect(201);

    expect(response.body).toEqual({ accessToken: 'new-access-token' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(auth.refresh).toHaveBeenCalledWith(
      'old-refresh',
      expect.objectContaining({ ipAddress: expect.any(String) }),
    );
  });

  it('logs out and clears the refresh cookie', async () => {
    auth.logout.mockResolvedValue(undefined);

    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', 'hrms_refresh=old-refresh')
      .expect(201);

    expect(response.body).toEqual({ success: true });
    expect(response.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
  });

  it('protects /auth/me and provides identity without exposing internal fields', async () => {
    const tokens = app.get(AccessTokenService);
    const token = await tokens.issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    auth.me.mockResolvedValue({
      id: 'user-1',
      personId: 'person-1',
      email: 'person@example.com',
      status: 'ACTIVE',
      emailVerifiedAt: null,
      mustChangePassword: false,
    });

    await request(app.getHttpServer()).get('/auth/me').expect(401);
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      id: 'user-1',
      personId: 'person-1',
      email: 'person@example.com',
      status: 'ACTIVE',
      emailVerifiedAt: null,
      mustChangePassword: false,
    });
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(sessions.findActiveByIdAndUser).toHaveBeenCalled();
  });

  it('requires authentication for logout-all and clears cookies on success', async () => {
    auth.logoutAll.mockResolvedValue(undefined);
    await request(app.getHttpServer()).post('/auth/logout-all').expect(401);
    const token = await app.get(AccessTokenService).issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });

    const response = await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'http://localhost:3000')
      .expect(201);

    expect(auth.logoutAll).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({}),
    );
    expect(response.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
  });

  it('requires Phase 2 authentication for Phase 3 organization routes', async () => {
    const organizationId = '00000000-0000-0000-0000-000000000001';
    const entityId = '00000000-0000-0000-0000-000000000002';
    const routes: Array<{
      method: 'get' | 'post' | 'patch';
      path: string;
    }> = [
      { method: 'post', path: '/organizations' },
      { method: 'get', path: '/organizations' },
      { method: 'get', path: `/organizations/${entityId}` },
      { method: 'patch', path: `/organizations/${entityId}` },
      { method: 'post', path: `/organizations/${entityId}/archive` },
      { method: 'post', path: `/organizations/${entityId}/reactivate` },
      {
        method: 'get',
        path: `/organizations/${organizationId}/structure`,
      },
    ];

    for (const resource of [
      'units',
      'departments',
      'teams',
      'job-titles',
      'positions',
      'work-locations',
    ]) {
      const collectionPath = `/organizations/${organizationId}/${resource}`;
      const entityPath = `${collectionPath}/${entityId}`;
      routes.push(
        { method: 'post', path: collectionPath },
        { method: 'get', path: collectionPath },
        { method: 'get', path: entityPath },
        { method: 'patch', path: entityPath },
        { method: 'post', path: `${entityPath}/archive` },
        { method: 'post', path: `${entityPath}/reactivate` },
      );
    }

    for (const route of routes) {
      const testRequest = request(app.getHttpServer());
      const response =
        route.method === 'get'
          ? await testRequest.get(route.path)
          : route.method === 'post'
            ? await testRequest.post(route.path).send({})
            : await testRequest.patch(route.path).send({});
      expect(
        response.status,
        `${route.method.toUpperCase()} ${route.path}`,
      ).toBe(401);
    }
  });

  it('protects every authorization administration route with Phase 2 authentication', async () => {
    const organizationId = '00000000-0000-0000-0000-000000000001';
    const roleId = '00000000-0000-0000-0000-000000000002';
    const assignmentId = '00000000-0000-0000-0000-000000000003';
    const routes: Array<{
      method: 'get' | 'post' | 'patch' | 'put';
      path: string;
    }> = [
      { method: 'get', path: '/auth/me/authorization' },
      {
        method: 'get',
        path: `/authorization/permissions?organizationId=${organizationId}`,
      },
      {
        method: 'get',
        path: `/authorization/users?organizationId=${organizationId}`,
      },
      {
        method: 'get',
        path: `/authorization/organizations/${organizationId}/roles`,
      },
      {
        method: 'post',
        path: `/authorization/organizations/${organizationId}/roles`,
      },
      { method: 'get', path: `/authorization/roles/${roleId}` },
      { method: 'patch', path: `/authorization/roles/${roleId}` },
      {
        method: 'put',
        path: `/authorization/roles/${roleId}/permissions`,
      },
      { method: 'post', path: `/authorization/roles/${roleId}/archive` },
      { method: 'post', path: `/authorization/roles/${roleId}/reactivate` },
      {
        method: 'get',
        path: `/authorization/roles/${roleId}/assignments`,
      },
      { method: 'get', path: `/authorization/assignments/${assignmentId}` },
      { method: 'post', path: '/authorization/assignments' },
      {
        method: 'post',
        path: `/authorization/assignments/${assignmentId}/revoke`,
      },
    ];

    for (const route of routes) {
      const testRequest = request(app.getHttpServer());
      const response =
        route.method === 'get'
          ? await testRequest.get(route.path)
          : route.method === 'post'
            ? await testRequest.post(route.path).send({})
            : route.method === 'put'
              ? await testRequest.put(route.path).send({})
              : await testRequest.patch(route.path).send({});
      expect(
        response.status,
        `${route.method.toUpperCase()} ${route.path}`,
      ).toBe(401);
    }
  });

  it('defaults includeArchived to false and supports includeArchived=true', async () => {
    const token = await app.get(AccessTokenService).issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    const authorization = `Bearer ${token}`;

    await request(app.getHttpServer())
      .get('/organizations')
      .set('Authorization', authorization)
      .expect(200);
    expect(organization.listOrganizations).toHaveBeenCalledWith(false);

    await request(app.getHttpServer())
      .get(
        '/organizations/00000000-0000-0000-0000-000000000001/units?includeArchived=true',
      )
      .set('Authorization', authorization)
      .expect(200);
    expect(organization.listOrganizationalUnits).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      true,
    );
  });

  it('enforces scoped authorization across Phase 3 resources and filters responses', async () => {
    const organizationId = '00000000-0000-0000-0000-000000000001';
    const token = await app.get(AccessTokenService).issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    const authHeader = `Bearer ${token}`;
    const resourceCases = [
      {
        path: `/organizations/${organizationId}`,
        scope: { type: 'ORGANIZATION', id: organizationId },
      },
      {
        path: `/organizations/${organizationId}/units/00000000-0000-0000-0000-000000000002`,
        scope: {
          type: 'ORGANIZATIONAL_UNIT',
          id: '00000000-0000-0000-0000-000000000002',
        },
      },
      {
        path: `/organizations/${organizationId}/departments/00000000-0000-0000-0000-000000000003`,
        scope: {
          type: 'DEPARTMENT',
          id: '00000000-0000-0000-0000-000000000003',
        },
      },
      {
        path: `/organizations/${organizationId}/teams/00000000-0000-0000-0000-000000000004`,
        scope: { type: 'TEAM', id: '00000000-0000-0000-0000-000000000004' },
      },
      {
        path: `/organizations/${organizationId}/job-titles/00000000-0000-0000-0000-000000000005`,
        scope: { type: 'ORGANIZATION', id: organizationId },
      },
      {
        path: `/organizations/${organizationId}/positions/00000000-0000-0000-0000-000000000006`,
        scope: { type: 'ORGANIZATION', id: organizationId },
      },
      {
        path: `/organizations/${organizationId}/work-locations/00000000-0000-0000-0000-000000000007`,
        scope: { type: 'ORGANIZATION', id: organizationId },
      },
    ];

    for (const { path, scope } of resourceCases) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', authHeader)
        .expect(403);

      grants.add(grantKey('organization.read', scope.type, scope.id));
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', authHeader)
        .expect(200);

      await request(app.getHttpServer())
        .patch(path)
        .set('Authorization', authHeader)
        .send({ name: 'Updated' })
        .expect(403);

      grants.add(grantKey('organization.manage', scope.type, scope.id));
      await request(app.getHttpServer())
        .patch(path)
        .set('Authorization', authHeader)
        .send({ name: 'Updated' })
        .expect(200);
      grants.clear();
    }

    const department1 = '00000000-0000-0000-0000-000000000008';
    const department2 = '00000000-0000-0000-0000-000000000009';
    organization.listDepartments.mockResolvedValue([
      { id: department1, organizationId },
      { id: department2, organizationId },
    ]);
    grants.add(grantKey('organization.read', 'DEPARTMENT', department1));
    const listResponse = await request(app.getHttpServer())
      .get(`/organizations/${organizationId}/departments`)
      .set('Authorization', authHeader)
      .expect(200);
    expect(listResponse.body).toEqual([{ id: department1, organizationId }]);
    await request(app.getHttpServer())
      .get(`/organizations/${organizationId}/departments/${department2}`)
      .set('Authorization', authHeader)
      .expect(403);

    const parent = '00000000-0000-0000-0000-000000000010';
    const child = '00000000-0000-0000-0000-000000000011';
    organization.getStructure.mockResolvedValue([
      {
        id: parent,
        name: 'Hidden parent',
        children: [{ id: child, name: 'Visible child', children: [] }],
      },
    ]);
    grants.clear();
    grants.add(grantKey('organization.read', 'ORGANIZATIONAL_UNIT', child));
    const structureResponse = await request(app.getHttpServer())
      .get(`/organizations/${organizationId}/structure`)
      .set('Authorization', authHeader)
      .expect(200);
    expect(structureResponse.body).toEqual([
      { id: child, name: 'Visible child', children: [] },
    ]);

    const teamId = '00000000-0000-0000-0000-000000000012';
    const destinationDepartment = '00000000-0000-0000-0000-000000000014';
    grants.clear();
    grants.add(grantKey('organization.manage', 'TEAM', teamId));
    const movePath = `/organizations/${organizationId}/teams/${teamId}`;
    const moveBody = {
      departmentId: destinationDepartment,
      organizationalUnitId: null,
    };
    await request(app.getHttpServer())
      .patch(movePath)
      .set('Authorization', authHeader)
      .send(moveBody)
      .expect(403);

    grants.add(
      grantKey('organization.manage', 'DEPARTMENT', destinationDepartment),
    );
    await request(app.getHttpServer())
      .patch(movePath)
      .set('Authorization', authHeader)
      .send(moveBody)
      .expect(200);
  });

  it('exposes only the canonical authorization snapshot endpoint', async () => {
    const token = await app.get(AccessTokenService).issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    await request(app.getHttpServer())
      .get('/auth/me/authorization')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect({ userId: 'user-1', permissions: [] });
    await request(app.getHttpServer())
      .get('/authorization/grants/current')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('serves password recovery endpoints without exposing request identity', async () => {
    auth.forgotPassword.mockResolvedValue({
      message:
        'If the account is eligible, recovery instructions will be sent.',
    });
    auth.resetPassword.mockResolvedValue({ success: true });

    const forgot = await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'person@example.com' })
      .expect(201);
    expect(forgot.body).toEqual({
      message:
        'If the account is eligible, recovery instructions will be sent.',
    });

    const reset = await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'opaque-token', newPassword: 'a secure passphrase' })
      .expect(201);
    expect(reset.body).toEqual({ success: true });
    expect(auth.resetPassword).toHaveBeenCalledWith(
      'opaque-token',
      'a secure passphrase',
      expect.any(Object),
    );
  });

  it('serves invitation and verification endpoints', async () => {
    auth.acceptInvitation.mockResolvedValue({ success: true });
    auth.verifyEmail.mockResolvedValue({ success: true });
    auth.resendVerification.mockResolvedValue({
      message:
        'If the account requires verification, instructions will be sent.',
    });

    await request(app.getHttpServer())
      .post('/auth/accept-invitation')
      .send({ token: 'invite-token', password: 'a secure passphrase' })
      .expect(201)
      .expect({ success: true });

    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: 'verification-token' })
      .expect(201)
      .expect({ success: true });

    await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ email: 'person@example.com' })
      .expect(201)
      .expect({
        message:
          'If the account requires verification, instructions will be sent.',
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
