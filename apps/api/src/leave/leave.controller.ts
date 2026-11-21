import {
  Body,
  Controller,
  Delete,
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
import { LeaveConfigService } from './leave-config.service.js';
import { LeaveLedgerService } from './leave-ledger.service.js';
import { LeaveRequestService } from './leave-request.service.js';
import { LeaveSelfCalendarService } from './leave-self-calendar.service.js';
import { LeaveViewService } from './leave-view.service.js';
import {
  AmendLeaveDto,
  ApproveLeaveDto,
  CancelOwnLeaveDto,
  CreateLeaveOnBehalfDto,
  CreateLeavePolicyDto,
  CreateLeaveTypeDto,
  EndLeavePolicyDto,
  LeaveAdjustmentDto,
  LeaveBalanceQueryDto,
  LeaveCalendarQueryDto,
  LeavePolicyListQueryDto,
  LeaveRequestInputDto,
  LeaveRequestListQueryDto,
  LeaveSelfRangeQueryDto,
  LeaveTypeListQueryDto,
  MyLeaveRequestsQueryDto,
  RejectLeaveDto,
  ResolveLeavePolicyQueryDto,
  ReverseLedgerEntryDto,
  UpdateLeavePolicyDto,
  UpdateLeaveTypeDto,
} from './leave.dto.js';

/** Employee self-service: the signed-in employee's leave across all their assignments. */
@Controller('leave/me')
@UseGuards(AccessTokenGuard)
export class LeaveSelfController {
  constructor(
    private readonly views: LeaveViewService,
    private readonly requests: LeaveRequestService,
    private readonly ledger: LeaveLedgerService,
    private readonly selfCalendar: LeaveSelfCalendarService,
  ) {}

  @Get()
  overview(@AuthUser() identity: AuthenticatedIdentity) {
    return this.views.me(identity.userId);
  }

  /** Batch 6B (D4): the viewer's team, day by day — names and "Absent" only. */
  @Get('team-calendar')
  teamCalendar(
    @Query() query: LeaveSelfRangeQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.selfCalendar.teamCalendar(identity.userId, query);
  }

  /** Batch 6B (D6): holidays that apply to the viewer's own assignments. */
  @Get('holidays')
  holidays(
    @Query() query: LeaveSelfRangeQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.selfCalendar.holidays(identity.userId, query);
  }

  @Get('requests')
  myRequests(
    @Query() query: MyLeaveRequestsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.myRequests(identity.userId, query);
  }

  @Post('requests/preview')
  preview(
    @Body() body: LeaveRequestInputDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.requests.previewOwn(identity.userId, body);
  }

  @Post('requests')
  submit(
    @Body() body: LeaveRequestInputDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.requests.submitOwn(
      identity.userId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('requests/:requestId')
  detail(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.requestDetail(identity.userId, requestId);
  }

  @Post('requests/:requestId/cancel')
  cancel(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: CancelOwnLeaveDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.requests.cancelOwn(
      identity.userId,
      requestId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('accounts/:accountId/ledger')
  ledgerHistory(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.ledger.ledger(identity.userId, accountId);
  }
}

/** Manager / admin leave operations, scoped through each assignment's position. */
@Controller('leave')
@UseGuards(AccessTokenGuard)
export class LeaveManagementController {
  constructor(
    private readonly views: LeaveViewService,
    private readonly requests: LeaveRequestService,
    private readonly ledger: LeaveLedgerService,
  ) {}

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.views.organizations(identity.userId);
  }

  @Get('requests')
  queue(
    @Query() query: LeaveRequestListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.queue(identity.userId, query);
  }

  @Post('requests/preview')
  preview(
    @Body() body: LeaveRequestInputDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.requests.previewForAssignment(identity.userId, body);
  }

  @Post('requests')
  createOnBehalf(
    @Body() body: CreateLeaveOnBehalfDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.requests.createOnBehalf(
      identity.userId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('requests/:requestId')
  detail(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.requestDetail(identity.userId, requestId);
  }

  @Post('requests/:requestId/approve')
  approve(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: ApproveLeaveDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.requests.approve(
      identity.userId,
      requestId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('requests/:requestId/reject')
  reject(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: RejectLeaveDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.requests.reject(
      identity.userId,
      requestId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('requests/:requestId/amend')
  amend(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: AmendLeaveDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.requests.amend(
      identity.userId,
      requestId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('balances')
  balances(
    @Query() query: LeaveBalanceQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.balances(identity.userId, query);
  }

  @Get('accounts/:accountId/ledger')
  ledgerHistory(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.ledger.ledger(identity.userId, accountId);
  }

  @Post('adjustments')
  adjust(
    @Body() body: LeaveAdjustmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.ledger.adjust(body, domainRequestContext(identity, request));
  }

  @Post('ledger-entries/:entryId/reverse')
  reverse(
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() body: ReverseLedgerEntryDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.ledger.reverse(
      entryId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('calendar')
  calendar(
    @Query() query: LeaveCalendarQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.calendar(identity.userId, query);
  }
}

/** Leave types (organization catalog) and effective-dated leave policies. */
@Controller('leave')
@UseGuards(AccessTokenGuard)
export class LeaveConfigController {
  constructor(private readonly config: LeaveConfigService) {}

  @Get('types')
  listTypes(
    @Query() query: LeaveTypeListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.listTypes(identity.userId, query);
  }

  @Post('types')
  createType(
    @Body() body: CreateLeaveTypeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.createType(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('types/:typeId')
  updateType(
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Body() body: UpdateLeaveTypeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.updateType(
      typeId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('types/:typeId/archive')
  archiveType(
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.archiveType(
      typeId,
      domainRequestContext(identity, request),
    );
  }

  @Get('policies')
  listPolicies(
    @Query() query: LeavePolicyListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.listPolicies(identity.userId, query);
  }

  @Get('policies/resolve')
  resolvePolicy(
    @Query() query: ResolveLeavePolicyQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.resolvePolicy(identity.userId, query);
  }

  @Post('policies')
  createPolicy(
    @Body() body: CreateLeavePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.createPolicy(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('policies/:policyId')
  getPolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.config.getPolicy(identity.userId, policyId);
  }

  @Patch('policies/:policyId')
  updatePolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: UpdateLeavePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.updatePolicy(
      policyId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('policies/:policyId/end')
  endPolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: EndLeavePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.endPolicy(
      policyId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Delete('policies/:policyId')
  deletePolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.config.deletePolicy(
      policyId,
      domainRequestContext(identity, request),
    );
  }
}
