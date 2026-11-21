import cookieParser from 'cookie-parser';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AccessTokenService } from '../../src/auth/access-token.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SessionsService } from '../../src/sessions/sessions.service.js';
import { SystemClock } from '../../src/time/time.service.js';
import { rollbackClient, type Tx } from './scheduling-fixtures.js';

/** The browser origin the HTTP specs present (kiosk enrollment checks it). */
export const SPEC_WEB_ORIGIN = 'http://web.time-spec.test';

/** The scenario's transaction as the application's PrismaService (it owns no connection). */
function appClient(tx: Tx) {
  const client = rollbackClient(tx);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'onModuleInit' || property === 'onModuleDestroy') {
        return async () => undefined;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

export interface TimeHttp {
  app: INestApplication<App>;
  server: App;
  /** Requests authenticated as the fixture user (a signed bearer access token). */
  as(userId: string): Promise<{
    get(path: string): request.Test;
    post(path: string, body?: object): request.Test;
    put(path: string, body?: object): request.Test;
    patch(path: string, body?: object): request.Test;
    delete(path: string): request.Test;
  }>;
  /** An unauthenticated request. */
  anonymous(): request.Agent;
}

/**
 * The whole API (AppModule, real guards, pipes and controllers) over the scenario's rollback
 * transaction, with a fixed clock for Time. Redis is the real one from REDIS_URL (kiosk
 * interactions and rate limits need it; every key is per random device or token). Sessions are
 * stubbed so a signed access token for any fixture user is accepted.
 */
export async function withTimeHttp(
  tx: Tx,
  clock: SystemClock,
  run: (http: TimeHttp) => Promise<void>,
  /** Further providers to replace (for example a domain's fixed clock). */
  overrides: ReadonlyArray<readonly [provider: unknown, value: unknown]> = [],
) {
  process.env.JWT_ACCESS_SECRET ||=
    'db-spec-only-deterministic-secret-value-at-least-32';
  process.env.WEB_ORIGIN = SPEC_WEB_ORIGIN;
  const { AppModule } = await import('../../src/app.module.js');
  let builder = Test.createTestingModule({
    imports: [AppModule],
  });
  for (const [provider, value] of overrides)
    builder = builder.overrideProvider(provider).useValue(value);
  const moduleFixture = await builder
    .overrideProvider(PrismaService)
    .useValue(appClient(tx))
    .overrideProvider(SystemClock)
    .useValue(clock)
    .overrideProvider(SessionsService)
    .useValue({
      findActiveByIdAndUser: vi.fn().mockResolvedValue({
        id: 'session-1',
        mustChangePassword: false,
      }),
    })
    .compile();
  const app: INestApplication<App> = moduleFixture.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  const tokens = app.get(AccessTokenService);
  const server = app.getHttpServer();
  try {
    await run({
      app,
      server,
      async as(userId) {
        const authorization = `Bearer ${await tokens.issue({
          userId,
          sessionId: 'session-1',
        })}`;
        return {
          get: (path) =>
            request(server).get(path).set('Authorization', authorization),
          post: (path, body = {}) =>
            request(server)
              .post(path)
              .set('Authorization', authorization)
              .send(body),
          put: (path, body = {}) =>
            request(server)
              .put(path)
              .set('Authorization', authorization)
              .send(body),
          patch: (path, body = {}) =>
            request(server)
              .patch(path)
              .set('Authorization', authorization)
              .send(body),
          delete: (path) =>
            request(server).delete(path).set('Authorization', authorization),
        };
      },
      anonymous: () => request.agent(server),
    });
  } finally {
    await app.close();
  }
}
