import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import {
  DisableEmployeeAccountDto,
  EmployeeAccountInvitationDto,
  RequirePasswordChangeDto,
} from './employee.dto.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';
import { EmployeeAccountService } from './employee-account.service.js';

/** Employee login access (employee.account.manage): status, invitation and access lifecycle. */
@Controller('employees/:id/account')
@UseGuards(AccessTokenGuard)
export class EmployeeAccountController {
  constructor(private readonly accounts: EmployeeAccountService) {}

  private context(identity: AuthenticatedIdentity, request: Request) {
    return {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    };
  }

  @Get() status(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.account(id, this.context(identity, request));
  }
  @Post('invitation')
  @HttpCode(200)
  @RateLimit(...RATE_LIMITS.employeeAccountEmail)
  invite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EmployeeAccountInvitationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.invite(id, body, this.context(identity, request));
  }
  @Post('invitation/resend')
  @HttpCode(200)
  @RateLimit(...RATE_LIMITS.employeeAccountEmail)
  resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EmployeeAccountInvitationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.resend(id, body, this.context(identity, request));
  }
  @Post('invitation/cancel') @HttpCode(200) cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.cancel(id, this.context(identity, request));
  }
  @Post('disable') @HttpCode(200) disable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DisableEmployeeAccountDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.disable(id, body, this.context(identity, request));
  }
  @Post('enable') @HttpCode(200) enable(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.enable(id, this.context(identity, request));
  }
  @Post('require-password-change') @HttpCode(200) requirePasswordChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RequirePasswordChangeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.requirePasswordChange(
      id,
      body,
      this.context(identity, request),
    );
  }
  @Post('sessions/revoke') @HttpCode(200) signOut(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.signOut(id, this.context(identity, request));
  }
  @Post('password-reset')
  @HttpCode(200)
  @RateLimit(...RATE_LIMITS.employeeAccountEmail)
  sendPasswordReset(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.sendPasswordReset(id, this.context(identity, request));
  }
  @Post('unlock') @HttpCode(200) unlock(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.accounts.unlock(id, this.context(identity, request));
  }
}
