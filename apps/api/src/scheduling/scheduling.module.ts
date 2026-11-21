import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { ScheduleAttendanceService } from './schedule-attendance.service.js';
import { EmployeeSchedulePatternService } from './employee-schedule-pattern.service.js';
import {
  EmployeeSchedulePatternController,
  ScheduleTemplateController,
} from './schedule-recurrence.controller.js';
import { ScheduleRuleSetService } from './schedule-rule-set.service.js';
import { SchedulePolicyController } from './schedule-policy.controller.js';
import { SchedulePolicyResolver } from './schedule-policy-resolver.js';
import { SchedulePolicyService } from './schedule-policy.service.js';
import { ScheduleTemplateService } from './schedule-template.service.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';
import { SchedulingController } from './scheduling.controller.js';
import { SchedulingService } from './scheduling.service.js';
import { SchedulingViewController } from './scheduling-view.controller.js';
import { SchedulingViewService } from './scheduling-view.service.js';
import { ShiftGenerationService } from './shift-generation.service.js';

@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule],
  controllers: [
    SchedulingController,
    ScheduleTemplateController,
    EmployeeSchedulePatternController,
    SchedulePolicyController,
    SchedulingViewController,
  ],
  providers: [
    AccessTokenGuard,
    SchedulingDomainService,
    SchedulingService,
    ScheduleRuleSetService,
    ScheduleTemplateService,
    EmployeeSchedulePatternService,
    ShiftGenerationService,
    SchedulePolicyResolver,
    SchedulePolicyService,
    SchedulingViewService,
    ScheduleAttendanceService,
  ],
  exports: [
    SchedulingDomainService,
    SchedulingService,
    ShiftGenerationService,
    SchedulePolicyResolver,
    ScheduleAttendanceService,
  ],
})
export class SchedulingModule {}
