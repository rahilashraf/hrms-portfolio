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
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { domainRequestContext } from '../calendar/holiday.controller.js';
import { BenefitEligibilityService } from './benefit-eligibility.service.js';
import { BenefitOptionsService } from './benefit-options.service.js';
import { BenefitPlanService } from './benefit-plan.service.js';
import { BenefitRateService } from './benefit-rate.service.js';
import { BenefitsAccessService } from './benefits-access.service.js';
import {
  BenefitDateQueryDto,
  BenefitOptionQueryDto,
  BenefitOrganizationQueryDto,
  CorrectBenefitRateDto,
  CreateEligibilityRuleDto,
  EndEligibilityRuleDto,
  CreateBenefitOptionDto,
  CreateBenefitRateDto,
  CreateBenefitPlanDto,
  UpdateBenefitOptionDto,
  UpdateBenefitPlanDto,
} from './benefits.dto.js';
import { BenefitsConstraintFilter } from './benefits-constraint.filter.js';

/**
 * Benefit plan configuration: reads with any benefit permission in the organization, writes
 * with benefit.plan.manage at the organization. No DELETE: plans and options are archived.
 */
@Controller('benefits')
@UseGuards(AccessTokenGuard)
@UseFilters(BenefitsConstraintFilter)
export class BenefitPlanController {
  constructor(
    private readonly plans: BenefitPlanService,
    private readonly access: BenefitsAccessService,
    private readonly rates: BenefitRateService,
    private readonly eligibility: BenefitEligibilityService,
    private readonly optionsService: BenefitOptionsService,
  ) {}

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.access.organizations(identity.userId);
  }

  /** Batch 7C (C7) — picker options: assignments and organization structures. */
  @Get('options')
  options(
    @Query() query: BenefitOptionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.optionsService.options(identity.userId, query);
  }

  @Get('plans')
  list(
    @Query() query: BenefitOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.plans.list(identity.userId, query);
  }

  @Post('plans')
  create(
    @Body() body: CreateBenefitPlanDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.create(body, domainRequestContext(identity, request));
  }

  @Get('plans/:planId')
  detail(
    @Param('planId', ParseUUIDPipe) planId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.plans.detail(identity.userId, planId);
  }

  @Patch('plans/:planId')
  update(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: UpdateBenefitPlanDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.update(
      planId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('plans/:planId/activate')
  activate(
    @Param('planId', ParseUUIDPipe) planId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.transition(
      planId,
      'ACTIVE',
      domainRequestContext(identity, request),
    );
  }

  @Post('plans/:planId/close')
  close(
    @Param('planId', ParseUUIDPipe) planId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.transition(
      planId,
      'CLOSED',
      domainRequestContext(identity, request),
    );
  }

  @Post('plans/:planId/archive')
  archive(
    @Param('planId', ParseUUIDPipe) planId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.archive(planId, domainRequestContext(identity, request));
  }

  @Post('plans/:planId/options')
  addOption(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: CreateBenefitOptionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.addOption(
      planId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('options/:optionId')
  updateOption(
    @Param('optionId', ParseUUIDPipe) optionId: string,
    @Body() body: UpdateBenefitOptionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.updateOption(
      optionId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('options/:optionId/archive')
  archiveOption(
    @Param('optionId', ParseUUIDPipe) optionId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.plans.archiveOption(
      optionId,
      domainRequestContext(identity, request),
    );
  }

  @Post('options/:optionId/rates')
  addRate(
    @Param('optionId', ParseUUIDPipe) optionId: string,
    @Body() body: CreateBenefitRateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.rates.addRate(
      optionId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('rates/:rateId/correct')
  correctRate(
    @Param('rateId', ParseUUIDPipe) rateId: string,
    @Body() body: CorrectBenefitRateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.rates.correctRate(
      rateId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('plans/:planId/eligibility-rules')
  addRule(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: CreateEligibilityRuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.eligibility.addRule(
      planId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('eligibility-rules/:ruleId/end')
  endRule(
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: EndEligibilityRuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.eligibility.endRule(
      ruleId,
      body.effectiveTo,
      domainRequestContext(identity, request),
    );
  }

  @Get('assignments/:assignmentId/eligibility')
  assignmentEligibility(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Query() query: BenefitDateQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.eligibility.forAssignment(
      identity.userId,
      assignmentId,
      query.date,
    );
  }

  /** Self-service: the caller's own eligible plans (identity only, no permission). */
  @Get('me/eligibility')
  myEligibility(
    @Query() query: BenefitDateQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.eligibility.mine(identity.userId, query.date);
  }
}
