import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { EmployeeSchedulePatternService } from './employee-schedule-pattern.service.js';
import {
  ApplyScheduleTemplateDto,
  CreateSchedulePatternDto,
  CreateScheduleTemplateDto,
  EndSchedulePatternDto,
  GenerateScheduledShiftsDto,
  RecurrenceRuleDto,
  ScheduleTemplateListQueryDto,
  UpdateRecurrenceRuleDto,
  UpdateSchedulePatternDto,
  UpdateScheduleTemplateDto,
} from './schedule-recurrence.dto.js';
import { ScheduleTemplateService } from './schedule-template.service.js';
import { ShiftGenerationService } from './shift-generation.service.js';
import type { SchedulingRequestContext } from './scheduling.service.js';

function requestContext(
  identity: AuthenticatedIdentity,
  request: Request,
): SchedulingRequestContext {
  return {
    actorUserId: identity.userId,
    ipAddress: request.ip,
    userAgent: request.get('user-agent') ?? undefined,
    correlationId: request.get('x-correlation-id') ?? undefined,
  };
}

@Controller('schedule-templates')
@UseGuards(AccessTokenGuard)
export class ScheduleTemplateController {
  constructor(private readonly templates: ScheduleTemplateService) {}

  @Post()
  createTemplate(
    @Body() body: CreateScheduleTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.createTemplate(
      body,
      requestContext(identity, request),
    );
  }

  @Get()
  listTemplates(
    @Query() query: ScheduleTemplateListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.templates.listTemplates(identity.userId, query);
  }

  @Get(':templateId')
  getTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.templates.getTemplate(identity.userId, templateId);
  }

  @Patch(':templateId')
  updateTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: UpdateScheduleTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.updateTemplate(
      templateId,
      body,
      requestContext(identity, request),
    );
  }

  /** Only for templates never applied; referenced templates must be archived. */
  @Delete(':templateId')
  deleteTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.deleteTemplate(
      templateId,
      requestContext(identity, request),
    );
  }

  @Post(':templateId/archive')
  @HttpCode(200)
  archiveTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.archiveTemplate(
      templateId,
      requestContext(identity, request),
    );
  }

  @Post(':templateId/rules')
  createRule(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: RecurrenceRuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.createRule(
      templateId,
      body,
      requestContext(identity, request),
    );
  }

  @Patch(':templateId/rules/:ruleId')
  updateRule(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: UpdateRecurrenceRuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.updateRule(
      templateId,
      ruleId,
      body,
      requestContext(identity, request),
    );
  }

  @Delete(':templateId/rules/:ruleId')
  deleteRule(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.deleteRule(
      templateId,
      ruleId,
      requestContext(identity, request),
    );
  }
}

@Controller('employment-assignments/:assignmentId/schedule-patterns')
@UseGuards(AccessTokenGuard)
export class EmployeeSchedulePatternController {
  constructor(
    private readonly patterns: EmployeeSchedulePatternService,
    private readonly generation: ShiftGenerationService,
  ) {}

  @Post()
  createPattern(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: CreateSchedulePatternDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.createPattern(
      assignmentId,
      body,
      requestContext(identity, request),
    );
  }

  /** Copies a template's rotation and rules into a new pattern (no live inheritance). */
  @Post('from-template')
  applyTemplate(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: ApplyScheduleTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.applyTemplate(
      assignmentId,
      body,
      requestContext(identity, request),
    );
  }

  @Get()
  listPatterns(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.patterns.listPatterns(identity.userId, assignmentId);
  }

  @Get(':patternId')
  getPattern(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.patterns.getPattern(identity.userId, assignmentId, patternId);
  }

  /** Only before the pattern starts. */
  @Patch(':patternId')
  updatePattern(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @Body() body: UpdateSchedulePatternDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.updatePattern(
      assignmentId,
      patternId,
      body,
      requestContext(identity, request),
    );
  }

  @Post(':patternId/end')
  @HttpCode(200)
  endPattern(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @Body() body: EndSchedulePatternDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.endPattern(
      assignmentId,
      patternId,
      body,
      requestContext(identity, request),
    );
  }

  /**
   * Materializes the pattern's occurrences into DRAFT PATTERN shifts for the range (default:
   * today through the rolling horizon) and reconciles untouched generated drafts. Idempotent.
   */
  @Post(':patternId/generate')
  @HttpCode(200)
  generateShifts(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @Body() body: GenerateScheduledShiftsDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.generation.generateForPattern(
      assignmentId,
      patternId,
      body,
      requestContext(identity, request),
    );
  }

  /** Only before the pattern starts. */
  @Delete(':patternId')
  deletePattern(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.deletePattern(
      assignmentId,
      patternId,
      requestContext(identity, request),
    );
  }

  @Post(':patternId/rules')
  createRule(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @Body() body: RecurrenceRuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.createRule(
      assignmentId,
      patternId,
      body,
      requestContext(identity, request),
    );
  }

  @Patch(':patternId/rules/:ruleId')
  updateRule(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: UpdateRecurrenceRuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.updateRule(
      assignmentId,
      patternId,
      ruleId,
      body,
      requestContext(identity, request),
    );
  }

  @Delete(':patternId/rules/:ruleId')
  deleteRule(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('patternId', ParseUUIDPipe) patternId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.patterns.deleteRule(
      assignmentId,
      patternId,
      ruleId,
      requestContext(identity, request),
    );
  }
}
