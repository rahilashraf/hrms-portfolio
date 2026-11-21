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

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ROLE = '00000000-0000-4000-8000-0000000000aa';
const OUTSIDER = '00000000-0000-4000-8000-0000000000ee';

type Grant = { permission: string; scope: { type: string; id?: string } };

/**
 * The role-assignment user search and role assignment over HTTP: an organization-scoped
 * administrator's search and assignment are limited to accounts connected to organizations they
 * administer (the database spec proves the matching rows); System scope is unrestricted.
 */
describe('Role assignment user search routes (e2e)', () => {
  let app: INestApplication<App>;
  let auth: string;
  let grants: Grant[] = [];
  const user = {
    id: OUTSIDER,
    email: 'someone@example.com',
    status: 'ACTIVE',
    person: {
      firstName: 'Some',
      lastName: 'One',
      preferredName: null,
      employee: { employeeNumber: 'E-1' },
    },
  };
  const prisma = {
    user: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findUnique: vi.fn(async () => ({
        id: OUTSIDER,
        status: 'ACTIVE',
        archivedAt: null,
      })),
      count: vi.fn(async () => 0),
    },
    role: {
      findUnique: vi.fn(async () => ({
        id: ROLE,
        organizationId: ORG_A,
        isSystemOwner: false,
        archivedAt: null,
        permissions: [],
      })),
    },
    roleAssignment: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
    },
    $transaction: vi.fn(
      async (run: (tx: unknown) => Promise<unknown>) => await run(prisma),
    ),
  };
  const authorization = {
    can: vi.fn(async () => true),
    assertCan: vi.fn(async () => undefined),
    assertCanDelegate: vi.fn(async () => undefined),
    resolveAssignmentScope: vi.fn(async () => ({ organizationId: ORG_A })),
    effectiveGrants: vi.fn(async () => grants),
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
        findActiveByIdAndUser: vi.fn().mockResolvedValue({
          id: 'session-1',
          mustChangePassword: false,
        }),
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
    vi.clearAllMocks();
    authorization.assertCan.mockResolvedValue(undefined);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
  });

  afterAll(async () => {
    await app?.close();
  });

  const search = (query: string) =>
    request(app.getHttpServer())
      .get(`/authorization/users?${query}`)
      .set('Authorization', auth);
  const lastWhere = () =>
    (
      prisma.user.findMany.mock.calls.at(-1) as unknown as [
        { where: { AND: unknown[] } },
      ]
    )[0].where;
  /** The organizations an account must be connected to, from the membership filter. */
  const membershipOrganizations = (filter: unknown) => {
    const json = JSON.stringify(filter);
    return [...json.matchAll(/"in":\[([^\]]*)\]/g)]
      .map((match) => match[1]!)
      .filter((list) => list.includes('-'));
  };

  it('limits an organization administrator to the organizations they administer', async () => {
    grants = [
      { permission: 'role.assign', scope: { type: 'ORGANIZATION', id: ORG_A } },
      { permission: 'role.assign', scope: { type: 'DEPARTMENT', id: ORG_B } },
      { permission: 'employee.read', scope: { type: 'SYSTEM' } },
    ];
    prisma.user.findMany.mockResolvedValueOnce([user]);
    const response = await search(
      `organizationId=${ORG_A}&query=some&limit=10`,
    ).expect(200);
    expect(response.body).toEqual({
      items: [
        {
          id: OUTSIDER,
          email: 'someone@example.com',
          status: 'ACTIVE',
          displayName: 'Some One',
          employeeNumber: 'E-1',
        },
      ],
      nextCursor: null,
    });
    expect(authorization.assertCan).toHaveBeenCalledWith(
      'user-1',
      'role.assign',
      { type: 'ORGANIZATION', id: ORG_A },
    );
    const where = lastWhere();
    // Employment and role membership, both limited to organization A (a department grant or
    // System scope for another permission adds nothing).
    expect(membershipOrganizations(where.AND[0])).toEqual([
      `"${ORG_A}"`,
      `"${ORG_A}"`,
    ]);
    expect(JSON.stringify(where.AND[1])).toContain('"some"');
  });

  it('leaves the search unrestricted for a System-scope administrator', async () => {
    grants = [{ permission: 'role.assign', scope: { type: 'SYSTEM' } }];
    await search(`organizationId=${ORG_A}`).expect(200);
    expect(lastWhere().AND[0]).toEqual({});
  });

  it('refuses the search without role.assign in the organization, before any lookup', async () => {
    authorization.assertCan.mockRejectedValueOnce(
      new (await import('@nestjs/common')).ForbiddenException(),
    );
    await search(`organizationId=${ORG_B}`).expect(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('answers an assignment to an account outside the administrator’s organizations like an unknown account', async () => {
    grants = [
      { permission: 'role.assign', scope: { type: 'ORGANIZATION', id: ORG_A } },
    ];
    const response = await request(app.getHttpServer())
      .post('/authorization/assignments')
      .set('Authorization', auth)
      .send({
        userId: OUTSIDER,
        roleId: ROLE,
        scope: { type: 'ORGANIZATION', id: ORG_A },
      })
      .expect(404);
    expect(response.body.message).toBe('Active or invited user not found');
    expect(prisma.roleAssignment.create).not.toHaveBeenCalled();
    const counted = (
      prisma.user.count.mock.calls[0] as unknown as [{ where: unknown }]
    )[0].where;
    expect(JSON.stringify(counted)).toContain(OUTSIDER);
    expect(membershipOrganizations(counted)).toEqual([
      `"${ORG_A}","${ORG_A}"`,
      `"${ORG_A}","${ORG_A}"`,
    ]);
  });
});
