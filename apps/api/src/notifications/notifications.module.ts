import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { defaultNotificationEmailTransport } from './notifications-jobs.js';
import { NotificationEmailTransport } from './notification-email.transport.js';
import {
  GOOGLE_API_CLIENT,
  type GoogleApiClient,
} from '../integrations/google/google-api.client.js';
import { GoogleWorkspaceCoreModule } from '../integrations/google/google-workspace-core.module.js';
import { GoogleWorkspaceRuntime } from '../integrations/google/google-workspace-runtime.js';
import { GoogleWorkspaceEmailTransport } from '../integrations/google/google-workspace.adapters.js';
import { NotificationsAccessService } from './notifications-access.service.js';
import { NotificationsClock } from './notifications-common.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationService } from './notification.service.js';
import { NotificationDeliveryLogService } from './notification-delivery-log.service.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationTemplateService } from './notification-template.service.js';

/**
 * Phase 16 — Notifications & Communications: the shared infrastructure domains publish
 * through instead of inventing their own reminder delivery. An in-app inbox per user,
 * organization-overridable templates with whitelisted placeholders, per-user email
 * preferences and organization email settings (mandatory notices always delivered), and
 * email deliveries with append-only attempts sent by the worker through the
 * NotificationEmailTransport boundary: each organization's Gmail connection, else the
 * deployment's SMTP server (Batch 2), else the development transport.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    AuthorizationModule,
    GoogleWorkspaceCoreModule,
  ],
  controllers: [NotificationsController],
  providers: [
    AccessTokenGuard,
    NotificationsAccessService,
    NotificationsClock,
    NotificationService,
    NotificationDeliveryLogService,
    NotificationSettingsService,
    NotificationTemplateService,
    // Phase 16.5: Gmail for organizations with a gmail.send connection, else the default.
    {
      provide: NotificationEmailTransport,
      inject: [GoogleWorkspaceRuntime, GOOGLE_API_CLIENT],
      useFactory: (runtime: GoogleWorkspaceRuntime, api: GoogleApiClient) =>
        new GoogleWorkspaceEmailTransport(
          runtime,
          api,
          defaultNotificationEmailTransport(),
        ),
    },
  ],
  exports: [
    NotificationService,
    NotificationEmailTransport,
    NotificationSettingsService,
  ],
})
export class NotificationsModule {}
