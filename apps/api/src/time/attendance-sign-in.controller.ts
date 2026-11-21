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
import { AttendanceSignInService } from './attendance-sign-in.service.js';
import { context } from './time-policy.controller.js';
import {
  CorrectSignInDto,
  ExpectedSignInsQueryDto,
  ManagedSignInsQueryDto,
  RecordSignInDto,
  SelfSignInDto,
  SignInDto,
  SignInRangeQueryDto,
  VoidSignInDto,
  RecordSignOutDto,
} from './time.dto.js';

/** Phase 9.5 — an employee's own presence (SIGN_IN_ONLY) through self-service, where allowed. */
@Controller('time/me')
@UseGuards(AccessTokenGuard)
export class MySignInController {
  constructor(private readonly signIns: AttendanceSignInService) {}

  @Post('sign-in')
  signIn(
    @Body() body: SelfSignInDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.signIns.selfSignIn(
      identity.userId,
      body,
      context(identity, request),
    );
  }

  /** Batch 4E-3 (C8): the caller's own published shifts and their attendance (31 days). */
  @Get('expected-attendance')
  expectedAttendance(
    @Query() query: SignInRangeQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.signIns.myExpectedAttendance(identity.userId, query);
  }

  /** Batch 4D (D-H): sign out of the open sign-in, where the policy enables it. */
  @Post('sign-out')
  signOut(
    @Body() body: SignInDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.signIns.selfSignOut(
      identity.userId,
      body,
      context(identity, request),
    );
  }

  @Get('sign-ins')
  mySignIns(
    @Query() query: SignInRangeQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.signIns.mySignIns(identity.userId, query);
  }
}

/** Phase 9.5 — presence for managers: scoped lists, the expected-sign-in report, corrections. */
@Controller('time')
@UseGuards(AccessTokenGuard)
export class ManagedSignInController {
  constructor(private readonly signIns: AttendanceSignInService) {}

  @Get('manage/sign-ins')
  list(
    @Query() query: ManagedSignInsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.signIns.managedSignIns(identity.userId, query);
  }

  @Get('manage/expected-sign-ins')
  expected(
    @Query() query: ExpectedSignInsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.signIns.expectedSignIns(identity.userId, query);
  }

  @Post('sign-ins')
  record(
    @Body() body: RecordSignInDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.signIns.recordManual(
      identity.userId,
      body,
      context(identity, request),
    );
  }

  /** Batch 4D (D-H): a manager records a sign-out for a sign-in (time.correct, a reason). */
  @Post('sign-ins/:id/sign-out')
  recordSignOut(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordSignOutDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.signIns.recordManualSignOut(
      identity.userId,
      id,
      body,
      context(identity, request),
    );
  }

  /** Batch 4D (D-H): voids a sign-out (kept in history); record the right one after. */
  @Post('sign-outs/:id/void')
  voidSignOut(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidSignInDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.signIns.voidSignOut(
      identity.userId,
      id,
      body.reason,
      context(identity, request),
    );
  }

  @Post('sign-ins/:id/void')
  voidSignIn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidSignInDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.signIns.voidSignIn(
      identity.userId,
      id,
      body.reason,
      context(identity, request),
    );
  }

  @Post('sign-ins/:id/correct')
  correct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CorrectSignInDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.signIns.correctSignIn(
      identity.userId,
      id,
      body,
      context(identity, request),
    );
  }
}
