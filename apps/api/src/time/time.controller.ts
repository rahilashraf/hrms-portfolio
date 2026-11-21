import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import {
  AddTimeEntryDto,
  ClockInDto,
  CreateTimeCorrectionRequestDto,
  DirectTimeCorrectionDto,
  GenerateTimePeriodsDto,
  LinkScheduledShiftDto,
  ResolveMissedClockOutDto,
  ReviewTimeCorrectionDto,
  ScheduledVsActualQueryDto,
  SwitchAssignmentDto,
  AssignmentAttendanceQueryDto,
  TimeCorrectionsQueryDto,
  TimeCurrentQueryDto,
  TimeEntriesQueryDto,
  TimeExceptionsQueryDto,
  TimeTimesheetsQueryDto,
  TimesheetReviewDto,
  ApproveTimesheetSegmentDto,
  ReopenTimesheetDto,
  SelfCorrectionsQueryDto,
  SelfExceptionsQueryDto,
  SubmitOwnTimesheetDto,
  SubmitTimesheetOnBehalfDto,
  TimesheetVersionDto,
  TimePeriodsQueryDto,
  ReviewAttendanceExceptionDto,
} from './time.dto.js';
import { ScheduleVarianceService } from './schedule-variance.service.js';
import { TimeService } from './time.service.js';

@Controller('time/me')
@UseGuards(AccessTokenGuard)
export class TimeController {
  constructor(private readonly time: TimeService) {}

  @Get('status')
  status(@AuthUser() identity: AuthenticatedIdentity) {
    return this.time.status(identity.userId);
  }

  @Get('exceptions')
  exceptions(
    @Query() query: SelfExceptionsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.exceptions(identity.userId, query);
  }

  @Get('corrections')
  corrections(
    @Query() query: SelfCorrectionsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.corrections(identity.userId, query);
  }

  @Get('entries')
  entries(
    @Query() query: TimeEntriesQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.selfEntries(identity.userId, query);
  }

  @Get('timesheets')
  timesheets(@AuthUser() identity: AuthenticatedIdentity) {
    return this.time.selfTimesheets(identity.userId);
  }

  @Get('timesheets/:id')
  timesheet(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.selfTimesheet(identity.userId, id);
  }

  @Post('clock-in')
  clockIn(
    @Body() body: ClockInDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.clockIn(
      identity.userId,
      body.employmentAssignmentId,
      this.context(identity, request),
      body.scheduledShiftId,
      body.additionalEmploymentAssignmentIds,
    );
  }

  @Post('clock-out')
  clockOut(
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.clockOut(identity.userId, this.context(identity, request));
  }

  @Post('break/start')
  startBreak(
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.startBreak(
      identity.userId,
      this.context(identity, request),
    );
  }

  @Post('break/end')
  endBreak(
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.endBreak(identity.userId, this.context(identity, request));
  }

  @Post('switch-assignment')
  switchAssignment(
    @Body() body: SwitchAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.switchAssignment(
      identity.userId,
      body.employmentAssignmentId,
      this.context(identity, request),
      body.scheduledShiftId,
    );
  }

  @Post('exceptions/:id/resolve-missed-clock-out')
  resolveMissedClockOut(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveMissedClockOutDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.resolveMissedClockOut(
      identity.userId,
      id,
      body.clockOutAt,
      this.context(identity, request),
    );
  }

  @Post('corrections')
  requestCorrection(
    @Body() body: CreateTimeCorrectionRequestDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.requestCorrection(
      identity.userId,
      body,
      this.context(identity, request),
    );
  }

  @Post('corrections/:id/cancel')
  cancelCorrection(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.cancelCorrection(
      identity.userId,
      id,
      this.context(identity, request),
    );
  }

  @Post('timesheets/:id/submit')
  submitTimesheet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitOwnTimesheetDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.submitTimesheet(
      identity.userId,
      id,
      this.context(identity, request),
      body ?? {},
    );
  }

  private context(identity: AuthenticatedIdentity, request: Request) {
    return {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    };
  }
}

@Controller('time')
@UseGuards(AccessTokenGuard)
export class TimeManagementController {
  constructor(
    private readonly time: TimeService,
    private readonly variance: ScheduleVarianceService,
  ) {}

  /** Published expected work vs authoritative actual work, per workDate and assignment. */
  @Get('manage/scheduled-vs-actual')
  scheduledVsActual(
    @Query() query: ScheduledVsActualQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.variance.scheduledVsActual(identity.userId, query);
  }

  /** Batch 4E-2 (B4): how each readable assignment captures attendance, across organizations. */
  @Get('manage/assignment-attendance')
  assignmentAttendance(
    @Query() query: AssignmentAttendanceQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.assignmentAttendance(identity.userId, query);
  }

