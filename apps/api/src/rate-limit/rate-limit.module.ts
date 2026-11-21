import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { RateLimitExceptionFilter } from './rate-limit.filter.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimitService } from './rate-limit.service.js';

/** Phase 19: the global rate-limit guard (active only on routes with @RateLimit). */
@Module({
  imports: [AuthModule],
  providers: [
    RateLimitService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: RateLimitExceptionFilter },
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
