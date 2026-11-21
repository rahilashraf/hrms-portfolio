import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CompensationAccessService } from './compensation-access.service.js';
import { PAYROLL_COMPENSATION_SOURCE } from './compensation-integration.contracts.js';
import { CompensationPayrollSource } from './compensation-payroll.source.js';
import {
  AssignmentCompensationController,
  CompensationController,
  PayGroupController,
} from './compensation.controller.js';
import { CompensationService } from './compensation.service.js';
import { PayGroupService } from './pay-group.service.js';

/**
 * Phase 9 — Compensation: effective-dated pay facts of employment assignments and minimal pay
 * groups. Depends on no other business domain; exports PAYROLL_COMPENSATION_SOURCE for Phase 10
 * Payroll (facts only — Compensation never calculates pay).
 */
@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule],
  controllers: [
    AssignmentCompensationController,
    CompensationController,
    PayGroupController,
  ],
  providers: [
    AccessTokenGuard,
    CompensationAccessService,
    CompensationService,
    PayGroupService,
    CompensationPayrollSource,
    {
      provide: PAYROLL_COMPENSATION_SOURCE,
      useExisting: CompensationPayrollSource,
    },
  ],
  exports: [CompensationService, PAYROLL_COMPENSATION_SOURCE],
})
export class CompensationModule {}
