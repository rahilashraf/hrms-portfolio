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
  CreateSchedulePolicyDto,
  EndSchedulePolicyDto,
  ResolveSchedulePolicyQueryDto,
  SchedulePolicyListQueryDto,
  UpdateSchedulePolicyDto,
} from './schedule-policy.dto.js';
import { SchedulePolicyService } from './schedule-policy.service.js';
import type { SchedulingRequestContext } from './scheduling.service.js';

function requestContext(
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

@Controller('schedule-policies')
@UseGuards(AccessTokenGuard)
export class SchedulePolicyController {
  constructor(private readonly policies: SchedulePolicyService) {}

  @Post()
  createPolicy(
    @Body() body: CreateSchedulePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.createPolicy(body, requestContext(identity, request));
  }

  @Get()
  listPolicies(
    @Query() query: SchedulePolicyListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.policies.listPolicies(identity.userId, query);
  }

  /** The settings in effect for an assignment on a date, with each setting's source. */
  @Get('resolve')
  resolvePolicy(
    @Query() query: ResolveSchedulePolicyQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.policies.resolvePolicy(identity.userId, query);
  }

  @Get(':policyId')
  getPolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.policies.getPolicy(identity.userId, policyId);
  }

  /** Only before the policy takes effect. */
  @Patch(':policyId')
  updatePolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: UpdateSchedulePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.updatePolicy(
      policyId,
      body,
      requestContext(identity, request),
    );
  }

  @Post(':policyId/end')
  @HttpCode(200)
  endPolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body() body: EndSchedulePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.endPolicy(
      policyId,
      body,
      requestContext(identity, request),
    );
  }

  /** Only before the policy takes effect. */
  @Delete(':policyId')
  deletePolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.deletePolicy(
      policyId,
      requestContext(identity, request),
    );
  }
}
