import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { LeaveAccessService } from './leave-access.service.js';
import { LeaveConfigService } from './leave-config.service.js';
import { LeaveEntitlementService } from './leave-entitlement.service.js';
import {
  LeaveAbsenceSource,
  LeaveIntegrationRegistry,
} from './leave-integration.js';
import { LeaveLedgerService } from './leave-ledger.service.js';
import { LeaveRequestService } from './leave-request.service.js';
import { LeaveViewService } from './leave-view.service.js';
import { LeaveSelfCalendarService } from './leave-self-calendar.service.js';
import {
  LeaveConfigController,
  LeaveManagementController,
  LeaveSelfController,
} from './leave.controller.js';

/**
 * Phase 8 — Leave & Absence. Consumes Scheduling's published expected work and the
 * organization calendar; never imports Time & Attendance (Time imports Leave, binds
 * APPROVED_ABSENCE_SOURCE to LeaveAbsenceSource and registers its side of the contract with
 * LeaveIntegrationRegistry).
 */
import {
  LeavePayrollSource,
  PAYROLL_LEAVE_SOURCE,
} from './leave-payroll.source.js';
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    CalendarModule,
    SchedulingModule,
  ],
  controllers: [
    LeaveSelfController,
    LeaveManagementController,
    LeaveConfigController,
  ],
  providers: [
    LeaveSelfCalendarService,
    AccessTokenGuard,
    LeaveAccessService,
    LeaveConfigService,
    LeaveLedgerService,
    LeaveRequestService,
    LeaveViewService,
    LeaveEntitlementService,
    LeaveIntegrationRegistry,
    LeaveAbsenceSource,
    // Phase 10: approved leave days for Payroll.
    LeavePayrollSource,
    { provide: PAYROLL_LEAVE_SOURCE, useExisting: LeavePayrollSource },
  ],
  exports: [
    LeaveIntegrationRegistry,
    LeaveAbsenceSource,
    PAYROLL_LEAVE_SOURCE,
    // Phase 20: the self-service balances summary on the dashboard.
    LeaveViewService,
  ],
})
export class LeaveModule {}
