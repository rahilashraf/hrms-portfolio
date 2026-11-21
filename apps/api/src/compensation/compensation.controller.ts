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
import { CompensationService } from './compensation.service.js';
import {
  ChangeCompensationDto,
  CompensationAsOfQueryDto,
  CompensationDateQueryDto,
  CorrectCompensationDto,
  CreateCompensationDto,
  CreatePayGroupDto,
  EndCompensationDto,
  PayGroupListQueryDto,
  UpdatePayGroupDto,
} from './compensation.dto.js';
import { PayGroupService } from './pay-group.service.js';

/**
 * An employment assignment's compensation: history, current and as-of reads (compensation.read
 * in scope, or one's own) and the write workflows (compensation.manage in scope, never one's
 * own). There is deliberately no DELETE: history is only ever closed, superseded or corrected.
 */
@Controller('employment-assignments/:assignmentId/compensation')
@UseGuards(AccessTokenGuard)
export class AssignmentCompensationController {
  constructor(private readonly compensation: CompensationService) {}

  @Get()
  history(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.compensation.history(identity.userId, assignmentId);
  }

  @Get('current')
  current(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Query() query: CompensationDateQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.compensation.current(identity.userId, assignmentId, query.date);
  }

  @Get('as-of')
  asOf(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Query() query: CompensationAsOfQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.compensation.asOf(identity.userId, assignmentId, query.date);
  }

  @Post()
  create(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: CreateCompensationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.compensation.create(
      assignmentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('change')
  change(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: ChangeCompensationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.compensation.change(
      assignmentId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch(':recordId/correction')
  correct(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() body: CorrectCompensationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.compensation.correct(
      assignmentId,
      recordId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post(':recordId/end')
  end(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body() body: EndCompensationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.compensation.end(
      assignmentId,
      recordId,
      body,
      domainRequestContext(identity, request),
    );
  }
}

/** Employee self-service (read-only) and the compensation part of an employee profile. */
@Controller('compensation')
@UseGuards(AccessTokenGuard)
export class CompensationController {
  constructor(private readonly compensation: CompensationService) {}

  @Get('me')
  me(@AuthUser() identity: AuthenticatedIdentity) {
    return this.compensation.me(identity.userId);
  }

  @Get('employees/:employeeId')
  employee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.compensation.employee(identity.userId, employeeId);
  }
}

/** An organization's pay groups (minimal; ahead of Phase 10 Payroll). */
@Controller('pay-groups')
@UseGuards(AccessTokenGuard)
export class PayGroupController {
  constructor(private readonly payGroups: PayGroupService) {}

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.payGroups.organizations(identity.userId);
  }

  @Get()
  list(
    @Query() query: PayGroupListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.payGroups.list(identity.userId, query);
  }

  @Post()
  create(
    @Body() body: CreatePayGroupDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.payGroups.create(body, domainRequestContext(identity, request));
  }

  @Patch(':payGroupId')
  update(
    @Param('payGroupId', ParseUUIDPipe) payGroupId: string,
    @Body() body: UpdatePayGroupDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.payGroups.update(
      payGroupId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post(':payGroupId/archive')
  archive(
    @Param('payGroupId', ParseUUIDPipe) payGroupId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.payGroups.archive(
      payGroupId,
      domainRequestContext(identity, request),
    );
  }
}
