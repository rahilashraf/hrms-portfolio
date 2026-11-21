import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { AUDIT_MAX_LIMIT } from './audit-viewer-domain.js';

const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

/** GET /audit — shapes only; the range rules (defaults, 366-day cap) live in the domain. */
export class AuditQueryDto {
  /**
   * Batch 2: `system` lists the entries tied to no organization (e.g. sign-in events of an
   * account outside every organization); it needs audit.read at System scope and takes no
   * organizationId. The default (`organization`) needs organizationId.
   */
  @IsOptional()
  @IsIn(['organization', 'system'])
  scope?: 'organization' | 'system';

  @ValidateIf((query: AuditQueryDto) => query.scope !== 'system')
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z][A-Za-z0-9_.]*$/)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z][A-Za-z0-9]*$/)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9_.:-]+$/)
  entityId?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

/** Batch R3.3: at most this many actors per lookup page. */
export const AUDIT_ACTOR_MAX_LIMIT = 50;

/**
 * GET /audit/actors (Batch R3.3) — the people who appear as the actor of the audit entries an
 * audit reader may already see (same scope and date window as GET /audit), for the viewer's
 * actor filter. Search is by name, or by exact user id.
 */
export class AuditActorQueryDto {
  @IsOptional()
  @IsIn(['organization', 'system'])
  scope?: 'organization' | 'system';

  @ValidateIf((query: AuditActorQueryDto) => query.scope !== 'system')
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(AUDIT_ACTOR_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsUUID()
  afterId?: string;
}
