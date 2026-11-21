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
import { PerformanceCycleService } from './performance-cycle.service.js';
import {
  AddCycleReviewsDto,
  CloseCycleDto,
  CreateCycleDto,
  PerformanceOrganizationQueryDto,
  UpdateCycleDto,
  CycleReviewsQueryDto,
} from './performance.dto.js';

/**
 * Review cycles: reads with any performance permission in the organization (monitoring shows
 * the reviews within the reader's scope), writes with performance.cycle.manage.
 */
@Controller('performance/cycles')
@UseGuards(AccessTokenGuard)
export class PerformanceCycleController {
  constructor(private readonly cycles: PerformanceCycleService) {}

  @Get()
  list(
    @Query() query: PerformanceOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.cycles.list(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Post()
  create(
    @Body() body: CreateCycleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.create(body, domainRequestContext(identity, request));
  }

  @Get(':cycleId')
  detail(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.cycles.detail(identity.userId, cycleId);
  }

  @Patch(':cycleId')
  update(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Body() body: UpdateCycleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.update(
      cycleId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Delete(':cycleId')
  discard(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.discard(
      cycleId,
      domainRequestContext(identity, request),
    );
  }

  @Get(':cycleId/reviews')
  reviews(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Query() query: CycleReviewsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.cycles.reviews(identity.userId, cycleId, query);
  }

  @Post(':cycleId/reviews')
  addReviews(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Body() body: AddCycleReviewsDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.addReviews(
      cycleId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Delete(':cycleId/reviews/:reviewId')
  removeReview(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.removeReview(
      cycleId,
      reviewId,
      domainRequestContext(identity, request),
    );
  }

  @Post(':cycleId/open')
  open(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.open(cycleId, domainRequestContext(identity, request));
  }

  @Post(':cycleId/close')
  close(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Body() body: CloseCycleDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.close(
      cycleId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post(':cycleId/archive')
  archive(
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.cycles.archive(
      cycleId,
      domainRequestContext(identity, request),
    );
  }
}
