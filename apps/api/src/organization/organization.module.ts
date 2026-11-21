import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrganizationArchivePolicyService } from './organization-archive-policy.service.js';
import { OrganizationController } from './organization.controller.js';
import { OrganizationIntegrityService } from './organization-integrity.service.js';
import { OrganizationService } from './organization.service.js';
import { PhysicalSiteController } from './physical-site.controller.js';
import { PhysicalSiteService } from './physical-site.service.js';
import { OrganizationAuthorizationInterceptor } from './organization-authorization.interceptor.js';

@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule],
  controllers: [OrganizationController, PhysicalSiteController],
  providers: [
    OrganizationService,
    PhysicalSiteService,
    OrganizationIntegrityService,
    OrganizationArchivePolicyService,
    OrganizationAuthorizationInterceptor,
    AccessTokenGuard,
  ],
  exports: [OrganizationService, PhysicalSiteService],
})
export class OrganizationModule {}
