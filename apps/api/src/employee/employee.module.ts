import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { EmployeeDomainService } from './employee-domain.service.js';
import { EmployeeController } from './employee.controller.js';
import { EmployeeAccountController } from './employee-account.controller.js';
import { EmployeeAccountService } from './employee-account.service.js';
import { EmployeeAccountAlertService } from './employee-account-alerts.service.js';
import { EmployeeAccessService } from './employee-access.service.js';
import {
  EmployeePayrollSource,
  PAYROLL_EMPLOYMENT_SOURCE,
} from './employee-payroll.source.js';
import { EmployeeAssignmentOperationsService } from './employee-assignment-operations.service.js';
import { EmployeeLifecycleService } from './employee-lifecycle.service.js';
import { EmployeeService } from './employee.service.js';

@Module({
  // M1: high-risk refused login-access actions alert security administrators.
  imports: [AuditModule, AuthModule, AuthorizationModule, NotificationsModule],
  controllers: [EmployeeController, EmployeeAccountController],
  providers: [
    AccessTokenGuard,
    EmployeeDomainService,
    EmployeeAccessService,
    EmployeeService,
    EmployeeLifecycleService,
    EmployeeAssignmentOperationsService,
    EmployeeAccountService,
    EmployeeAccountAlertService,
    // Phase 10: Core HR facts for Payroll.
    EmployeePayrollSource,
    { provide: PAYROLL_EMPLOYMENT_SOURCE, useExisting: EmployeePayrollSource },
  ],
  exports: [
    EmployeeDomainService,
    EmployeeAccessService,
    EmployeeService,
    EmployeeLifecycleService,
    PAYROLL_EMPLOYMENT_SOURCE,
  ],
})
export class EmployeeModule {}
