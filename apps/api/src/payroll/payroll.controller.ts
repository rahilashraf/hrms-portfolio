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
import { PayrollAccessService } from './payroll-access.service.js';
import { PayrollCalendarService } from './payroll-calendar.service.js';
import { PayrollTimeOrchestrationService } from './payroll-time-orchestration.service.js';
import {
  CreatePayrollCalendarDto,
  EndPayrollCalendarDto,
  GeneratePayrollPeriodsDto,
  PayrollOrganizationQueryDto,
  PayrollPeriodListQueryDto,
  SalaryUnpaidLeaveRuleDto,
  UpdatePayrollCalendarDto,
} from './payroll.dto.js';

/**
 * Payroll configuration: the organizations a user administers payroll in, pay groups (read;
 * Compensation owns their records), payroll calendars and pay periods. Organization-scoped
 * payroll.* permissions only.
 */
@Controller('payroll')
@UseGuards(AccessTokenGuard)
export class PayrollConfigurationController {
  constructor(
    private readonly access: PayrollAccessService,
    private readonly calendars: PayrollCalendarService,
    private readonly timeOrchestration: PayrollTimeOrchestrationService,
  ) {}

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.access.organizations(identity.userId);
  }

  @Get('pay-groups')
  payGroups(
    @Query() query: PayrollOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.calendars.payGroups(identity.userId, query.organizationId);
  }

  /** Batch 6A: the pay group's paid assignments (the adjustment picker). */
  @Get('pay-groups/:id/members')
  payGroupMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.calendars.payGroupMembers(identity.userId, id);
  }

  @Get('calendars')
  listCalendars(
    @Query() query: PayrollOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.calendars.calendars(identity.userId, query);
  }

  @Post('calendars')
  createCalendar(
    @Body() body: CreatePayrollCalendarDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.calendars.createCalendar(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('calendars/:id')
  updateCalendar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePayrollCalendarDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.calendars.updateCalendar(
      id,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('calendars/:id/end')
  endCalendar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EndPayrollCalendarDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.calendars.endCalendar(
      id,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('periods')
  listPeriods(
    @Query() query: PayrollPeriodListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.calendars.periods(identity.userId, query);
  }

  @Post('periods/generate')
  generatePeriods(
    @Body() body: GeneratePayrollPeriodsDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.calendars.generatePeriods(
      body,
      domainRequestContext(identity, request),
    );
  }

  /** Asks Time to materialize the period's timesheets for the pay group's employees. */
  @Post('periods/:id/materialize-timesheets')
  materializeTimesheets(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.timeOrchestration.materialize(
      id,
      domainRequestContext(identity, request),
    );
  }

  @Post('calendars/:id/salary-unpaid-leave-rule')
  setSalaryUnpaidLeaveRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SalaryUnpaidLeaveRuleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.calendars.setSalaryUnpaidLeaveRule(
      id,
      body,
      domainRequestContext(identity, request),
    );
  }
}
