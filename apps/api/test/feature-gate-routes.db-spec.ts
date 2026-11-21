import cookieParser from 'cookie-parser';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config } from 'dotenv';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import type { FeatureModule } from '../src/features/features-domain.js';
import { ORGANIZATION_MODULES } from '../src/features/features-domain.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { ALL_DOMAIN_PERMISSIONS } from './support/features-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  type SchedulingFixtures,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

/**
 * Phase 19 feature-flag sweep over HTTP, against the real database and the real Nest wiring
 * (guards, pipes, controllers, services): for every gated module, a representative route
 * answers 200 for an authorized user while the module is on and 403 { code: FEATURE_DISABLED,
 * module } while it is off — and a caller WITHOUT access gets the same non-FEATURE_DISABLED
 * refusal in both states (the gate never runs before authorization). The audit viewer is
 * exercised end to end as well.
 */
const REPRESENTATIVE: Record<FeatureModule, (org: string) => string> = {
  ATTENDANCE: (org) => `/time/policies?organizationId=${org}`,
  SCHEDULING: (org) => `/schedule-templates?organizationId=${org}`,
  LEAVE: (org) => `/leave/types?organizationId=${org}`,
  COMPENSATION: (org) => `/pay-groups?organizationId=${org}`,
  PAYROLL: (org) => `/payroll/calendars?organizationId=${org}`,
  BENEFITS: (org) => `/benefits/plans?organizationId=${org}`,
  PERFORMANCE: (org) => `/performance/competencies?organizationId=${org}`,
  RECRUITMENT: (org) => `/recruitment/stages?organizationId=${org}`,
  ONBOARDING: (org) => `/onboarding/templates?organizationId=${org}`,
  DOCUMENTS: (org) => `/documents/types?organizationId=${org}`,
  NOTIFICATIONS: (org) => `/notifications/templates?organizationId=${org}`,
  GOOGLE_WORKSPACE: (org) =>
    `/integrations/google/bindings?organizationId=${org}`,
  REPORTING: (org) => `/reports/catalog?organizationId=${org}`,
};

