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
import {
  CreateTimePolicyDto,
  EffectivePolicyQueryDto,
  EndTimePolicyDto,
  HistoricalReadQueryDto,
  InheritedPolicyQueryDto,
  SupersedeTimePolicyDto,
  TimePolicyListQueryDto,
} from './time.dto.js';
import { TimePolicyService } from './time-policy.service.js';
import { TimeService, type TimeRequestContext } from './time.service.js';

/** Phase 9.5 — effective-dated TimeAttendancePolicy layers (time.manage_policy). No edits, no deletes. */
/** Phase 9.5 — the organizations reachable through the user's Time administration grants. */
@Controller('time/manage/organizations')
@UseGuards(AccessTokenGuard)
export class TimeManageOrganizationsController {
  constructor(private readonly policies: TimePolicyService) {}

  @Get()
  organizations(
    @AuthUser() identity: AuthenticatedIdentity,
    @Query() query: HistoricalReadQueryDto,
  ) {
    return this.policies.organizations(identity.userId, {
      includeDisabledOrganizations: query.includeDisabledOrganizations === true,
    });
  }
}

@Controller('time/policies')
@UseGuards(AccessTokenGuard)
export class TimePolicyController {
  constructor(
    private readonly policies: TimePolicyService,
    private readonly time: TimeService,
  ) {}

  /** Batch 4E-2 (B1): an assignment's resolved policy on a date, with each setting's source. */
  @Get('effective')
  effective(
    @Query() query: EffectivePolicyQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.time.effectivePolicyView(identity.userId, query);
  }

  /**
   * Batch 4E-2 review: what a layer at a scope would inherit on a date, resolved as the runtime
   * resolves (the editor's hints). Authorized as adding a layer at that scope.
   */
  @Get('inherited')
  async inherited(
    @Query() query: InheritedPolicyQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    const target = await this.policies.inheritanceTarget(
      identity.userId,
      query,
    );
    return this.time.inheritedPolicyView(target, query.date);
  }

  @Get()
  list(
    @Query() query: TimePolicyListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.policies.list(identity.userId, query);
  }

  @Post()
  create(
    @Body() body: CreateTimePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.create(
      identity.userId,
      body,
      context(identity, request),
    );
  }

  @Post(':id/end')
  end(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EndTimePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.end(
      identity.userId,
      id,
      body,
      context(identity, request),
    );
  }

  /** Batch 4E-2 (B3): replaces a layer from a date, atomically. */
  @Post(':id/supersede')
  supersede(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SupersedeTimePolicyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.supersede(
      identity.userId,
      id,
      body,
      context(identity, request),
    );
  }

  @Post(':id/archive')
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.policies.archive(
      identity.userId,
      id,
      context(identity, request),
    );
  }
}

export function context(
  identity: AuthenticatedIdentity,
  request: Request,
): TimeRequestContext {
  return {
    actorUserId: identity.userId,
    ipAddress: request.ip,
    userAgent: request.get('user-agent') ?? undefined,
    correlationId: request.get('x-correlation-id') ?? undefined,
  };
}
