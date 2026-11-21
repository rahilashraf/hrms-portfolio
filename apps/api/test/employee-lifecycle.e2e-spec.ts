import cookieParser from 'cookie-parser';
import {
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import { domainError } from '../src/common/domain-support.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Batch 5A lifecycle routes: static routes are not captured by ':id', bodies are validated
 * (strict dates, a rehire carries its assignment), and service refusals keep their status and
 * stable code (404 for what the caller cannot see, 403 for incomplete authority or self-target).
 */
describe('Employee lifecycle routes (e2e)', () => {
  let app: INestApplication<App>;
  let auth: string;
  const EMPLOYEE = '00000000-0000-4000-8000-0000000000e1';
  const TERMINATION = '00000000-0000-4000-8000-0000000000f1';
  const ORG = '00000000-0000-4000-8000-0000000000a1';
  const POSITION = '00000000-0000-4000-8000-0000000000b1';
  const lifecycle = {
    terminate: vi.fn(),
    terminations: vi.fn(),
    terminationPreview: vi.fn(),
    cancelTermination: vi.fn(),
    rescheduleTermination: vi.fn(),
    applyTermination: vi.fn(),
    applyAssignmentEnd: vi.fn(),
    rehire: vi.fn(),
    inactivate: vi.fn(),
    reactivate: vi.fn(),
    accessReview: vi.fn(),
    revokeGrants: vi.fn(),
    due: vi.fn(),
  };
  const employees = {
    attachLookup: vi.fn(),
    profile: vi.fn(),
    managerAssignmentOptions: vi.fn(),
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
      .useValue(employees)
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
    for (const fn of [...Object.values(lifecycle), ...Object.values(employees)])
      fn.mockReset().mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', auth).send(body);
  const get = (path: string) => http().get(path).set('Authorization', auth);

  it('Batch 5C: manager options for an existing or a new assignment; one form is required', async () => {
    const path = '/employees/options/manager-assignments';
    expect((await get(path)).status).toBe(400);
    expect((await get(`${path}?positionId=${POSITION}`)).status).toBe(400);
    expect(
      (await get(`${path}?positionId=${POSITION}&startDate=2026-02-30x`))
        .status,
    ).toBe(400);
    expect(
      (await get(`${path}?positionId=not-a-uuid&startDate=2026-12-01`)).status,
    ).toBe(400);
    expect(employees.managerAssignmentOptions).not.toHaveBeenCalled();
    expect(
      (await get(`${path}?subordinateAssignmentId=${TERMINATION}`)).status,
    ).toBe(200);
    expect(
      (
        await get(
          `${path}?positionId=${POSITION}&startDate=2026-12-01&endDate=2027-01-31&employeeId=${EMPLOYEE}&limit=10`,
        )
      ).status,
    ).toBe(200);
    expect(employees.managerAssignmentOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        positionId: POSITION,
        startDate: '2026-12-01',
        endDate: '2027-01-31',
        employeeId: EMPLOYEE,
        limit: 10,
      }),
      'user-1',
    );
  });

  it('requires authentication', async () => {
    await http()
      .post(`/employees/${EMPLOYEE}/terminate`)
      .send({ terminationDate: '2026-11-20' })
      .expect(401);
    expect(lifecycle.terminate).not.toHaveBeenCalled();
  });

  it('routes static lifecycle paths before :id', async () => {
    await get(`/employees/lifecycle/due?organizationId=${ORG}`).expect(200);
    expect(lifecycle.due).toHaveBeenCalledWith('user-1', ORG, undefined, {
      upcomingDays: undefined,
    });
    // R4-A.1: the upcoming window is a whole number of days, 0 to 90.
    await get(
      `/employees/lifecycle/due?organizationId=${ORG}&upcomingDays=14`,
    ).expect(200);
    expect(lifecycle.due).toHaveBeenLastCalledWith('user-1', ORG, undefined, {
      upcomingDays: 14,
    });
    for (const bad of ['-1', '91', '1.5', 'soon'])
      await get(
        `/employees/lifecycle/due?organizationId=${ORG}&upcomingDays=${bad}`,
      ).expect(400);
    await get(
      `/employees/attach-lookup?organizationId=${ORG}&employeeNumber=EMP-000001`,
    ).expect(200);
    expect(employees.attachLookup).toHaveBeenCalledWith(
      ORG,
      'EMP-000001',
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
    expect(employees.profile).not.toHaveBeenCalled();
    await get('/employees/lifecycle/due').expect(400);
  });

  it('validates termination bodies strictly', async () => {
    for (const terminationDate of [
      '2026-11-20T00:00:00Z',
      '20261120',
      undefined,
    ]) {
      await post(`/employees/${EMPLOYEE}/terminate`, {
        terminationDate,
      }).expect(400);
    }
    await post(`/employees/${EMPLOYEE}/terminate`, {
      terminationDate: '2026-11-20',
      unknown: true,
    }).expect(400);
    expect(lifecycle.terminate).not.toHaveBeenCalled();
    await post(`/employees/${EMPLOYEE}/terminate`, {
      terminationDate: '2026-11-20',
      reason: 'Restructuring',
      acknowledgeSystemGrants: true,
    }).expect(201);
    expect(lifecycle.terminate).toHaveBeenCalledWith(
      EMPLOYEE,
      {
        terminationDate: '2026-11-20',
        reason: 'Restructuring',
        acknowledgeSystemGrants: true,
      },
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
  });

  it('wires cancel, reschedule, apply, preview and history', async () => {
    const base = `/employees/${EMPLOYEE}/terminations/${TERMINATION}`;
    await post(`${base}/cancel`, { reason: 'Withdrawn' }).expect(201);
    await post(`${base}/reschedule`, { terminationDate: '2026-11-25' }).expect(
      201,
    );
    await post(`${base}/reschedule`, {}).expect(400);
    await post(`${base}/apply`).expect(201);
    await get(
      `/employees/${EMPLOYEE}/termination-preview?terminationDate=2026-11-20`,
    ).expect(200);
    await get(
      `/employees/${EMPLOYEE}/termination-preview?terminationDate=soon`,
    ).expect(400);
    await get(`/employees/${EMPLOYEE}/terminations`).expect(200);
    expect(lifecycle.cancelTermination).toHaveBeenCalledWith(
      EMPLOYEE,
      TERMINATION,
      { reason: 'Withdrawn' },
      expect.anything(),
    );
    expect(lifecycle.rescheduleTermination).toHaveBeenCalledTimes(1);
    expect(lifecycle.applyTermination).toHaveBeenCalledTimes(1);
    expect(lifecycle.terminationPreview).toHaveBeenCalledWith(
      EMPLOYEE,
      '2026-11-20',
      'user-1',
    );
  });

  it('requires the new assignment on rehire (the old date-only body is refused)', async () => {
    await post(`/employees/${EMPLOYEE}/rehire`, {
      hireDate: '2027-01-15',
    }).expect(400);
    await post(`/employees/${EMPLOYEE}/rehire`, {
      assignment: {
        positionId: POSITION,
        employmentType: 'FULL_TIME',
        startDate: '2027-01-15T00:00Z',
      },
    }).expect(400);
    expect(lifecycle.rehire).not.toHaveBeenCalled();
    await post(`/employees/${EMPLOYEE}/rehire`, {
      assignment: {
        positionId: POSITION,
        employmentType: 'FULL_TIME',
        startDate: '2027-01-15',
      },
    }).expect(201);
    expect(lifecycle.rehire).toHaveBeenCalledTimes(1);
  });

  it('requires a reason to inactivate and ids to revoke grants', async () => {
    await post(`/employees/${EMPLOYEE}/inactivate`, {}).expect(400);
    await post(`/employees/${EMPLOYEE}/inactivate`, {
      reason: 'Leave of absence',
    }).expect(201);
    await post(`/employees/${EMPLOYEE}/reactivate`, {}).expect(201);
    await post(`/employees/${EMPLOYEE}/access-review/revoke-grants`, {
      roleAssignmentIds: [],
    }).expect(400);
    await post(`/employees/${EMPLOYEE}/access-review/revoke-grants`, {
      roleAssignmentIds: ['not-a-uuid'],
    }).expect(400);
    await post(`/employees/${EMPLOYEE}/access-review/revoke-grants`, {
      roleAssignmentIds: [TERMINATION],
    }).expect(201);
    await get(`/employees/${EMPLOYEE}/access-review`).expect(200);
  });

  it('keeps refusal statuses and stable codes', async () => {
    lifecycle.terminate.mockRejectedValueOnce(
      new NotFoundException('Employee not found.'),
    );
    await post(`/employees/${EMPLOYEE}/terminate`, {
      terminationDate: '2026-11-20',
    }).expect(404);
    lifecycle.terminate.mockRejectedValueOnce(
      new ForbiddenException(
        domainError(403, 'LIFECYCLE_SCOPE_INCOMPLETE', 'Incomplete authority.'),
      ),
    );
    const scope = await post(`/employees/${EMPLOYEE}/terminate`, {
      terminationDate: '2026-11-20',
    }).expect(403);
    expect(scope.body.code).toBe('LIFECYCLE_SCOPE_INCOMPLETE');
    lifecycle.inactivate.mockRejectedValueOnce(
      new ForbiddenException(
        domainError(403, 'LIFECYCLE_SELF_TARGET', 'Not your own employment.'),
      ),
    );
    const self = await post(`/employees/${EMPLOYEE}/inactivate`, {
      reason: 'x',
    }).expect(403);
    expect(self.body.code).toBe('LIFECYCLE_SELF_TARGET');
  });
});
