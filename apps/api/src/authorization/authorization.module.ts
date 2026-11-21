import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthorizationCatalogService } from './authorization-catalog.service.js';
import {
  AuthorizationController,
  AuthorizationSnapshotController,
} from './authorization.controller.js';
import { AuthorizationService } from './authorization.service.js';
import { RoleManagementService } from './role-management.service.js';
import { PositionAuthorizationTargetResolver } from './position-authorization-target.resolver.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [AuthorizationController, AuthorizationSnapshotController],
  providers: [
    AccessTokenGuard,
    AuthorizationCatalogService,
    AuthorizationService,
    RoleManagementService,
    PositionAuthorizationTargetResolver,
  ],
  exports: [
    AuthorizationCatalogService,
    AuthorizationService,
    RoleManagementService,
    PositionAuthorizationTargetResolver,
  ],
})
export class AuthorizationModule {}
