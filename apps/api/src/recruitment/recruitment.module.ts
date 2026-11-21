import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CompensationModule } from '../compensation/compensation.module.js';
import { EmployeeModule } from '../employee/employee.module.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';
import { RecruitmentCandidateService } from './recruitment-candidate.service.js';
import { RecruitmentClock } from './recruitment-common.js';
import { RecruitmentDashboardService } from './recruitment-dashboard.service.js';
import { RecruitmentHireService } from './recruitment-hire.service.js';
import { RECRUITMENT_APPLICATION_INGESTION } from './recruitment-intake.contract.js';
import { RecruitmentIntakeService } from './recruitment-intake.service.js';
import { RecruitmentInterviewService } from './recruitment-interview.service.js';
import { RecruitmentOfferService } from './recruitment-offer.service.js';
import { RecruitmentOpeningService } from './recruitment-opening.service.js';
import { RecruitmentOptionsService } from './recruitment-options.service.js';
import { RecruitmentStageService } from './recruitment-stage.service.js';
import {
  RecruitmentCandidateController,
  RecruitmentController,
  RecruitmentIntakeController,
  RecruitmentInterviewController,
} from './recruitment.controller.js';

/**
 * Phase 13 — Recruitment / Applicant Tracking: job openings, hiring stages, candidates
 * (Recruitment-owned identities), applications and their pipeline, structured screening,
 * interviews and feedback, offers, explicit hire conversion into Core HR, candidate document
 * references and a provider-neutral ingestion contract for external applications (Google Forms
 * later). Writes Core HR and Compensation only through their domain services during hire
 * conversion; never writes them directly.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    EmployeeModule,
    CompensationModule,
  ],
  controllers: [
    RecruitmentController,
    RecruitmentCandidateController,
    RecruitmentInterviewController,
    RecruitmentIntakeController,
  ],
  providers: [
    AccessTokenGuard,
    RecruitmentAccessService,
    RecruitmentClock,
    RecruitmentStageService,
    RecruitmentOpeningService,
    RecruitmentCandidateService,
    RecruitmentApplicationService,
    RecruitmentInterviewService,
    RecruitmentOfferService,
    RecruitmentHireService,
    RecruitmentIntakeService,
    RecruitmentDashboardService,
    RecruitmentOptionsService,
    {
      provide: RECRUITMENT_APPLICATION_INGESTION,
      useExisting: RecruitmentIntakeService,
    },
  ],
  exports: [RECRUITMENT_APPLICATION_INGESTION, RecruitmentAccessService],
})
export class RecruitmentModule {}
