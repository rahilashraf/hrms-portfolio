import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { HolidayController } from './holiday.controller.js';
import { HolidayService } from './holiday.service.js';

/** Phase 8 — organization holidays and closures. Depends on no scheduling or leave code. */
@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule],
  controllers: [HolidayController],
  providers: [AccessTokenGuard, HolidayService],
  exports: [HolidayService],
})
export class CalendarModule {}
