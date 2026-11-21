import {
  Body,
  Controller,
  Get,
  Param,
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
import { domainRequestContext } from '../calendar/holiday.controller.js';
import { PerformanceAccessService } from './performance-access.service.js';
import { PerformanceConfigService } from './performance-config.service.js';
import { PerformanceOptionsService } from './performance-options.service.js';
import {
  CopyTemplateDto,
  CreateCompetencyDto,
  CreateRatingScaleDto,
  CreateTemplateDto,
  PerformanceOptionQueryDto,
  PerformanceOrganizationQueryDto,
  ScaleLevelDto,
  UpdateCompetencyDto,
  UpdateRatingScaleDto,
  UpdateTemplateDto,
} from './performance.dto.js';

const levelInput = (level: ScaleLevelDto) => ({
  value: level.value,
  label: level.label,
  description: level.description ?? null,
});

/**
 * Performance configuration: reads with any performance permission in the organization,
 * writes with performance.template.manage at the organization. No DELETE: archived instead.
 */
@Controller('performance')
@UseGuards(AccessTokenGuard)
export class PerformanceConfigController {
  constructor(
    private readonly config: PerformanceConfigService,
    private readonly access: PerformanceAccessService,
    private readonly optionsService: PerformanceOptionsService,
  ) {}

  /** Batch 7B (D7) — picker options: people, assignments, reviewers and structures. */
  @Get('options')
  options(
    @Query() query: PerformanceOptionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.optionsService.options(identity.userId, query);
  }

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.access.organizations(identity.userId);
  }

  @Get('competencies')
  competencies(
    @Query() query: PerformanceOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.competencies(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Post('competencies')
  createCompetency(
    @Body() body: CreateCompetencyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.createCompetency(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('competencies/:id')
  updateCompetency(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCompetencyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.updateCompetency(
      id,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('competencies/:id/archive')
  archiveCompetency(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.archiveCompetency(
      id,
      domainRequestContext(identity, request),
    );
  }

  @Get('rating-scales')
  scales(
    @Query() query: PerformanceOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.scales(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Post('rating-scales')
  createScale(
    @Body() body: CreateRatingScaleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.createScale(
      {
        organizationId: body.organizationId,
        code: body.code,
        name: body.name,
        description: body.description,
        levels: body.levels.map(levelInput),
      },
      domainRequestContext(identity, request),
    );
  }

  @Patch('rating-scales/:id')
  updateScale(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRatingScaleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.updateScale(
      id,
      {
        name: body.name,
        description: body.description,
        levels: body.levels?.map(levelInput),
      },
      domainRequestContext(identity, request),
    );
  }

  @Post('rating-scales/:id/activate')
  activateScale(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.transitionScale(
      id,
      'ACTIVE',
      domainRequestContext(identity, request),
    );
  }

  @Post('rating-scales/:id/archive')
  archiveScale(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.transitionScale(
      id,
      'ARCHIVED',
      domainRequestContext(identity, request),
    );
  }

  @Get('templates')
  templates(
    @Query() query: PerformanceOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.templates(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Get('templates/:id')
  template(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.template(identity.userId, id);
  }

  @Post('templates')
  createTemplate(
    @Body() body: CreateTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.createTemplate(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('templates/:id')
  updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.updateTemplate(
      id,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('templates/:id/activate')
  activateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.transitionTemplate(
      id,
      'ACTIVE',
      domainRequestContext(identity, request),
    );
  }

  @Post('templates/:id/archive')
  archiveTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.transitionTemplate(
      id,
      'ARCHIVED',
      domainRequestContext(identity, request),
    );
  }

  @Post('templates/:id/copy')
  copyTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CopyTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.copyTemplate(
      id,
      body,
      domainRequestContext(identity, request),
    );
  }
}