  @Get('manage/current')
  current(
    @Query() query: TimeCurrentQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.managementCurrent(identity.userId, query);
  }

  @Get('manage/entries')
  entries(
    @Query() query: TimeEntriesQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.managementEntries(identity.userId, query);
  }

  @Get('manage/exceptions')
  exceptions(
    @Query() query: TimeExceptionsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.managementExceptions(identity.userId, query);
  }

  @Get('manage/corrections')
  corrections(
    @Query() query: TimeCorrectionsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.managementCorrections(identity.userId, query);
  }

  @Get('manage/timesheets')
  timesheets(
    @Query() query: TimeTimesheetsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.managementTimesheets(identity.userId, query);
  }

  @Post('corrections/:id/approve')
  approveCorrection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewTimeCorrectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.approveCorrection(
      identity.userId,
      id,
      body.reviewerNote,
      this.context(identity, request),
    );
  }

  @Post('corrections/:id/reject')
  rejectCorrection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewTimeCorrectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.rejectCorrection(
      identity.userId,
      id,
      body.reviewerNote,
      this.context(identity, request),
    );
  }

  /** Records a missing entry directly (time.correct): MANUAL, with a reason, no punches. */
  @Post('employees/:employeeId/entries')
  addEntry(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() body: AddTimeEntryDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.addEntry(
      identity.userId,
      employeeId,
      body,
      this.context(identity, request),
    );
  }

  @Post('entries/:id/correct')
  correctEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DirectTimeCorrectionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.correctEntry(
      identity.userId,
      id,
      body,
      this.context(identity, request),
    );
  }

  /** Links, re-links (reinterprets against the latest revision) or unlinks a scheduled shift. */
  @Post('entries/:id/scheduled-shift')
  linkScheduledShift(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LinkScheduledShiftDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.linkScheduledShift(
      identity.userId,
      id,
      body,
      this.context(identity, request),
    );
  }

  /** Batch 4C: the periods the reader may see (time read or timesheet permission). */
  @Get('periods')
  periods(
    @Query() query: TimePeriodsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.listTimePeriods(identity.userId, query);
  }

  /** Batch 4C: the period's timesheets, without payroll (idempotent). */
  @Post('periods/:id/materialize-timesheets')
  materializeTimesheets(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.materializeTimesheets(
      identity.userId,
      id,
      this.context(identity, request),
    );
  }

  /** Batch 4C: resolve an attendance exception (it was addressed), with a note. */
  @Post('exceptions/:id/resolve')
  @HttpCode(200)
  resolveException(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewAttendanceExceptionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.reviewException(
      identity.userId,
      id,
      'RESOLVE',
      body.note,
      this.context(identity, request),
    );
  }

  /** Batch 4C: dismiss an attendance exception (no action needed), with a note. */
  @Post('exceptions/:id/dismiss')
  @HttpCode(200)
  dismissException(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewAttendanceExceptionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.reviewException(
      identity.userId,
      id,
      'DISMISS',
      body.note,
      this.context(identity, request),
    );
  }

  @Post('periods/generate')
  generatePeriods(
    @Body() body: GenerateTimePeriodsDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.generateTimePeriods(
      identity.userId,
      body,
      this.context(identity, request),
    );
  }

  @Post('timesheet-segments/:id/approve')
  approveTimesheetSegment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveTimesheetSegmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.approveTimesheetSegment(
      identity.userId,
      id,
      body.note,
      this.context(identity, request),
      {
        expectedNetWorkedMinutes: body.expectedNetWorkedMinutes,
        expectedVersion: body.expectedVersion,
      },
    );
  }

  @Post('timesheet-segments/:id/request-changes')
  requestTimesheetChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TimesheetReviewDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.requestTimesheetChanges(
      identity.userId,
      id,
      body.note,
      this.context(identity, request),
    );
  }

  @Post('timesheets/:id/lock')
  lockTimesheet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TimesheetVersionDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.lockTimesheet(
      identity.userId,
      id,
      this.context(identity, request),
      { expectedVersion: body.expectedVersion },
    );
  }

  /** Batch 4A: explicit, permission-gated and audited submission for an employee. */
  @Post('timesheets/:id/submit-on-behalf')
  submitTimesheetOnBehalf(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitTimesheetOnBehalfDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.submitTimesheetOnBehalf(
      identity.userId,
      id,
      body.reason,
      this.context(identity, request),
    );
  }

  @Post('timesheets/:id/reopen')
  reopenTimesheet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReopenTimesheetDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.time.reopenTimesheet(
      identity.userId,
      id,
      body.note,
      this.context(identity, request),
      { expectedVersion: body.expectedVersion },
    );
  }

  private context(identity: AuthenticatedIdentity, request: Request) {
    return {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    };
  }
}
