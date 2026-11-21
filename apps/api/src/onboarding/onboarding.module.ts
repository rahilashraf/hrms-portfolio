import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { OnboardingAccessService } from './onboarding-access.service.js';
import { OnboardingClock } from './onboarding-common.js';
import { WORKFLOW_TASK_COMPLETION_INGESTION } from './onboarding-task.contract.js';
import { OnboardingOptionsService } from './onboarding-options.service.js';
import { OnboardingTaskService } from './onboarding-task.service.js';
import { OnboardingTemplateService } from './onboarding-template.service.js';
import { OnboardingWorkflowService } from './onboarding-workflow.service.js';
import { OnboardingController } from './onboarding.controller.js';

/**
 * Phase 14 — Onboarding & Offboarding: organization templates, per-assignment workflows with
 * frozen task snapshots, task ownership and lifecycle, employee acknowledgements, Google
 * Workspace-ready task references and an external task-completion contract. Reads Core HR
 * (assignments, reporting lines) and Phase 13 hires; never writes them — Core HR remains
 * authoritative for employment start, end and termination.
 */
@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule, DocumentsModule],
  controllers: [OnboardingController],
  providers: [
    AccessTokenGuard,
    OnboardingAccessService,
    OnboardingClock,
    OnboardingTemplateService,
    OnboardingWorkflowService,
    OnboardingTaskService,
    OnboardingOptionsService,
    {
      provide: WORKFLOW_TASK_COMPLETION_INGESTION,
      useExisting: OnboardingTaskService,
    },
  ],
  exports: [WORKFLOW_TASK_COMPLETION_INGESTION, OnboardingWorkflowService],
})
export class OnboardingModule {}
