import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import {
  BrandingController,
  PublicBrandingController,
} from './branding.controller.js';
import { BrandingService } from './branding.service.js';

@Module({
  imports: [AuditModule, AuthModule, AuthorizationModule],
  controllers: [BrandingController, PublicBrandingController],
  providers: [BrandingService, AccessTokenGuard],
  exports: [BrandingService],
})
export class BrandingModule {}
