import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { LeaveAbsenceSource } from '../leave/leave-integration.js';
import { LeaveModule } from '../leave/leave.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { ScheduleVarianceService } from './schedule-variance.service.js';
import { TimeController, TimeManagementController } from './time.controller.js';
import {
  TimeManageOrganizationsController,
  TimePolicyController,
} from './time-policy.controller.js';
import {
  ManagedSignInController,
  MySignInController,
} from './attendance-sign-in.controller.js';
import { AttendanceSignInService } from './attendance-sign-in.service.js';
import { TimePolicyService } from './time-policy.service.js';
import { TimeDomainService } from './time-domain.service.js';
import {
  APPROVED_ABSENCE_SOURCE,
  ATTENDANCE_PRESENCE_SOURCE,
  PAYROLL_TIME_SOURCE,
} from './time-integration.contracts.js';
import { TimeLeaveIntegration } from './time-leave.integration.js';
import { SystemClock, TimeService } from './time.service.js';

@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    SchedulingModule,
    LeaveModule,
  ],
  controllers: [
    TimeController,
    TimeManagementController,
    TimePolicyController,
    TimeManageOrganizationsController,
    MySignInController,
    ManagedSignInController,
  ],
  providers: [
    AccessTokenGuard,
    TimeDomainService,
    TimeService,
    TimePolicyService,
    AttendanceSignInService,
    // Phase 9.5: presence facts for Payroll (Phase 10); never worked minutes.
    {
      provide: ATTENDANCE_PRESENCE_SOURCE,
      useExisting: AttendanceSignInService,
    },
    // Phase 10: Payroll asks Time for TimePeriods and timesheets (Time owns both).
    { provide: PAYROLL_TIME_SOURCE, useExisting: TimeService },
    SystemClock,
    ScheduleVarianceService,
    TimeLeaveIntegration,
    // Phase 8: approved leave is the absence source attendance interpretation consumes.
    { provide: APPROVED_ABSENCE_SOURCE, useExisting: LeaveAbsenceSource },
  ],
  exports: [
    TimeDomainService,
    TimePolicyService,
    TimeService,
    AttendanceSignInService,
    ATTENDANCE_PRESENCE_SOURCE,
    PAYROLL_TIME_SOURCE,
  ],
})
export class TimeModule {}
