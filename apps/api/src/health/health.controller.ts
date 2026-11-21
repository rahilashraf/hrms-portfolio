import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import {
  checkDatabase,
  checkRedis,
  readiness,
  type ReadinessReport,
} from './health-checks.js';

/**
 * Phase 19 — unauthenticated probes for the platform. /health is liveness (the process
 * serves HTTP; no dependency is touched, so a database outage never restarts the API);
 * /ready answers 503 until PostgreSQL and Redis both respond within short timeouts.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  @Header('Cache-Control', 'no-store')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessReport> {
    const report = await readiness({
      database: () => checkDatabase(this.prisma),
      redis: () => checkRedis(this.redis.client),
    });
    if (report.status !== 'ready') response.status(503);
    return report;
  }
}
