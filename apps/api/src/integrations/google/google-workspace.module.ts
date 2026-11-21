import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../../auth/access-token.guard.js';
import { AuditModule } from '../../audit/audit.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { AuthorizationModule } from '../../authorization/authorization.module.js';
import { PrismaService } from '../../database/prisma.service.js';
import { OnboardingModule } from '../../onboarding/onboarding.module.js';
import { PERFORMANCE_EVIDENCE_PROVIDERS } from '../../performance/performance-evidence.contract.js';
import { PerformanceModule } from '../../performance/performance.module.js';
import { RECRUITMENT_APPLICATION_PROVIDERS } from '../../recruitment/recruitment-intake.contract.js';
import { RecruitmentModule } from '../../recruitment/recruitment.module.js';
import { GoogleConnectionService } from './google-connection.service.js';
import { GoogleFormBindingService } from './google-form-binding.service.js';
import {
  GoogleFormsApplicationProvider,
  GoogleFormsAssessmentProvider,
  GoogleFormsReader,
} from './google-forms.adapters.js';
import { GoogleSyncService } from './google-sync.service.js';
import { GoogleWorkspaceAccessService } from './google-workspace-access.service.js';
import { GoogleWorkspaceCoreModule } from './google-workspace-core.module.js';
import {
  GoogleOAuthCallbackController,
  GoogleWorkspaceController,
} from './google-workspace.controller.js';

/**
 * Phase 16.5 — Google Workspace integrations: one connection per organization (OAuth by
 * default, service account optionally), Google Forms bound to the existing performance
 * evidence, recruitment intake and onboarding task contracts, Drive reference checks for
 * Documents, Gmail delivery for Notifications and a Sheets export boundary. Domains keep
 * every rule: this module only adapts Google to their contracts and never writes their tables.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GoogleWorkspaceCoreModule,
    PerformanceModule,
    RecruitmentModule,
    OnboardingModule,
  ],
  controllers: [GoogleWorkspaceController, GoogleOAuthCallbackController],
  providers: [
    AccessTokenGuard,
    GoogleWorkspaceAccessService,
    GoogleConnectionService,
    GoogleFormBindingService,
    GoogleSyncService,
    {
      provide: PERFORMANCE_EVIDENCE_PROVIDERS,
      inject: [PrismaService, GoogleFormsReader],
      useFactory: (prisma: PrismaService, reader: GoogleFormsReader) => [
        new GoogleFormsAssessmentProvider(prisma, reader),
      ],
    },
    {
      provide: RECRUITMENT_APPLICATION_PROVIDERS,
      inject: [PrismaService, GoogleFormsReader],
      useFactory: (prisma: PrismaService, reader: GoogleFormsReader) => [
        new GoogleFormsApplicationProvider(prisma, reader),
      ],
    },
  ],
  exports: [
    GoogleSyncService,
    GoogleConnectionService,
    PERFORMANCE_EVIDENCE_PROVIDERS,
    RECRUITMENT_APPLICATION_PROVIDERS,
  ],
})
export class GoogleWorkspaceModule {}
