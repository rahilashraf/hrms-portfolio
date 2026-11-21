import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import {
  PayrollAdjustmentService,
  type ManualLineKind,
} from './payroll-adjustment.service.js';
import { PayrollLifecycleService } from './payroll-lifecycle.service.js';
import { PayrollReadService } from './payroll-read.service.js';
import { PayrollRunService } from './payroll-run.service.js';
import {
  AddManualLineDto,
  CreatePayrollAdjustmentDto,
  CreatePayrollRunDto,
  PayrollAdjustmentListQueryDto,
  PayrollReasonDto,
  ResolveBenefitDifferenceDto,
  PayrollRunListQueryDto,
  ReverseManualLineDto,
} from './payroll.dto.js';

/**
 * Payroll runs: creation and voiding (payroll.manage), calculation and recalculation
 * (payroll.calculate), approval (payroll.approve), finalization (payroll.finalize), manual lines
 * and retroactive corrections (payroll.adjust), freshness and read models (payroll.read), all in
 * the run's organization.
 */
@Controller('payroll/runs')
@UseGuards(AccessTokenGuard)
export class PayrollRunController {
  constructor(
    private readonly runs: PayrollRunService,
    private readonly reads: PayrollReadService,
    private readonly lifecycle: PayrollLifecycleService,
    private readonly adjustments: PayrollAdjustmentService,
  ) {}

  @Get()
  list(
    @Query() query: PayrollRunListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.reads.runs(identity.userId, query);
  }

  @Post()
  async create(
    @Body() body: CreatePayrollRunDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    const run = await this.runs.createRun(
      body,
      domainRequestContext(identity, request),
    );
    return this.reads.run(identity.userId, run.id);
  }

  @Get(':id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.reads.run(identity.userId, id);
  }

  @Get(':id/issues')
  issues(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.reads.issues(identity.userId, id);
  }

  @Get(':id/employees/:runEmployeeId')
  employee(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runEmployeeId', ParseUUIDPipe) runEmployeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.reads.runEmployee(identity.userId, id, runEmployeeId);
  }

  @Get(':id/freshness')
  freshness(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.runs.freshness(id, identity.userId);
  }

  @Post(':id/calculate')
  async calculate(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    await this.runs.calculate(id, domainRequestContext(identity, request));
    return this.reads.run(identity.userId, id);
  }

  @Post(':id/approve')
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    await this.lifecycle.approve(id, domainRequestContext(identity, request));
    return this.reads.run(identity.userId, id);
  }

  @Post(':id/finalize')
  async finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    await this.lifecycle.finalize(id, domainRequestContext(identity, request));
    return this.reads.run(identity.userId, id);
  }

  @Post(':id/void')
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayrollReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    await this.lifecycle.void(
      id,
      body.reason,
      domainRequestContext(identity, request),
    );
    return this.reads.run(identity.userId, id);
  }

  @Get(':id/statutory')
  statutory(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.lifecycle.statutoryStatus(id, identity.userId);
  }

  @Post(':id/manual-lines')
  async addManualLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddManualLineDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    await this.adjustments.addManualLine(
      id,
      body,
      domainRequestContext(identity, request),
    );
    return this.reads.run(identity.userId, id);
  }

  @Post(':id/manual-lines/:lineId/reverse')
  async reverseManualLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: ReverseManualLineDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    await this.adjustments.reverseManualLine(
      id,
      { lineId, kind: body.kind as ManualLineKind, reason: body.reason },
      domainRequestContext(identity, request),
    );
    return this.reads.run(identity.userId, id);
  }

  @Get(':id/retro-preview')
  retroPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.adjustments.retroPreview(id, identity.userId);
  }

  @Post(':id/retro-adjustments')
  retroAdjustments(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayrollReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.adjustments.createRetroAdjustments(
      id,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  /** Batch 7C (C2): a person resolves a benefit-only difference explicitly. */
  @Post(':id/retro-benefit-resolutions')
  resolveBenefitDifference(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveBenefitDifferenceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.adjustments.resolveBenefitDifference(
      id,
      body,
      domainRequestContext(identity, request),
    );
  }
}

/** Pending and historical payroll adjustments (read: payroll.read; write: payroll.adjust). */
@Controller('payroll/adjustments')
@UseGuards(AccessTokenGuard)
export class PayrollAdjustmentController {
  constructor(private readonly adjustments: PayrollAdjustmentService) {}

  @Get()
  list(
    @Query() query: PayrollAdjustmentListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.adjustments.listAdjustments(identity.userId, query);
  }

  @Post()
  create(
    @Body() body: CreatePayrollAdjustmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.adjustments.createAdjustment(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayrollReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.adjustments.cancelAdjustment(
      id,
      body.reason,
      domainRequestContext(identity, request),
    );
  }
}
