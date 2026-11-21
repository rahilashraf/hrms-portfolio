import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { PrismaService } from './../src/database/prisma.service.js';
import { RedisService } from './../src/redis/redis.service.js';

/**
 * The application module boots, and the NestJS starter's root route is gone (R5-A): `/` is not
 * an endpoint; the health probes are `/health` and `/ready`.
 */
describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://hrms:hrms_dev_password@localhost:5436/hrms';
    process.env.JWT_ACCESS_SECRET =
      'e2e-only-deterministic-secret-value-at-least-32';
    process.env.REDIS_URL ??= 'redis://localhost:6380';

    const { AppModule } = await import('./../src/app.module.js');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ client: { eval: vi.fn().mockResolvedValue(1) } })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('has no root route', () => {
    return request(app.getHttpServer()).get('/').expect(404);
  });

  afterEach(async () => {
    await app.close();
  });
});
