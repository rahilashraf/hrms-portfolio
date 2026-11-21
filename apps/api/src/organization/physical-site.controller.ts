import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import {
  PhysicalSiteCreateDto,
  PhysicalSiteUpdateDto,
} from './organization.dto.js';
import { PhysicalSiteService } from './physical-site.service.js';

/** Batch 5B (D12): physical sites of an organization (authorization in the service). */
@Controller('organizations/:organizationId/physical-sites')
@UseGuards(AccessTokenGuard)
export class PhysicalSiteController {
  constructor(private readonly sites: PhysicalSiteService) {}

  private context(identity: AuthenticatedIdentity, request: Request) {
    return {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    };
  }

  @Get()
  list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query('includeArchived', new DefaultValuePipe(false), ParseBoolPipe)
    includeArchived: boolean,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.sites.list(organizationId, identity.userId, includeArchived);
  }

  @Get(':id')
  get(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.sites.get(organizationId, id, identity.userId);
  }

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: PhysicalSiteCreateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.sites.create(
      organizationId,
      body,
      this.context(identity, request),
    );
  }

  @Patch(':id')
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PhysicalSiteUpdateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.sites.update(
      organizationId,
      id,
      body,
      this.context(identity, request),
    );
  }

  @Post(':id/archive')
  archive(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.sites.archive(
      organizationId,
      id,
      this.context(identity, request),
    );
  }

  @Post(':id/reactivate')
  reactivate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.sites.reactivate(
      organizationId,
      id,
      this.context(identity, request),
    );
  }
}
