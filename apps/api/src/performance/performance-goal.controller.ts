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
import { PerformanceGoalService } from './performance-goal.service.js';
import {
  CreateGoalDto,
  UpdateGoalDto,
  GoalStatusQueryDto,
} from './performance.dto.js';

/** Goals: the employee's own, HR's within performance.manage scope, the active reviewer's. */
@Controller('performance')
@UseGuards(AccessTokenGuard)
export class PerformanceGoalController {
  constructor(private readonly goals: PerformanceGoalService) {}

  @Get('me')
  me(@AuthUser() identity: AuthenticatedIdentity) {
    return this.goals.me(identity.userId);
  }

  @Get('me/goals')
  mine(
    @Query() query: GoalStatusQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.goals.mine(identity.userId, query.status, query);
  }

  @Get('employees/:employeeId/goals')
  forEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: GoalStatusQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.goals.forEmployee(
      identity.userId,
      employeeId,
      query.status,
      query,
    );
  }

  @Post('goals')
  create(
    @Body() body: CreateGoalDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.goals.create(body, domainRequestContext(identity, request));
  }

  @Patch('goals/:goalId')
  update(
    @Param('goalId', ParseUUIDPipe) goalId: string,
    @Body() body: UpdateGoalDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.goals.update(
      goalId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/goals/:goalId')
  link(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.goals.link(
      reviewId,
      goalId,
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/goals/:goalId/unlink')
  unlink(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.goals.unlink(
      reviewId,
      goalId,
      domainRequestContext(identity, request),
    );
  }
}
