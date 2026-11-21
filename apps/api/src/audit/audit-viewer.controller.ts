import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { AuditActorQueryDto, AuditQueryDto } from './audit-viewer.dto.js';
import { AuditViewerService } from './audit-viewer.service.js';

/**
 * Phase 19 — audit viewer. Authenticated; authorized in the service (audit.read at
 * organization scope). Not feature-gated: the audit trail exists for every module.
 */
@Controller('audit')
@UseGuards(AccessTokenGuard)
export class AuditViewerController {
  constructor(private readonly audit: AuditViewerService) {}

  @Get()
  list(
    @Query() query: AuditQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.audit.list(identity.userId, query);
  }

  /** Batch R3.3: actors of the entries the caller may read, for the actor filter. */
  @Get('actors')
  actors(
    @Query() query: AuditActorQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.audit.actors(identity.userId, query);
  }
}
