import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { domainRequestContext } from '../calendar/holiday.controller.js';
import {
  FeatureHistoryQueryDto,
  FeatureOrganizationQueryDto,
  ResetSettingDto,
  SetModuleDto,
  SetSettingDto,
} from './features.dto.js';
import { FeaturesService } from './features.service.js';

/**
 * Phase 18 — organization feature management. Every route is authenticated and authorized in
 * the service (feature.read / feature.manage at organization scope). This API itself is never
 * feature-gated: it is how a disabled module is re-enabled.
 */
@Controller('admin/features')
@UseGuards(AccessTokenGuard)
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.features.organizations(identity.userId);
  }

  @Get()
  overview(
    @Query() query: FeatureOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.features.overview(identity.userId, query.organizationId);
  }

  @Get('history')
  history(
    @Query() query: FeatureHistoryQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.features.history(identity.userId, query.organizationId, query);
  }

  @Put('modules/:module')
  setModule(
    @Param('module') module: string,
    @Body() body: SetModuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.features.setModule(
      {
        organizationId: body.organizationId,
        module,
        enabled: body.enabled,
        expectedVersion: body.expectedVersion,
      },
      domainRequestContext(identity, request),
    );
  }

  @Put('settings/:key')
  setSetting(
    @Param('key') key: string,
    @Body() body: SetSettingDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.features.setSetting(
      {
        organizationId: body.organizationId,
        key,
        value: body.value,
        expectedVersion: body.expectedVersion,
        reason: body.reason,
        confirm: body.confirm,
      },
      domainRequestContext(identity, request),
    );
  }

  @Post('settings/:key/reset')
  resetSetting(
    @Param('key') key: string,
    @Body() body: ResetSettingDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.features.resetSetting(
      {
        organizationId: body.organizationId,
        key,
        expectedVersion: body.expectedVersion,
        reason: body.reason,
        confirm: body.confirm,
      },
      domainRequestContext(identity, request),
    );
  }
}
