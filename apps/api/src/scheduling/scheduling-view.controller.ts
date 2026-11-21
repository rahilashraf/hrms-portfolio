import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import {
  MyScheduleQueryDto,
  ScheduleGridQueryDto,
  ScheduledHoursQueryDto,
} from './scheduling-view.dto.js';
import { SchedulingViewService } from './scheduling-view.service.js';

@Controller('scheduling')
@UseGuards(AccessTokenGuard)
export class SchedulingViewController {
  constructor(private readonly views: SchedulingViewService) {}

  /** The signed-in employee's published shifts across all of their assignments. */
  @Get('me')
  mySchedule(
    @Query() query: MyScheduleQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.mySchedule(identity.userId, query);
  }

  /** Scheduled hours grouped by one dimension over the readable Schedules. */
  @Get('reports/scheduled-hours')
  scheduledHours(
    @Query() query: ScheduledHoursQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.scheduledHours(identity.userId, query);
  }

  /** The scoped manager/admin schedule grid of one organization. */
  @Get()
  grid(
    @Query() query: ScheduleGridQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.views.grid(identity.userId, query);
  }
}
