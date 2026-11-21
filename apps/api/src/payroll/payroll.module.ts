import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { BenefitsModule } from '../benefits/benefits.module.js';
import { CompensationModule } from '../compensation/compensation.module.js';
import { EmployeeModule } from '../employee/employee.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { TimeModule } from '../time/time.module.js';
import { PayrollAccessService } from './payroll-access.service.js';
import { PayrollAdjustmentService } from './payroll-adjustment.service.js';
import { PayrollCalendarService } from './payroll-calendar.service.js';
import { PayrollClock } from './payroll-common.js';
import { PayrollLifecycleService } from './payroll-lifecycle.service.js';
import { PayrollSeparationService } from './payroll-separation.service.js';
import { PayrollReadService } from './payroll-read.service.js';
import {
  PayrollAdjustmentController,
  PayrollRunController,
} from './payroll-run.controller.js';
import { PayrollRunService } from './payroll-run.service.js';
import { PayrollSelfController } from './payroll-self.controller.js';
import { PayrollSelfService } from './payroll-self.service.js';
import { PayrollSourceService } from './payroll-source.service.js';
import { PayrollTimeOrchestrationService } from './payroll-time-orchestration.service.js';
import { PayrollConfigurationController } from './payroll.controller.js';
import {
  NoStatutoryPayrollCalculator,
  STATUTORY_PAYROLL_CALCULATOR,
} from './statutory/statutory-payroll.contracts.js';

/**
 * Phase 10 — Payroll: its own domain owning payroll calendars, periods, runs, validation,
 * calculations, snapshots, adjustments, finalization and payslip facts. It consumes facts from
 * Core HR, Compensation, Time, Leave, Scheduling and attendance presence through their published
 * contracts and never rewrites them. Access is organization-scoped and granted only through the
 * payroll.* permissions (never implied by employee, compensation or manager access); employees
 * read their own pay through self-only routes.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    BenefitsModule,
    CompensationModule,
    EmployeeModule,
    LeaveModule,
    SchedulingModule,
    TimeModule,
  ],
  controllers: [
    PayrollConfigurationController,
    PayrollRunController,
    PayrollAdjustmentController,
    PayrollSelfController,
  ],
  providers: [
    AccessTokenGuard,
    PayrollAccessService,
    PayrollCalendarService,
    PayrollClock,
    PayrollTimeOrchestrationService,
    PayrollSourceService,
    PayrollRunService,
    PayrollSeparationService,
    PayrollReadService,
    PayrollLifecycleService,
    PayrollAdjustmentService,
    PayrollSelfService,
    // Phase 10 calculates no statutory deductions; a later phase binds a real calculator.
    {
      provide: STATUTORY_PAYROLL_CALCULATOR,
      useClass: NoStatutoryPayrollCalculator,
    },
  ],
})
export class PayrollModule {}
