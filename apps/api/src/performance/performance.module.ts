import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PerformanceAccessService } from './performance-access.service.js';
import { PerformanceClock } from './performance-common.js';
import { PerformanceConfigController } from './performance-config.controller.js';
import { PerformanceConfigService } from './performance-config.service.js';
import { PerformanceCycleController } from './performance-cycle.controller.js';
import { PerformanceCycleService } from './performance-cycle.service.js';
import { PERFORMANCE_EVIDENCE_INGESTION } from './performance-evidence.contract.js';
import { PerformanceEvidenceController } from './performance-evidence.controller.js';
import { PerformanceOptionsService } from './performance-options.service.js';
import { PerformanceEvidenceService } from './performance-evidence.service.js';
import { PerformanceGoalController } from './performance-goal.controller.js';
import { PerformanceGoalService } from './performance-goal.service.js';
import { PerformanceHistoryService } from './performance-history.service.js';
import { PerformanceReviewLifecycleService } from './performance-review-lifecycle.service.js';
import { PerformanceReviewController } from './performance-review.controller.js';
import { PerformanceReviewService } from './performance-review.service.js';

/**
 * Phase 12 — Performance Management: competencies, rating scales, review templates, review
 * cycles and reviews, goals and performance evidence (including results consumed from
 * external sources such as Google Forms through a provider-neutral ingestion contract).
 * Reads Core HR and organization structure, never writes them; never changes compensation.
 * Access only through the performance.* permissions, the explicit reviewer of a review, and
 * the employee's own self-service routes.
 */
@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule],
  controllers: [
    PerformanceConfigController,
    PerformanceCycleController,
    PerformanceReviewController,
    PerformanceGoalController,
    PerformanceEvidenceController,
  ],
  providers: [
    AccessTokenGuard,
    PerformanceAccessService,
    PerformanceClock,
    PerformanceConfigService,
    PerformanceCycleService,
    PerformanceReviewService,
    PerformanceReviewLifecycleService,
    PerformanceHistoryService,
    PerformanceGoalService,
    PerformanceEvidenceService,
    PerformanceOptionsService,
    {
      provide: PERFORMANCE_EVIDENCE_INGESTION,
      useExisting: PerformanceEvidenceService,
    },
  ],
  exports: [PERFORMANCE_EVIDENCE_INGESTION],
})
export class PerformanceModule {}
