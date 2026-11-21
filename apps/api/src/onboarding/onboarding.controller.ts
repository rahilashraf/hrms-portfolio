import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { OnboardingAccessService } from './onboarding-access.service.js';
import { OnboardingOptionsService } from './onboarding-options.service.js';
import { OnboardingTaskService } from './onboarding-task.service.js';
import { OnboardingTemplateService } from './onboarding-template.service.js';
import { OnboardingWorkflowService } from './onboarding-workflow.service.js';
import {
  AcknowledgeTaskDto,
  CompleteTaskDto,
  CreateTemplateDto,
  DueDateDto,
  ImportCompletionsDto,
  MyTasksQueryDto,
  OnboardingOptionQueryDto,
  OrganizationKindQueryDto,
  ReassignTaskDto,
  RequiredReasonDto,
  StartFromHireDto,
  StartOffboardingDto,
  StartOnboardingDto,
  UpdateTemplateDto,
} from './onboarding.dto.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';

/**
 * Phase 14 — onboarding and offboarding. Every route is authenticated; authorization
 * (onboarding.* / offboarding.* on the assignment, organization-level templates, the
 * employee's own workflows, task owners' own tasks) is decided in the services.
 */
@Controller('onboarding')
@UseGuards(AccessTokenGuard)
export class OnboardingController {
  constructor(
    private readonly access: OnboardingAccessService,
    private readonly templates: OnboardingTemplateService,
    private readonly workflows: OnboardingWorkflowService,
    private readonly tasks: OnboardingTaskService,
    private readonly optionsService: OnboardingOptionsService,
  ) {}

  /** Batch 7A — picker options: task owners, assignments to start on, hires to onboard. */
  @Get('options')
  options(
    @Query() query: OnboardingOptionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.optionsService.options(identity.userId, query);
  }

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.access.organizations(identity.userId);
  }

  // ─── Self-service ─────────────────────────────────────────────────────────

  @Get('me')
  mine(@AuthUser() identity: AuthenticatedIdentity) {
    return this.workflows.mine(identity.userId);
  }

  @Get('me/tasks')
  myTasks(
    @Query() query: MyTasksQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.workflows.myTasks(identity.userId, query.includeDone);
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  @Get('templates')
  listTemplates(
    @Query() query: OrganizationKindQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.templates.list(
      identity.userId,
      query.organizationId,
      query.kind,
    );
  }

  @Post('templates')
  createTemplate(
    @Body() body: CreateTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.create(body, domainRequestContext(identity, request));
  }

  @Patch('templates/:templateId')
  updateTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: UpdateTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.update(
      templateId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('templates/:templateId/activate')
  activateTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.activate(
      templateId,
      domainRequestContext(identity, request),
    );
  }

  @Post('templates/:templateId/archive')
  archiveTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.archive(
      templateId,
      domainRequestContext(identity, request),
    );
  }

  @Post('templates/:templateId/default')
  defaultTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.setDefault(
      templateId,
      domainRequestContext(identity, request),
    );
  }

  // ─── Workflows ────────────────────────────────────────────────────────────

  @Get('workflows')
  dashboard(
    @Query() query: OrganizationKindQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.workflows.dashboard(
      identity.userId,
      query.organizationId,
      query.kind ?? 'ONBOARDING',
      query.includeClosed,
    );
  }

  @Get('employees/:employeeId/workflows')
  employeeWorkflows(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.workflows.employeeWorkflows(identity.userId, employeeId);
  }

  @Post('workflows/onboarding')
  startOnboarding(
    @Body() body: StartOnboardingDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.workflows.start(
      'ONBOARDING',
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('workflows/offboarding')
  startOffboarding(
    @Body() body: StartOffboardingDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.workflows.start(
      'OFFBOARDING',
      body,
      domainRequestContext(identity, request),
    );
  }

  /** Hand-off from a Phase 13 hire conversion (idempotent per hire). */
  @Post('from-hire/:hireId')
  startFromHire(
    @Param('hireId', ParseUUIDPipe) hireId: string,
    @Body() body: StartFromHireDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.workflows.startFromHire(
      hireId,
      body.templateId,
      domainRequestContext(identity, request),
    );
  }

  @Get('workflows/:workflowId')
  workflow(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.workflows.detail(identity.userId, workflowId);
  }

  @Post('workflows/:workflowId/cancel')
  cancel(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.workflows.cancel(
      workflowId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  @Post('workflows/:workflowId/complete')
  complete(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.workflows.complete(
      workflowId,
      domainRequestContext(identity, request),
    );
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────

  @Post('tasks/:taskId/start')
  startTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.tasks.start(taskId, domainRequestContext(identity, request));
  }

  @Post('tasks/:taskId/complete')
  completeTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: CompleteTaskDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.tasks.complete(
      taskId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('tasks/:taskId/acknowledge')
  acknowledgeTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: AcknowledgeTaskDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.tasks.acknowledge(
      taskId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('tasks/:taskId/waive')
  waiveTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.tasks.waive(
      taskId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  @Post('tasks/:taskId/reopen')
  reopenTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.tasks.reopen(
      taskId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  @Put('tasks/:taskId/owner')
  reassignTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: ReassignTaskDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.tasks.reassign(
      taskId,
      body.ownerUserId,
      domainRequestContext(identity, request),
    );
  }

  @Put('tasks/:taskId/due-date')
  dueDate(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: DueDateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.tasks.setDueDate(
      taskId,
      body.dueDate,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  /** The external-completion contract (e.g. Google Form responses), imported by HR. */
  @Post('task-completions/import')
  @RateLimit(...RATE_LIMITS.intakeImport)
  importCompletions(
    @Body() body: ImportCompletionsDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.tasks.completeFromSubmissions(
      body.organizationId,
      body.referenceType,
      body.submissions,
      identity.userId,
    );
  }
}
