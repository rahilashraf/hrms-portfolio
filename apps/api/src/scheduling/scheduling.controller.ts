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
import {
  AddPublishedScheduledShiftDto,
  CancelScheduledShiftDto,
  CorrectScheduledShiftDto,
  CreateScheduledShiftDto,
  CreateScheduleDto,
  ScheduledShiftFieldsDto,
  ScheduledShiftListQueryDto,
  ScheduleListQueryDto,
  UpdateScheduledShiftDto,
  UpdateScheduledShiftFieldsDto,
  UpdateScheduleDto,
} from './scheduling.dto.js';
import {
  SchedulingService,
  type SchedulingRequestContext,
} from './scheduling.service.js';

@Controller('schedules')
@UseGuards(AccessTokenGuard)
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post()
  createSchedule(
    @Body() body: CreateScheduleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.createSchedule(
      body,
      this.context(identity, request),
    );
  }

  @Get()
  listSchedules(
    @Query() query: ScheduleListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.scheduling.listSchedules(identity.userId, query);
  }

  @Get(':scheduleId')
  getSchedule(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.scheduling.getSchedule(identity.userId, scheduleId);
  }

  @Patch(':scheduleId')
  updateSchedule(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() body: UpdateScheduleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.updateSchedule(
      scheduleId,
      body,
      this.context(identity, request),
    );
  }

  @Delete(':scheduleId')
  deleteSchedule(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.deleteSchedule(
      scheduleId,
      this.context(identity, request),
    );
  }

  /** DRAFT → PUBLISHED, with a baseline revision for every shift. */
  @Post(':scheduleId/publish')
  @HttpCode(200)
  publishSchedule(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.publishSchedule(
      scheduleId,
      this.context(identity, request),
    );
  }

  @Post(':scheduleId/shifts')
  createShift(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() body: CreateScheduledShiftDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.createShift(
      scheduleId,
      body,
      this.context(identity, request),
    );
  }

  /** Read-only: evaluates a prospective shift's conflicts without saving it. */
  @Post(':scheduleId/shifts/conflicts')
  @HttpCode(200)
  previewNewShiftConflicts(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() body: ScheduledShiftFieldsDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.scheduling.previewShiftConflicts(
      identity.userId,
      scheduleId,
      null,
      body,
    );
  }

  /** Read-only: evaluates the merged final state of a shift update without saving it. */
  @Post(':scheduleId/shifts/:shiftId/conflicts')
  @HttpCode(200)
  previewShiftUpdateConflicts(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() body: UpdateScheduledShiftFieldsDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.scheduling.previewShiftConflicts(
      identity.userId,
      scheduleId,
      shiftId,
      body,
    );
  }

  @Get(':scheduleId/shifts')
  listShifts(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Query() query: ScheduledShiftListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.scheduling.listShifts(identity.userId, scheduleId, query);
  }

  @Get(':scheduleId/shifts/:shiftId')
  getShift(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.scheduling.getShift(identity.userId, scheduleId, shiftId);
  }

  @Patch(':scheduleId/shifts/:shiftId')
  updateShift(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() body: UpdateScheduledShiftDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.updateShift(
      scheduleId,
      shiftId,
      body,
      this.context(identity, request),
    );
  }

  /** Adds an immediately operational shift to a PUBLISHED Schedule, with a reason. */
  @Post(':scheduleId/shifts/add')
  addPublishedShift(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() body: AddPublishedScheduledShiftDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.addPublishedShift(
      scheduleId,
      body,
      this.context(identity, request),
    );
  }

  /** Corrects a published shift and appends a CORRECTED revision. */
  @Post(':scheduleId/shifts/:shiftId/correct')
  @HttpCode(200)
  correctShift(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() body: CorrectScheduledShiftDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.correctShift(
      scheduleId,
      shiftId,
      body,
      this.context(identity, request),
    );
  }

  /** Cancels a published shift (never a hard delete) and appends a CANCELLED revision. */
  @Post(':scheduleId/shifts/:shiftId/cancel')
  @HttpCode(200)
  cancelShift(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() body: CancelScheduledShiftDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.cancelShift(
      scheduleId,
      shiftId,
      body,
      this.context(identity, request),
    );
  }

  @Get(':scheduleId/shifts/:shiftId/revisions')
  listShiftRevisions(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.scheduling.listShiftRevisions(
      identity.userId,
      scheduleId,
      shiftId,
    );
  }

  @Delete(':scheduleId/shifts/:shiftId')
  deleteShift(
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.scheduling.deleteShift(
      scheduleId,
      shiftId,
      this.context(identity, request),
    );
  }

  private context(
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
}
