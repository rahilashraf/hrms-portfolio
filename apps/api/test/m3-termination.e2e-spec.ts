import cookieParser from 'cookie-parser';
import { ConflictException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { domainError } from '../src/common/domain-support.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Security remediation M3 — termination grant routes: the grant decisions on terminate and
 * reschedule, listing, recording decisions, and approving, rejecting or withdrawing a keep.
 * Bodies are validated before the service is reached; service refusals keep their status and
 * stable code.
 */
describe('Termination grant routes (e2e)', () => {
  let app: INestApplication<App>;
  let auth: string;
  const EMPLOYEE = '00000000-0000-4000-8000-0000000000e1';
  const TERMINATION = '00000000-0000-4000-8000-0000000000f1';
  const DECISION = '00000000-0000-4000-8000-0000000000d1';
  const GRANT = '00000000-0000-4000-8000-0000000000c1';
  const lifecycle = {
    terminate: vi.fn(),
    rescheduleTermination: vi.fn(),
    terminationGrants: vi.fn(),
    recordGrantDecisions: vi.fn(),
    approveGrantKeep: vi.fn(),
    rejectGrantKeep: vi.fn(),
    cancelGrantKeep: vi.fn(),
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
      .overrideProvider(EmployeeLifecycleService)
      .useValue(lifecycle)
      .overrideProvider(EmployeeService)
      .useValue({})
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
    for (const fn of Object.values(lifecycle))
      fn.mockReset().mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', auth).send(body);
  const base = `/employees/${EMPLOYEE}/terminations/${TERMINATION}`;
  const keep = {
    roleAssignmentId: GRANT,
    decision: 'KEEP',
    reason: 'Handover of the payroll provider integration',
    keepUntil: '2026-12-01T12:00:00.000Z',
  };

  it('accepts grant decisions on terminate and reschedule, and validates them', async () => {
    await post(`/employees/${EMPLOYEE}/terminate`, {
      terminationDate: '2026-11-20',
      grantDecisions: [keep, { roleAssignmentId: GRANT, decision: 'REVOKE' }],
    }).expect(201);
    expect(lifecycle.terminate).toHaveBeenCalledWith(
      EMPLOYEE,
      expect.objectContaining({
        grantDecisions: [
          expect.objectContaining({
            decision: 'KEEP',
            keepUntil: keep.keepUntil,
          }),
          expect.objectContaining({ decision: 'REVOKE' }),
        ],
      }),
      expect.anything(),
    );
    await post(`${base}/reschedule`, {
      terminationDate: '2026-11-21',
      grantDecisions: [keep],
    }).expect(201);
    expect(lifecycle.rescheduleTermination).toHaveBeenCalledTimes(1);
    for (const bad of [
      { ...keep, decision: 'MAYBE' },
      { ...keep, roleAssignmentId: 'not-a-uuid' },
      { ...keep, keepUntil: 'tomorrow' },
      { ...keep, reason: 'x'.repeat(501) },
      { ...keep, extra: true },
    ]) {
      await post(`/employees/${EMPLOYEE}/terminate`, {
        terminationDate: '2026-11-20',
        grantDecisions: [bad],
      }).expect(400);
    }
    await post(`/employees/${EMPLOYEE}/terminate`, {
      terminationDate: '2026-11-20',
      grantDecisions: Array.from({ length: 101 }, () => keep),
    }).expect(400);
    expect(lifecycle.terminate).toHaveBeenCalledTimes(1);
  });

  it('routes listing, recording, approving, rejecting and withdrawing', async () => {
    await http().get(`${base}/grants`).set('Authorization', auth).expect(200);
    expect(lifecycle.terminationGrants).toHaveBeenCalledWith(
      EMPLOYEE,
      TERMINATION,
      'user-1',
    );
    await post(`${base}/grant-decisions`, { decisions: [keep] }).expect(200);
    expect(lifecycle.recordGrantDecisions).toHaveBeenCalledWith(
      EMPLOYEE,
      TERMINATION,
      { decisions: [expect.objectContaining({ decision: 'KEEP' })] },
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
    await post(`${base}/grant-decisions/${DECISION}/approve`, {
      note: 'Agreed',
    }).expect(200);
    expect(lifecycle.approveGrantKeep).toHaveBeenCalledWith(
      EMPLOYEE,
      TERMINATION,
      DECISION,
      { note: 'Agreed' },
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
    await post(`${base}/grant-decisions/${DECISION}/reject`, {}).expect(200);
    await post(`${base}/grant-decisions/${DECISION}/cancel`).expect(200);
    expect(lifecycle.rejectGrantKeep).toHaveBeenCalledTimes(1);
    expect(lifecycle.cancelGrantKeep).toHaveBeenCalledTimes(1);
    await post(`${base}/grant-decisions`, { decisions: [] }).expect(400);
    await post(`${base}/grant-decisions/not-a-uuid/approve`).expect(400);
    await http()
      .get(`/employees/${EMPLOYEE}/terminations/not-a-uuid/grants`)
      .set('Authorization', auth)
      .expect(400);
    await post(
      `/employees/not-a-uuid/terminations/${TERMINATION}/grant-decisions`,
      {
        decisions: [keep],
      },
    ).expect(400);
    await post(`${base}/grant-decisions/${DECISION}/approve`, {
      note: 'x'.repeat(501),
    }).expect(400);
  });

  it('keeps the status and stable code of each refusal', async () => {
    for (const [code, status] of [
      ['TERMINATION_GRANT_DECISION_REQUIRED', 409],
      ['TERMINATION_KEEP_APPROVAL_REQUIRED', 409],
      ['TERMINATION_KEEP_EXPIRED', 409],
    ] as const) {
      lifecycle.approveGrantKeep.mockRejectedValueOnce(
        new ConflictException(domainError(status, code, 'Refused.')),
      );
      const response = await post(
        `${base}/grant-decisions/${DECISION}/approve`,
      ).expect(status);
      expect(response.body.code).toBe(code);
    }
  });

  it('requires authentication', async () => {
    await http().get(`${base}/grants`).expect(401);
    await http()
      .post(`${base}/grant-decisions/${DECISION}/approve`)
      .expect(401);
    expect(lifecycle.terminationGrants).not.toHaveBeenCalled();
  });
});
