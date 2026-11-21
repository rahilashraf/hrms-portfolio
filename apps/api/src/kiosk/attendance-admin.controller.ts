import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { context } from '../time/time-policy.controller.js';
import { AttendanceCredentialService } from './attendance-credential.service.js';
import { AttendanceDeviceService } from './attendance-device.service.js';
import {
  ChangeOwnPinDto,
  DeviceListQueryDto,
  ReasonDto,
  RegisterDeviceDto,
  UpdateDeviceDto,
} from './kiosk.dto.js';

/** Phase 9.5 — trusted attendance devices (time.device.manage on the organization). */
@Controller('time/devices')
@UseGuards(AccessTokenGuard)
export class AttendanceDeviceController {
  constructor(private readonly devices: AttendanceDeviceService) {}

  @Get()
  list(
    @Query() query: DeviceListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.devices.list(identity.userId, query.organizationId);
  }

  /** Returns the one-time enrollment code (shown once). */
  @Post()
  @Header('Cache-Control', 'no-store')
  register(
    @Body() body: RegisterDeviceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.devices.register(
      identity.userId,
      body,
      context(identity, request),
    );
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDeviceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.devices.update(
      identity.userId,
      id,
      body,
      context(identity, request),
    );
  }

  /** A new enrollment code; the current device secret stops working. */
  @Post(':id/rotate')
  @Header('Cache-Control', 'no-store')
  rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.devices.rotate(identity.userId, id, context(identity, request));
  }

  @Post(':id/disable')
  disable(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.devices.setEnabled(
      identity.userId,
      id,
      false,
      context(identity, request),
    );
  }

  @Post(':id/enable')
  enable(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.devices.setEnabled(
      identity.userId,
      id,
      true,
      context(identity, request),
    );
  }

  @Post(':id/revoke')
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.devices.revoke(
      identity.userId,
      id,
      body.reason,
      context(identity, request),
    );
  }
}

/** Phase 9.5 — employees' attendance PINs (time.credential.manage); never revealed again. */
@Controller('time/employees/:employeeId/attendance-pin')
@UseGuards(AccessTokenGuard)
export class AttendanceCredentialController {
  constructor(private readonly credentials: AttendanceCredentialService) {}

  @Get()
  status(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.credentials.status(identity.userId, employeeId);
  }

  /** Issues or resets the PIN; the new PIN is in this response only. */
  @Post()
  @Header('Cache-Control', 'no-store')
  issue(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.credentials.issuePin(
      identity.userId,
      employeeId,
      context(identity, request),
    );
  }

  @Post('revoke')
  revoke(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() body: ReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.credentials.revokePin(
      identity.userId,
      employeeId,
      body.reason,
      context(identity, request),
    );
  }
}

/** Phase 9.5 — an employee's own attendance PIN, through their authenticated account. */
@Controller('time/me/attendance-pin')
@UseGuards(AccessTokenGuard)
export class MyAttendancePinController {
  constructor(private readonly credentials: AttendanceCredentialService) {}

  @Get()
  status(@AuthUser() identity: AuthenticatedIdentity) {
    return this.credentials.ownStatus(identity.userId);
  }

  @Put()
  change(
    @Body() body: ChangeOwnPinDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.credentials.changeOwnPin(
      identity.userId,
      body,
      context(identity, request),
    );
  }
}
