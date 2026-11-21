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
import { BenefitDependentService } from './benefit-dependent.service.js';
import { BenefitEnrollmentService } from './benefit-enrollment.service.js';
import {
  AsOfQueryDto,
  AttentionQueryDto,
  ChangeElectionDto,
  CorrectElectionDto,
  CreateDependentDto,
  DiscontinuePlanDto,
  EndElectionDto,
  EnrollDto,
  IncludeArchivedQueryDto,
  RescindElectionDto,
  TransferElectionDto,
  UpdateDependentDto,
  WaiveDto,
} from './benefits.dto.js';
import { BenefitsConstraintFilter } from './benefits-constraint.filter.js';

/**
 * Employees' benefit elections and dependents: reads with benefit.read on the sponsoring
 * assignment(s), writes with benefit.manage (never one's own). Self-service (/benefits/me) is
 * read-only and authorized by the caller's identity alone. No DELETE: elections are ended or
 * superseded, dependents archived.
 */
@Controller('benefits')
@UseGuards(AccessTokenGuard)
@UseFilters(BenefitsConstraintFilter)
export class BenefitElectionController {
  constructor(
    private readonly enrollments: BenefitEnrollmentService,
    private readonly dependents: BenefitDependentService,
  ) {}

  @Get('me')
  mine(@AuthUser() identity: AuthenticatedIdentity) {
    return this.enrollments.mine(identity.userId);
  }

  @Get('me/dependents')
  myDependents(@AuthUser() identity: AuthenticatedIdentity) {
    return this.dependents.mine(identity.userId);
  }

  @Get('employees/:employeeId/elections')
  employee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: AsOfQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.enrollments.employee(identity.userId, employeeId, query.asOf);
  }

  @Post('elections/enroll')
  enroll(
    @Body() body: EnrollDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.enroll(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('elections/waive')
  waive(
    @Body() body: WaiveDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.waive(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('employees/:employeeId/dependents')
  listDependents(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: IncludeArchivedQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.dependents.list(
      identity.userId,
      employeeId,
      query.includeArchived ?? false,
    );
  }

  @Post('employees/:employeeId/dependents')
  addDependent(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() body: CreateDependentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.dependents.create(
      employeeId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('dependents/:dependentId')
  updateDependent(
    @Param('dependentId', ParseUUIDPipe) dependentId: string,
    @Body() body: UpdateDependentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.dependents.update(
      dependentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('dependents/:dependentId/archive')
  archiveDependent(
    @Param('dependentId', ParseUUIDPipe) dependentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.dependents.archive(
      dependentId,
      domainRequestContext(identity, request),
    );
  }

  @Post('elections/:enrollmentId/change')
  change(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Body() body: ChangeElectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.change(
      enrollmentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('elections/:enrollmentId/end')
  end(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Body() body: EndElectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.end(
      enrollmentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('elections/:enrollmentId/transfer')
  transfer(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Body() body: TransferElectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.transfer(
      enrollmentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('elections/:enrollmentId/correct')
  correct(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Body() body: CorrectElectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.correct(
      enrollmentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('elections/:enrollmentId/rescind')
  rescind(
    @Param('enrollmentId', ParseUUIDPipe) enrollmentId: string,
    @Body() body: RescindElectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.rescind(
      enrollmentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('plans/:planId/discontinue')
  discontinue(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: DiscontinuePlanDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.enrollments.discontinuePlan(
      planId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('attention')
  attention(
    @Query() query: AttentionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.enrollments.attention(identity.userId, query.organizationId);
  }
}