describe('Feature gate and audit routes (database, HTTP)', () => {
  let prisma: PrismaService;
  let app: INestApplication<App>;
  let fx: SchedulingFixtures;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ||=
      'db-spec-only-deterministic-secret-value-at-least-32';
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) =>
        createSchedulingFixtures(
          tx,
          {
            hr: [{ permissions: ALL_DOMAIN_PERMISSIONS, scope: 'org' }],
            hrB: [{ permissions: ALL_DOMAIN_PERMISSIONS, scope: 'orgB' }],
            auditReader: [{ permissions: ['audit.read'], scope: 'org' }],
          },
          ['audit.read'],
        ),
      { timeout: 60_000 },
    );
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
    const issuer = app.get(AccessTokenService);
    for (const label of ['hr', 'hrB', 'auditReader'])
      tokens[label] = await issuer.issue({
        userId: fx.users[label]!,
        sessionId: 'session-1',
      });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (fx) {
      // Batch R2: audit entries are append-only; test clean-up bypasses the guard (superuser only).
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.auditLog.deleteMany({
          where: { metadata: { path: ['organizationId'], equals: fx.orgA } },
        });
      });
      await cleanupSchedulingFixtures(prisma, fx);
    }
    await prisma?.$disconnect();
  }, 120_000);

  const get = (path: string, user: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${tokens[user]}`);

  const setModule = (module: FeatureModule, enabled: boolean) =>
    prisma.organizationModuleSetting.upsert({
      where: { organizationId_module: { organizationId: fx.orgA, module } },
      create: { organizationId: fx.orgA, module, enabled },
      update: { enabled, version: { increment: 1 } },
    });

  it('covers every organization module', () => {
    expect(Object.keys(REPRESENTATIVE).sort()).toEqual(
      [...ORGANIZATION_MODULES].sort(),
    );
  });

  it.each([...ORGANIZATION_MODULES])(
    '%s: 200 when on, 403 FEATURE_DISABLED when off; no gate answer for callers without access',
    async (module) => {
      const path = REPRESENTATIVE[module](fx.orgA);
      const on = await get(path, 'hr');
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      // A caller of another organization is refused (403 / 404) or sees nothing (an empty
      // catalog) — never data, never the gate.
      const outsiderOn = await get(path, 'hrB');
      expect([200, 403, 404]).toContain(outsiderOn.status);
      if (outsiderOn.status === 200)
        expect(outsiderOn.body.items ?? []).toEqual([]);
      expect(outsiderOn.body.code).not.toBe('FEATURE_DISABLED');
      try {
        await setModule(module, false);
        const off = await get(path, 'hr');
        expect(off.status).toBe(403);
        expect(off.body).toMatchObject({ code: 'FEATURE_DISABLED', module });
        // The same refusal as before for the outsider: the gate never runs first.
        const outsiderOff = await get(path, 'hrB');
        expect(outsiderOff.status).toBe(outsiderOn.status);
        expect(outsiderOff.body).toEqual(outsiderOn.body);
        // Another organization is unaffected.
        expect((await get(REPRESENTATIVE[module](fx.orgB), 'hrB')).status).toBe(
          200,
        );
      } finally {
        await setModule(module, true);
      }
      expect((await get(path, 'hr')).status).toBe(200);
    },
  );

  it('serves the audit viewer over HTTP with validation, scope and a safe projection', async () => {
    await prisma.auditLog.create({
      data: {
        action: 'PHASE19_ROUTE_CHECK',
        entityType: 'Organization',
        entityId: fx.orgA,
        actorUserId: fx.users.hr!,
        ipAddress: '10.1.2.3',
        correlationId: 'route-check',
        metadata: {
          organizationId: fx.orgA,
          reason: 'free text',
          withReason: true,
        },
      },
    });
    const ok = await get(
      `/audit?organizationId=${fx.orgA}&action=PHASE19_ROUTE_CHECK`,
      'auditReader',
    );
    expect(ok.status).toBe(200);
    expect(ok.body.items).toHaveLength(1);
    expect(ok.body.items[0]).toMatchObject({
      action: 'PHASE19_ROUTE_CHECK',
      requestId: 'route-check',
      metadata: { organizationId: fx.orgA, withReason: true },
    });
    expect(JSON.stringify(ok.body)).not.toMatch(/free text|10\.1\.2\.3/);
    expect(ok.body).toHaveProperty('nextCursor', null);
    // Domain permissions never imply audit.read; other organizations are refused.
    expect((await get(`/audit?organizationId=${fx.orgA}`, 'hr')).status).toBe(
      403,
    );
    expect(
      (await get(`/audit?organizationId=${fx.orgB}`, 'auditReader')).status,
    ).toBe(403);
    // Validation before any query.
    for (const query of [
      'organizationId=nope',
      `organizationId=${fx.orgA}&limit=1000`,
      `organizationId=${fx.orgA}&cursor=${encodeURIComponent('a b')}`,
      `organizationId=${fx.orgA}&action=${encodeURIComponent("x' OR 1=1 --")}`,
      `organizationId=${fx.orgA}&unknown=1`,
    ])
      expect((await get(`/audit?${query}`, 'auditReader')).status, query).toBe(
        400,
      );
    expect(
      (
        await get(
          `/audit?organizationId=${fx.orgA}&from=2020-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`,
          'auditReader',
        )
      ).body,
    ).toMatchObject({ code: 'AUDIT_RANGE_TOO_WIDE' });
    expect((await request(app.getHttpServer()).get('/audit')).status).toBe(401);
  });

  it('serves the audit actor lookup over HTTP with the same scope and validation (Batch R3.3)', async () => {
    // The entry written by the previous test (actor: the hr user, organization A) is committed.
    const ok = await get(
      `/audit/actors?organizationId=${fx.orgA}`,
      'auditReader',
    );
    expect(ok.status).toBe(200);
    expect(ok.body.items).toContainEqual(
      expect.objectContaining({ userId: fx.users.hr! }),
    );
    expect(ok.body).toHaveProperty('nextAfterId');
    expect(JSON.stringify(ok.body)).not.toMatch(/@/);
    expect(
      (await get(`/audit/actors?organizationId=${fx.orgA}`, 'hr')).status,
    ).toBe(403);
    expect(
      (await get(`/audit/actors?organizationId=${fx.orgB}`, 'auditReader'))
        .status,
    ).toBe(403);
    for (const query of [
      'organizationId=nope',
      `organizationId=${fx.orgA}&limit=51`,
      `organizationId=${fx.orgA}&afterId=x`,
      `organizationId=${fx.orgA}&query=${'a'.repeat(101)}`,
      `organizationId=${fx.orgA}&unknown=1`,
    ])
      expect(
        (await get(`/audit/actors?${query}`, 'auditReader')).status,
        query,
      ).toBe(400);
    expect(
      (await request(app.getHttpServer()).get('/audit/actors')).status,
    ).toBe(401);
  });
});
