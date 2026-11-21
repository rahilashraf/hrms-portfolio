import cookieParser from 'cookie-parser';
import {
  ConflictException,
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
import { domainError } from '../src/common/domain-support.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAssignmentOperationsService } from '../src/employee/employee-assignment-operations.service.js';
import { PhysicalSiteService } from '../src/organization/physical-site.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Batch 5B routes: transfer and assignment impact, and organization physical sites. Bodies are
 * validated (strict dates, UUIDs, nullable manager), service refusals keep their status and
 * stable code, and the physical-site routes sit beside the organization routes without being
 * captured by them.
 */
describe('Batch 5B routes (e2e)', () => {
  let app: INestApplication<App>;
  let auth: string;
  const EMPLOYEE = '00000000-0000-4000-8000-0000000000e1';
  const ASSIGNMENT = '00000000-0000-4000-8000-0000000000a1';
  const POSITION = '00000000-0000-4000-8000-0000000000b1';
  const ORG = '00000000-0000-4000-8000-0000000000c1';
  const SITE = '00000000-0000-4000-8000-0000000000d1';
  const operations = { transfer: vi.fn(), impact: vi.fn() };
  const sites = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    reactivate: vi.fn(),
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
      .overrideProvider(EmployeeAssignmentOperationsService)
      .useValue(operations)
      .overrideProvider(PhysicalSiteService)
      .useValue(sites)
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
    for (const fn of [...Object.values(operations), ...Object.values(sites)])
      fn.mockReset().mockResolvedValue({ ok: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', auth).send(body);
  const patch = (path: string, body: object = {}) =>
    http().patch(path).set('Authorization', auth).send(body);
  const get = (path: string) => http().get(path).set('Authorization', auth);
  const transferPath = `/employees/${EMPLOYEE}/assignments/${ASSIGNMENT}/transfer`;

  it('requires authentication', async () => {
    await http().post(transferPath).send({}).expect(401);
    await http().get(`/organizations/${ORG}/physical-sites`).expect(401);
    await http()
      .get(`/organizations/${ORG}/position-reference-options`)
      .expect(401);
  });

  it('validates the position reference options organization id', async () => {
    await get(`/organizations/not-a-uuid/position-reference-options`).expect(
      400,
    );
  });

  it('validates transfer bodies strictly and passes them through', async () => {
    for (const body of [
      {},
      { positionId: POSITION },
      { positionId: 'nope', effectiveDate: '2026-12-01' },
      { positionId: POSITION, effectiveDate: '2026-12-01T00:00:00Z' },
      {
        positionId: POSITION,
        effectiveDate: '2026-12-01',
        managerAssignmentId: 'x',
      },
      { positionId: POSITION, effectiveDate: '2026-12-01', unknown: 1 },
    ])
      await post(transferPath, body).expect(400);
    expect(operations.transfer).not.toHaveBeenCalled();
    await post(transferPath, {
      positionId: POSITION,
      effectiveDate: '2026-12-01',
      managerAssignmentId: null,
      isPrimary: false,
    }).expect(201);
    expect(operations.transfer).toHaveBeenCalledWith(
      EMPLOYEE,
      ASSIGNMENT,
      {
        positionId: POSITION,
        effectiveDate: '2026-12-01',
        managerAssignmentId: null,
        isPrimary: false,
      },
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
  });

  it('keeps transfer refusal statuses and codes', async () => {
    const body = { positionId: POSITION, effectiveDate: '2026-12-01' };
    operations.transfer.mockRejectedValueOnce(
      new NotFoundException('Position not found'),
    );
    await post(transferPath, body).expect(404);
    operations.transfer.mockRejectedValueOnce(new ForbiddenException('No'));
    await post(transferPath, body).expect(403);
    operations.transfer.mockRejectedValueOnce(
      new ConflictException(
        domainError(409, 'LIFECYCLE_FINALIZED_RECORDS', 'Finalized.', {
          blockers: [],
        }),
      ),
    );
    const finalized = await post(transferPath, body).expect(409);
    expect(finalized.body.code).toBe('LIFECYCLE_FINALIZED_RECORDS');
  });

  it('serves the impact preview with an optional strict end date', async () => {
    const path = `/employees/${EMPLOYEE}/assignments/${ASSIGNMENT}/impact`;
    await get(path).expect(200);
    await get(`${path}?endDate=2026-12-31`).expect(200);
    await get(`${path}?endDate=tomorrow`).expect(400);
    expect(operations.impact).toHaveBeenNthCalledWith(
      1,
      EMPLOYEE,
      ASSIGNMENT,
      'user-1',
      {},
    );
    expect(operations.impact).toHaveBeenNthCalledWith(
      2,
      EMPLOYEE,
      ASSIGNMENT,
      'user-1',
      {
        endDate: '2026-12-31',
      },
    );
  });

  it('routes physical sites and validates them', async () => {
    const base = `/organizations/${ORG}/physical-sites`;
    await get(base).expect(200);
    await get(`${base}?includeArchived=true`).expect(200);
    expect(sites.list).toHaveBeenLastCalledWith(ORG, 'user-1', true);
    await get(`${base}/${SITE}`).expect(200);
    await get(`/organizations/not-a-uuid/physical-sites`).expect(400);
    await post(base, {}).expect(400);
    await post(base, { name: '   ' }).expect(400);
    await post(base, { name: 'North', city: 'Toronto' }).expect(201);
    await patch(`${base}/${SITE}`, { city: null }).expect(200);
    await post(`${base}/${SITE}/archive`).expect(201);
    await post(`${base}/${SITE}/reactivate`).expect(201);
    expect(sites.create).toHaveBeenCalledWith(
      ORG,
      { name: 'North', city: 'Toronto' },
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
    sites.archive.mockRejectedValueOnce(
      new ConflictException(
        domainError(409, 'PHYSICAL_SITE_IN_USE', 'In use.', {
          activeWorkLocations: 1,
          activeDevices: 0,
        }),
      ),
    );
    const inUse = await post(`${base}/${SITE}/archive`).expect(409);
    expect(inUse.body).toMatchObject({
      code: 'PHYSICAL_SITE_IN_USE',
      activeWorkLocations: 1,
    });
  });
});
