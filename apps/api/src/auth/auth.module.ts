import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  GOOGLE_API_CLIENT,
  type GoogleApiClient,
} from '../integrations/google/google-api.client.js';
import { GoogleWorkspaceCoreModule } from '../integrations/google/google-workspace-core.module.js';
import { GoogleWorkspaceRuntime } from '../integrations/google/google-workspace-runtime.js';
import { SecurityModule } from '../security/security.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { UsersModule } from '../users/users.module.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AccessTokenService } from './access-token.service.js';
import {
  createAccountEmailService,
  emailEnvironment,
} from './account-email.composition.js';
import { AccountEmailService } from './account-email.service.js';
import { AccountRecoveryQueue } from './account-recovery-queue.service.js';
import { AccountSessionsService } from './account-sessions.service.js';
import { AccountTokenService } from './account-token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DevAccountEmailService } from './dev-account-email.service.js';
import { LoginRateLimiterService } from './login-rate-limiter.service.js';
import { RefreshCookieService } from './refresh-cookie.service.js';

@Module({
  imports: [
    SecurityModule,
    SessionsModule,
    UsersModule,
    AuditModule,
    GoogleWorkspaceCoreModule,
  ],
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    AccessTokenGuard,
    AuthService,
    AccountSessionsService,
    AccountRecoveryQueue,
    RefreshCookieService,
    AccountTokenService,
    LoginRateLimiterService,
    DevAccountEmailService,
    // Account emails: each account's Google Workspace Gmail sender, else the deployment SMTP
    // server (Batch 2), else the in-memory development service (503 in production).
    {
      provide: AccountEmailService,
      inject: [
        PrismaService,
        GoogleWorkspaceRuntime,
        GOOGLE_API_CLIENT,
        DevAccountEmailService,
        ConfigService,
      ],
      useFactory: (
        prisma: PrismaService,
        runtime: GoogleWorkspaceRuntime,
        api: GoogleApiClient,
        fallback: DevAccountEmailService,
        config: ConfigService,
      ) =>
        createAccountEmailService({
          prisma,
          runtime,
          api,
          fallback,
          env: emailEnvironment(config),
        }),
    },
  ],
  exports: [
    AccessTokenService,
    SessionsModule,
    AccountTokenService,
    AccountEmailService,
  ],
})
export class AuthModule {}
