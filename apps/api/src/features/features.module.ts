import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { GoogleWorkspaceModule } from '../integrations/google/google-workspace.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TimeModule } from '../time/time.module.js';
import { FeaturesAccessService } from './features-access.service.js';
import { FeaturesController } from './features.controller.js';
import { FeaturesService } from './features.service.js';

/**
 * Phase 18 — Admin configuration / feature management: per-organization module switches with
 * dependency rules, typed settings validated against a code registry, optimistic concurrency,
 * audit and change history, and linked sections for configuration that already has its own
 * home (time & attendance policy layers, notification settings, the Google Workspace
 * connection). Enforcement is the global FeatureGateService, used by every gated module.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    TimeModule,
    NotificationsModule,
    GoogleWorkspaceModule,
  ],
  controllers: [FeaturesController],
  providers: [AccessTokenGuard, FeaturesAccessService, FeaturesService],
})
export class FeaturesModule {}
