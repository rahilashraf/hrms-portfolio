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
import type { DomainRequestContext } from '../common/domain-support.js';
import {
  CreateHolidayDto,
  HolidayListQueryDto,
  UpdateHolidayDto,
} from './calendar.dto.js';
import { HolidayService } from './holiday.service.js';

export function domainRequestContext(
  identity: AuthenticatedIdentity,
  request: Request,
): DomainRequestContext {
  return {
    actorUserId: identity.userId,
    ipAddress: request.ip,
    userAgent: request.get('user-agent') ?? undefined,
    correlationId: request.get('x-correlation-id') ?? undefined,
  };
}

@Controller('holidays')
@UseGuards(AccessTokenGuard)
export class HolidayController {
  constructor(private readonly holidays: HolidayService) {}

  @Get()
  list(
    @Query() query: HolidayListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.holidays.list(identity.userId, query);
  }

  @Post()
  create(
    @Body() body: CreateHolidayDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.holidays.create(body, domainRequestContext(identity, request));
  }

  @Patch(':holidayId')
  update(
    @Param('holidayId', ParseUUIDPipe) holidayId: string,
    @Body() body: UpdateHolidayDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.holidays.update(
      holidayId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post(':holidayId/archive')
  archive(
    @Param('holidayId', ParseUUIDPipe) holidayId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.holidays.archive(
      holidayId,
      domainRequestContext(identity, request),
    );
  }
}
