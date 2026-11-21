import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuditViewerController } from './audit-viewer.controller.js';
import { AuditViewerService } from './audit-viewer.service.js';

/** Phase 19 — read-only audit viewer (GET /audit, audit.read). */
@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [AuditViewerController],
  providers: [AccessTokenGuard, AuditViewerService],
})
export class AuditViewerModule {}
