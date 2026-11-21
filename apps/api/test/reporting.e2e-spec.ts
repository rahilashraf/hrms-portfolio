import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import type { EffectiveGrant } from '../src/authorization/authorization.types.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Phase 17 HTTP surface: every reporting route is authenticated, queries are validated (unknown
 * parameters refused) before any service runs, report.read alone or no grant is refused, and a
 * CSV export is a safe attachment.
 */
describe('Reporting routes (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const id = '00000000-0000-4000-8000-000000000001';
  let grants: EffectiveGrant[] = [];
  const prisma = {
    // Phase 18: no module rows (every module enabled).
    organizationModuleSetting: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    user: {
      findUnique: vi.fn(async () => ({
        email: 'nobody@example.com',
        personId: 'person-1',
        person: { employee: null },
      })),
    },
    organization: {
      findUnique: vi.fn(async () => ({ id, timezone: 'America/Toronto' })),
      findMany: vi.fn(async () => []),
    },
    organizationalUnit: { findMany: vi.fn(async () => []) },
    department: { findMany: vi.fn(async () => []) },
    team: { findMany: vi.fn(async () => []) },
    position: { findMany: vi.fn(async () => []) },
    jobOpening: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => [
      { status: 'ACTIVE', assignments: 3, employees: 3 },
    ]),
  };
  const authorization = {
    effectiveGrants: vi.fn(async () => grants),
    resolveTarget: vi.fn(),
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

  beforeEach(() => {
    grants = [];
    prisma.$queryRaw.mockClear();
    prisma.auditLog.create.mockClear();
  });

  const server = () => request(app.getHttpServer());
  const auth = () => `Bearer ${token}`;

  it('requires authentication on every reporting route', async () => {
    const routes: Array<['get' | 'post', string]> = [
      ['get', '/reports/organizations'],
      ['get', `/reports/catalog?organizationId=${id}`],
      ['get', `/reports/workforce.distribution?organizationId=${id}`],
      [
        'get',
        `/reports/workforce.distribution/export.csv?organizationId=${id}`,
      ],
      ['post', '/reports/workforce.distribution/export/google-sheets'],
    ];
    for (const [method, path] of routes) {
      const response = await server()[method](path).send({});
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it('validates queries before any service runs', async () => {
    const bad = [
      '/reports/catalog',
      '/reports/catalog?organizationId=nope',
      '/reports/workforce.distribution',
      `/reports/workforce.distribution?organizationId=${id}&asOf=06/30/2026`,
      `/reports/workforce.distribution?organizationId=${id}&departmentId=x`,
      `/reports/workforce.distribution?organizationId=${id}&groupBy=salary`,
      `/reports/workforce.distribution?organizationId=${id}&employmentType=INTERN`,
      `/reports/workforce.distribution?organizationId=${id}&sql=1`,
      `/reports/Bad%20Key!?organizationId=${id}`,
      `/reports/workforce.distribution/export.csv?organizationId=${id}&from=2026-1-1`,
    ];
    for (const path of bad) {
      const response = await server().get(path).set('Authorization', auth());
      expect(response.status, path).toBe(400);
    }
    await server()
      .post('/reports/workforce.distribution/export/google-sheets')
      .set('Authorization', auth())
      .send({ organizationId: id, spreadsheetId: 'mine' })
      .expect(400);
    expect(authorization.effectiveGrants).not.toHaveBeenCalled();
    // A well-formed but unsupported filter or range is refused by the report.
    grants = [
      {
        permission: 'report.read',
        scope: { type: 'ORGANIZATION', id },
      },
      { permission: 'employee.read', scope: { type: 'ORGANIZATION', id } },
    ];
    const unsupported = await server()
      .get(
        `/reports/workforce.assignment_status?organizationId=${id}&from=2026-01-01`,
      )
      .set('Authorization', auth())
      .expect(400);
    expect(unsupported.body.code).toBe('REPORT_FILTER_UNSUPPORTED');
    const tooLong = await server()
      .get(
        `/reports/workforce.turnover?organizationId=${id}&from=2019-01-01&to=2026-01-01`,
      )
      .set('Authorization', auth())
      .expect(400);
    expect(tooLong.body.code).toBe('REPORT_RANGE_TOO_LONG');
  });

  it('refuses users without reporting grants, and report.read without the source permission', async () => {
    expect(
      (
        await server()
          .get('/reports/organizations')
          .set('Authorization', auth())
          .expect(200)
      ).body,
    ).toEqual({ items: [] });
    expect(
      (
        await server()
          .get(`/reports/catalog?organizationId=${id}`)
          .set('Authorization', auth())
          .expect(200)
      ).body,
    ).toEqual({ organizationId: id, items: [] });
    for (const path of [
      `/reports/workforce.distribution?organizationId=${id}`,
      `/reports/workforce.distribution/export.csv?organizationId=${id}`,
    ]) {
      await server().get(path).set('Authorization', auth()).expect(403);
    }
    await server()
      .post('/reports/workforce.distribution/export/google-sheets')
      .set('Authorization', auth())
      .send({ organizationId: id })
      .expect(403);
    await server()
      .get(`/reports/workforce.salaries?organizationId=${id}`)
      .set('Authorization', auth())
      .expect(404);

    grants = [
      { permission: 'report.read', scope: { type: 'ORGANIZATION', id } },
      { permission: 'report.export', scope: { type: 'ORGANIZATION', id } },
    ];
    const denied = await server()
      .get(`/reports/compensation.distribution?organizationId=${id}`)
      .set('Authorization', auth())
      .expect(403);
    expect(denied.body.code).toBe('REPORT_ACCESS_DENIED');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('exports CSV as a safe attachment and audits it', async () => {
    grants = ['report.read', 'employee.read'].map((permission) => ({
      permission,
      scope: { type: 'ORGANIZATION' as const, id },
    }));
    // report.read without report.export: the export is refused, the report runs.
    await server()
      .get(
        `/reports/workforce.assignment_status/export.csv?organizationId=${id}`,
      )
      .set('Authorization', auth())
      .expect(403);
    const json = await server()
      .get(`/reports/workforce.assignment_status?organizationId=${id}`)
      .set('Authorization', auth())
      .expect(200);
    expect(json.body).toMatchObject({
      reportKey: 'workforce.assignment_status',
      suppressed: 0,
      scopeSummary: { organizationWide: true },
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    grants.push({
      permission: 'report.export',
      scope: { type: 'ORGANIZATION', id },
    });
    const csv = await server()
      .get(
        `/reports/workforce.assignment_status/export.csv?organizationId=${id}`,
      )
      .set('Authorization', auth())
      .expect(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(
      /^attachment; filename="workforce-assignment_status-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csv.headers['cache-control']).toBe('no-store');
    expect(csv.text.split('\r\n')).toEqual([
      'Status,Assignments,Employees',
      'PLANNED,0,0',
      'ACTIVE,3,3',
      'ENDED,0,0',
      'CANCELLED,0,0',
      '',
    ]);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0]).toMatchObject([
      {
        data: {
          action: 'REPORT_EXPORTED',
          entityType: 'Organization',
          entityId: id,
          metadata: {
            reportKey: 'workforce.assignment_status',
            format: 'CSV',
            rowCount: 4,
          },
        },
      },
    ]);
  });
});
