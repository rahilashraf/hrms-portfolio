import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { KIOSK_ACTIONS, type KioskAction } from './attendance-kiosk.service.js';

export class KioskEnrollDto {
  @IsString()
  @Length(10, 20)
  enrollmentCode!: string;
}

export class KioskIdentifyDto {
  @IsString()
  @Length(1, 40)
  employeeNumber!: string;

  @IsString()
  @Length(1, 12)
  pin!: string;
}

export class KioskActionDto {
  @IsString()
  @Length(20, 100)
  token!: string;

  @IsIn(KIOSK_ACTIONS)
  action!: KioskAction;

  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  /** CLOCK_IN covering several assignments: employmentAssignmentId is the payroll owner. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsUUID('all', { each: true })
  additionalEmploymentAssignmentIds?: string[];

  /**
   * CLOCK_IN / SWITCH_ASSIGNMENT / SIGN_IN (Batch 4F): the scheduled shift chosen among several
   * open ones (only one of the options offered for this interaction).
   */
  @IsOptional()
  @IsUUID()
  scheduledShiftId?: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,100}$/)
  idempotencyKey?: string;
}

export class KioskCancelDto {
  @IsString()
  @Length(20, 100)
  token!: string;
}

export class DeviceListQueryDto {
  @IsUUID()
  organizationId!: string;
}

export class RegisterDeviceDto {
  @IsUUID()
  organizationId!: string;

  @IsUUID()
  physicalSiteId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class UpdateDeviceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  physicalSiteId?: string;
}

export class ReasonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ChangeOwnPinDto {
  @IsOptional()
  @IsString()
  @Length(1, 12)
  currentPin?: string;

  @IsString()
  @Length(6, 6)
  newPin!: string;
}
