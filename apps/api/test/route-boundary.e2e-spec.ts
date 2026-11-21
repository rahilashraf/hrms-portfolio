import cookieParser from 'cookie-parser';
import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AccessTokenGuard } from '../src/auth/access-token.guard.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { configureHttpApplication } from '../src/config/http-application.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { KioskDeviceGuard } from '../src/kiosk/kiosk-device.guard.js';
import { InMemoryMetricsService } from '../src/observability/metrics.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';

/**
 * Phase 19 public boundary: every route the Nest router registers — discovered from the
 * controllers, not listed by hand, so a new route is covered automatically — answers 401
 * without credentials, except an explicit allowlist of public flows (probes, the credential
 * flows of /auth, kiosk enrollment and the Google OAuth callback). Kiosk device routes are
 * authenticated by the device cookie (KioskDeviceGuard) and answer 401 without it.
 */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /ready',
  'POST /auth/login',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
  'POST /auth/accept-invitation',
  'POST /auth/verify-email',
  'POST /auth/resend-verification',
  // Refresh and logout authenticate with the refresh cookie, not the access token.
  'POST /auth/refresh',
  'POST /auth/logout',
  // One-time enrollment code; every other kiosk route needs the device cookie.
  'POST /kiosk/enroll',
  // Validates the signed OAuth state; never trusts the caller.
  'GET /integrations/google/oauth/callback',
  // Phase 20: login-page branding — only the public fields of an organization that opted in
  // (publicLoginEnabled), else generic defaults; rate limited by address.
  'GET /public/branding',
  // Batch 9: local document downloads — authorized by a 60-second HMAC token bound to one
  // object (issued only after the documents authorization check); rate limited by address.
  'GET /documents/files/:token',
]);

const DEVICE_ROUTES = new Set([
  'GET /kiosk/session',
  'POST /kiosk/identify',
  'POST /kiosk/actions',
  'POST /kiosk/cancel',
]);

/**
 * Batch 2: the only authenticated routes a user who must change their password may use (their
 * identity, the change itself, signing out and their own sessions). Every other access-token
 * route answers 403 PASSWORD_CHANGE_REQUIRED.
 */
const DURING_PASSWORD_CHANGE_ROUTES = new Set([
  'GET /auth/me',
  'POST /auth/change-password',
  'POST /auth/logout-all',
  'GET /auth/sessions',
  'DELETE /auth/sessions/:id',
  'POST /auth/sessions/revoke-others',
]);

const ID = '00000000-0000-4000-8000-000000000001';

interface Route {
  key: string;
  method: string;
  path: string;
  guards: unknown[];
}

