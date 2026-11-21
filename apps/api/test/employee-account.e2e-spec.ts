import cookieParser from 'cookie-parser';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { accountOutsideScope } from '../src/employee/employee-account-policy.js';
import { EmployeeAccountService } from '../src/employee/employee-account.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Security remediation M1 — the login-access routes: every action keeps its method and path,
 * a policy refusal reaches the client as 403 ACCOUNT_OUTSIDE_SCOPE with a safe reason and
 * nothing else, and the capability flags pass through unchanged.
 */
describe('Employee login-access routes (e2e)', () => {
  let app: INestApplication<App>;
  let auth: string;
  const EMPLOYEE = '00000000-0000-4000-8000-0000000000e1';
  const accounts = {
    account: vi.fn(),
    invite: vi.fn(),
    resend: vi.fn(),
    cancel: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    requirePasswordChange: vi.fn(),
    signOut: vi.fn(),
    sendPasswordReset: vi.fn(),
    unlock: vi.fn(),
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
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ client: { eval: vi.fn().mockResolvedValue(1) } })
      .overrideProvider(SessionsService)
      .useValue({
        findActiveByIdAndUser: vi.fn().mockResolvedValue({ id: 'session-1' }),
      })
      .overrideProvider(AuthorizationService)
      .useValue({
        can: vi.fn(async () => true),
        effectiveGrants: vi.fn(async () => []),
        getCurrentGrantSnapshot: vi.fn(async () => ({
          userId: 'user-1',
          permissions: [],
        })),
      })
      .overrideProvider(EmployeeAccountService)
      .useValue(accounts)
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
    auth = `Bearer ${await app
      .get(AccessTokenService)
      .issue({ userId: 'user-1', sessionId: 'session-1' })}`;
  });

  beforeEach(() => {
    for (const fn of Object.values(accounts))
      fn.mockReset().mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', auth).send(body);

  const ROUTES: Array<[keyof typeof accounts, string, object?]> = [
    ['invite', 'invitation', {}],
    ['resend', 'invitation/resend', {}],
    ['cancel', 'invitation/cancel'],
    ['disable', 'disable', { reason: 'Left the company' }],
    ['enable', 'enable'],
    ['requirePasswordChange', 'require-password-change', { signOut: true }],
    ['signOut', 'sessions/revoke'],
    ['sendPasswordReset', 'password-reset'],
    ['unlock', 'unlock'],
  ];

  it('keeps every action on its route', async () => {
    for (const [method, path, body] of ROUTES) {
      await post(`/employees/${EMPLOYEE}/account/${path}`, body ?? {}).expect(
        200,
      );
      expect(accounts[method]).toHaveBeenCalledTimes(1);
      expect(accounts[method].mock.calls[0]![0]).toBe(EMPLOYEE);
    }
  });

  it('returns a policy refusal as 403 ACCOUNT_OUTSIDE_SCOPE with only a safe reason', async () => {
    for (const [method, path, body] of ROUTES) {
      for (const reason of [
        'ACCESS_OUTSIDE_SCOPE',
        'NO_CURRENT_ASSIGNMENT',
        'PROTECTIVE_WINDOW_ENDED',
      ] as const) {
        accounts[method]
          .mockReset()
          .mockRejectedValue(accountOutsideScope(reason));
        const response = await post(
          `/employees/${EMPLOYEE}/account/${path}`,
          body ?? {},
        ).expect(403);
        expect(Object.keys(response.body).sort()).toEqual([
          'code',
          'error',
          'message',
          'reason',
          'statusCode',
        ]);
        expect(response.body).toMatchObject({
          statusCode: 403,
          code: 'ACCOUNT_OUTSIDE_SCOPE',
          reason,
        });
      }
    }
  });

  it('keeps the earlier refusals unchanged (no new code for permission, self or System Owner)', async () => {
    accounts.disable.mockRejectedValue(
      new ForbiddenException('You cannot manage your own login access.'),
    );
    const response = await post(
      `/employees/${EMPLOYEE}/account/disable`,
    ).expect(403);
    expect(response.body.code).toBeUndefined();
  });

  it('passes the capability flags through', async () => {
    const capabilities = {
      disable: { allowed: false, reason: 'ACCESS_OUTSIDE_SCOPE' },
      enable: { allowed: false, reason: null },
    };
    accounts.account.mockResolvedValue({
      status: 'ACTIVE',
      actions: { disable: false, enable: false },
      capabilities,
    });
    const response = await http()
      .get(`/employees/${EMPLOYEE}/account`)
      .set('Authorization', auth)
      .expect(200);
    expect(response.body.capabilities).toEqual(capabilities);
  });

  it('requires authentication and a valid employee id', async () => {
    await http().post(`/employees/${EMPLOYEE}/account/enable`).expect(401);
    await post('/employees/not-a-uuid/account/enable').expect(400);
    expect(accounts.enable).not.toHaveBeenCalled();
  });
});
