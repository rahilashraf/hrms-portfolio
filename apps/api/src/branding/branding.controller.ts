import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
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
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';
import { BrandingUpdateDto, PublicBrandingQueryDto } from './branding.dto.js';
import { BrandingService } from './branding.service.js';

/** Phase 20 — an organization's branding (authorized in the service). */
@Controller('organizations/:organizationId/branding')
@UseGuards(AccessTokenGuard)
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.branding.get(identity.userId, organizationId);
  }

  @Put()
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: BrandingUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.branding.update(
      organizationId,
      body,
      domainRequestContext(identity, request),
    );
  }
}

/**
 * Phase 20 — the PUBLIC login-page branding (no authentication). Returns only the public
 * fields of an organization that opted in (publicLoginEnabled), else generic defaults. Rate
 * limited by address (fail open: it is cheap, read-only and reveals nothing). It is the only
 * route that overrides the API-wide `Cache-Control: no-store`, with a short public max-age:
 * the body is identical for every caller and never personal.
 */
@Controller('public/branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @RateLimit(...RATE_LIMITS.publicBranding)
  @Header('Cache-Control', 'public, max-age=60')
  get(@Query() query: PublicBrandingQueryDto) {
    return this.branding.publicBranding(query.organization);
  }
}