describe('Route boundary (e2e)', () => {
  let app: INestApplication<App>;
  let routes: Route[] = [];
  const sessions = { findActiveByIdAndUser: vi.fn().mockResolvedValue(null) };
  /** Any model / method resolves to "nothing": no route may need data to refuse a caller. */
  const model = new Proxy(
    {},
    {
      get: () => vi.fn(async () => null),
    },
  );
  const prisma = new Proxy(
    {
      $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
      $transaction: vi.fn(async () => null),
    } as Record<string, unknown>,
    {
      get: (target, property: string) =>
        property in target ? target[property] : model,
    },
  );

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://hrms:hrms_dev_password@localhost:5436/hrms';
    process.env.JWT_ACCESS_SECRET =
      'e2e-only-deterministic-secret-value-at-least-32';
    process.env.REDIS_URL ??= 'redis://localhost:6380';
    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue({
        client: {
          eval: vi.fn().mockResolvedValue(1),
          ping: vi.fn().mockResolvedValue('PONG'),
        },
      })
      .overrideProvider(SessionsService)
      .useValue(sessions)
      .overrideProvider(AuthorizationService)
      .useValue({ effectiveGrants: vi.fn(async () => []) })
      .compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    configureHttpApplication(app, {
      production: false,
      webOrigin: 'http://localhost:3000',
      trustProxyHops: 0,
      metrics: new InMemoryMetricsService(),
    });
    await app.init();

    const scanner = new MetadataScanner();
    for (const wrapper of app.get(DiscoveryService).getControllers()) {
      const type = wrapper.metatype as
        (new (...args: never[]) => object) | null;
      if (!type || !wrapper.instance) continue;
      const prefixes = [
        Reflect.getMetadata(PATH_METADATA, type) as string | string[],
      ].flat();
      const classGuards =
        (Reflect.getMetadata(GUARDS_METADATA, type) as unknown[]) ?? [];
      const prototype = Object.getPrototypeOf(wrapper.instance) as object;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name] as object;
        const paths = Reflect.getMetadata(PATH_METADATA, handler) as
          string | string[] | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (paths === undefined || method === undefined) continue;
        const handlerGuards =
          (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [];
        for (const prefix of prefixes)
          for (const path of [paths].flat()) {
            const full = `/${[prefix, path]
              .filter((part) => part && part !== '/')
              .join('/')}`.replace(/\/+/g, '/');
            const verb = RequestMethod[method];
            routes.push({
              key: `${verb} ${full === '/' ? '/' : full.replace(/\/$/, '')}`,
              method: verb.toLowerCase(),
              path: full.replace(/:[A-Za-z]+/g, ID),
              guards: [...classGuards, ...handlerGuards],
            });
          }
      }
    }
    routes = routes.sort((a, b) => a.key.localeCompare(b.key));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('discovers the whole router (every controller route) and keeps the allowlists honest', () => {
    expect(routes.length).toBeGreaterThan(500);
    const keys = new Set(routes.map((route) => route.key));
    for (const key of [...PUBLIC_ROUTES, ...DEVICE_ROUTES])
      expect(keys.has(key), `${key} is registered`).toBe(true);
    // R5B: the Position reference options route is discovered, so it is held to the boundary.
    expect(
      keys.has('GET /organizations/:organizationId/position-reference-options'),
    ).toBe(true);
    // Only GET/POST/PUT/PATCH/DELETE are used.
    expect([...new Set(routes.map((route) => route.method))].sort()).toEqual(
      expect.arrayContaining(['get', 'post']),
    );
  });

  it('declares a guard on every non-public route (access token, or device cookie on kiosk routes)', () => {
    const unguarded = routes
      .filter((route) => !PUBLIC_ROUTES.has(route.key))
      .filter((route) =>
        DEVICE_ROUTES.has(route.key)
          ? !route.guards.includes(KioskDeviceGuard)
          : !route.guards.includes(AccessTokenGuard),
      )
      .map((route) => route.key);
    expect(unguarded).toEqual([]);
  });

  it('answers 401 without credentials on every non-public route', async () => {
    const failures: string[] = [];
    for (const route of routes) {
      if (PUBLIC_ROUTES.has(route.key)) continue;
      const response = await (
        request(app.getHttpServer()) as unknown as Record<
          string,
          (path: string) => request.Test
        >
      )[route.method]!(route.path).send({});
      if (response.status !== 401)
        failures.push(`${route.key} -> ${response.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('refuses an invalid or revoked access token the same way', async () => {
    const sample = routes.filter(
      (route) => !PUBLIC_ROUTES.has(route.key) && !DEVICE_ROUTES.has(route.key),
    );
    for (const route of sample.slice(0, 25)) {
      const response = await (
        request(app.getHttpServer()) as unknown as Record<
          string,
          (path: string) => request.Test
        >
      )[route.method]!(route.path)
        .set('Authorization', 'Bearer not-a-token')
        .send({});
      expect(response.status, route.key).toBe(401);
    }
  });

  it('confines a user who must change their password to the routes needed to change it', async () => {
    const token = await app
      .get(AccessTokenService)
      .issue({ userId: ID, sessionId: ID });
    sessions.findActiveByIdAndUser.mockResolvedValue({
      id: ID,
      mustChangePassword: true,
    });
    try {
      const failures: string[] = [];
      const allowed: string[] = [];
      for (const route of routes) {
        if (!route.guards.includes(AccessTokenGuard)) continue;
        const response = await (
          request(app.getHttpServer()) as unknown as Record<
            string,
            (path: string) => request.Test
          >
        )[route.method]!(route.path)
          .set('Authorization', `Bearer ${token}`)
          .send({});
        const blocked =
          response.status === 403 &&
          (response.body as { code?: string }).code ===
            'PASSWORD_CHANGE_REQUIRED';
        if (DURING_PASSWORD_CHANGE_ROUTES.has(route.key)) {
          allowed.push(route.key);
          if (blocked) failures.push(`${route.key} is blocked`);
        } else if (!blocked) {
          failures.push(`${route.key} -> ${response.status}`);
        }
      }
      expect(failures).toEqual([]);
      expect(allowed.sort()).toEqual([...DURING_PASSWORD_CHANGE_ROUTES].sort());
    } finally {
      sessions.findActiveByIdAndUser.mockResolvedValue(null);
    }
  });
});
