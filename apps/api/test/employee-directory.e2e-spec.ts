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
 * GET /employees pagination: the query-string limit is converted to an integer before the
 * 1..100 range check (the web directory always sends limit=25), the default applies when no
 * limit is sent, and out-of-range or non-integer limits are still refused.
 */
describe('Employee directory route (e2e)', () => {
  let app: INestApplication<App>;
  let auth: string;
  const employee = (id: string, firstName: string) => ({
    id,
    employeeNumber: `EMP-${id.slice(-6)}`,
    status: 'ACTIVE',
    person: { firstName, lastName: 'Example' },
    assignments: [],
  });
  const prisma = {
    employee: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  };
  const authorization = {
    // System-wide employee.read, so the directory does not need position-level checks.
    can: vi.fn(async () => true),
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
    // Mirrors the global pipe configured in http-application.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    const token = await app
      .get(AccessTokenService)
      .issue({ userId: 'user-1', sessionId: 'session-1' });
    auth = `Bearer ${token}`;
  });

  beforeEach(() => {
    prisma.employee.findMany.mockReset();
    prisma.employee.findMany.mockResolvedValue([]);
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', auth);

  it('loads an empty directory without a limit', async () => {
    const response = await get('/employees').expect(200);
    expect(response.body).toEqual({ items: [], nextAfterId: null });
  });

  it('loads an empty directory with the web default page size', async () => {
    const response = await get('/employees?limit=25').expect(200);
    expect(response.body).toEqual({ items: [], nextAfterId: null });
  });

  it('returns employees from a populated directory and paginates with the query limit', async () => {
    prisma.employee.findMany.mockResolvedValueOnce([
      employee('00000000-0000-4000-8000-000000000001', 'Ada'),
      employee('00000000-0000-4000-8000-000000000002', 'Grace'),
      employee('00000000-0000-4000-8000-000000000003', 'Katherine'),
    ]);
    const response = await get('/employees?limit=2').expect(200);
    expect(
      response.body.items.map(
        (item: { person: { firstName: string } }) => item.person.firstName,
      ),
    ).toEqual(['Ada', 'Grace']);
    expect(response.body.nextAfterId).toBe(
      '00000000-0000-4000-8000-000000000002',
    );
  });

  it('returns employees without an explicit limit', async () => {
    prisma.employee.findMany.mockResolvedValueOnce([
      employee('00000000-0000-4000-8000-000000000001', 'Ada'),
    ]);
    const response = await get('/employees').expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.nextAfterId).toBeNull();
  });

  it.each(['0', '101', '2.5', 'abc'])('rejects limit=%s', async (limit) => {
    await get(`/employees?limit=${limit}`).expect(400);
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });
});
