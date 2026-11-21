import { IsIn, IsOptional, IsUUID, Matches, MaxLength } from 'class-validator';
import {
  EMPLOYMENT_TYPES,
  GROUP_BY_VALUES,
  type RawReportFilters,
} from './reporting-domain.js';

/** Shapes only: which filters a report supports, ranges and scope are checked by the services. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_KEY = /^[a-z]+\.[a-z_]+$/;

export class OrganizationQueryDto {
  @IsUUID() organizationId!: string;
}

export class ReportQueryDto
  extends OrganizationQueryDto
  implements RawReportFilters
{
  @IsOptional() @Matches(DATE_ONLY) from?: string;
  @IsOptional() @Matches(DATE_ONLY) to?: string;
  @IsOptional() @Matches(DATE_ONLY) asOf?: string;
  @IsOptional() @IsUUID() organizationalUnitId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() positionId?: string;
  @IsOptional() @IsIn(EMPLOYMENT_TYPES) employmentType?: string;
  @IsOptional() @IsIn(GROUP_BY_VALUES) groupBy?: string;
  @IsOptional() @IsUUID() cycleId?: string;
  @IsOptional() @IsUUID() openingId?: string;
}

export class ReportKeyParam {
  @MaxLength(80) @Matches(REPORT_KEY) reportKey!: string;
}

export function filtersOf(query: ReportQueryDto): RawReportFilters {
  return {
    from: query.from,
    to: query.to,
    asOf: query.asOf,
    organizationalUnitId: query.organizationalUnitId,
    departmentId: query.departmentId,
    teamId: query.teamId,
    positionId: query.positionId,
    employmentType: query.employmentType,
    groupBy: query.groupBy,
    cycleId: query.cycleId,
    openingId: query.openingId,
  };
}
