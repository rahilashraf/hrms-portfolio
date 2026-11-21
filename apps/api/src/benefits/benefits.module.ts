import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { BenefitDependentService } from './benefit-dependent.service.js';
import { BenefitEligibilityService } from './benefit-eligibility.service.js';
import { BenefitElectionController } from './benefit-election.controller.js';
import { BenefitEnrollmentService } from './benefit-enrollment.service.js';
import { BenefitOptionsService } from './benefit-options.service.js';
import { BenefitPlanController } from './benefit-plan.controller.js';
import { BenefitPlanService } from './benefit-plan.service.js';
import { BenefitRateService } from './benefit-rate.service.js';
import { BenefitsAccessService } from './benefits-access.service.js';
import { BenefitsClock } from './benefits-common.js';
import {
  BenefitsPayrollSource,
  PAYROLL_BENEFIT_SOURCE,
} from './benefits-payroll.source.js';

/**
 * Phase 11 — Benefits: organization benefit plans, coverage options, effective-dated rates,
 * eligibility, employee dependents and election history. Reads Core HR and organization
 * structure, never writes them; publishes payroll facts for Payroll to consume (Benefits never
 * touches payroll records). Access only through the benefit.* permissions; employees read their
 * own benefits through self-only routes.
 */
@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule],
  controllers: [BenefitPlanController, BenefitElectionController],
  providers: [
    AccessTokenGuard,
    BenefitsAccessService,
    BenefitsClock,
    BenefitPlanService,
    BenefitRateService,
    BenefitEligibilityService,
    BenefitDependentService,
    BenefitEnrollmentService,
    BenefitOptionsService,
    BenefitsPayrollSource,
    { provide: PAYROLL_BENEFIT_SOURCE, useExisting: BenefitsPayrollSource },
  ],
  exports: [PAYROLL_BENEFIT_SOURCE],
})
export class BenefitsModule {}
