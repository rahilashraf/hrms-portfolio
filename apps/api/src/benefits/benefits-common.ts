import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import {
  jsonValue,
  localDateOf,
  parseDateOnly,
  formatDate,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

export type BenefitsClient = PrismaService | Prisma.TransactionClient;
export type BenefitsRequestContext = DomainRequestContext;

/** The benefits clock (overridden in tests). */
@Injectable()
export class BenefitsClock {
  now(): Date {
    return new Date();
  }
}

/**
 * Lock order of every Benefits write: BenefitPlan (FOR NO KEY UPDATE, or FOR SHARE for
 * elections) → BenefitCoverageOption
 * (rates; the rate trigger locks it) → Employee (elections; the election trigger locks it).
 * Core HR, organization structure and Payroll rows are only read, never locked.
 */
export async function lockPlan(tx: Prisma.TransactionClient, planId: string) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; organizationId: string }>
  >(Prisma.sql`
    SELECT "id", "organizationId" FROM "BenefitPlan"
    WHERE "id" = ${planId}::uuid FOR NO KEY UPDATE`);
  if (!rows[0]) throw new NotFoundException('Benefit plan not found.');
  return rows[0];
}

/**
 * Election writes hold the plan FOR SHARE (before the employee lock) so a plan discontinuation,
 * which holds it FOR NO KEY UPDATE, never races an election past the plan's new end.
 */
export async function sharePlan(tx: Prisma.TransactionClient, planId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "BenefitPlan" WHERE "id" = ${planId}::uuid FOR SHARE`);
  if (!rows[0]) throw new NotFoundException('Benefit plan not found.');
}

/** Serializes election writes of one employee (the timeline trigger locks the same row). */
export async function lockEmployee(
  tx: Prisma.TransactionClient,
  employeeId: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Employee" WHERE "id" = ${employeeId}::uuid FOR NO KEY UPDATE`);
  if (!rows[0]) throw new NotFoundException('Employee not found.');
}

/**
 * The local date "today" for benefit status: the assignment's work location, else its
 * organization's timezone; UTC only when neither is configured (reported as unresolved).
 */
export function benefitsToday(
  now: Date,
  ...timezones: Array<string | null | undefined>
): { today: Date; timezone: string | null } {
  for (const candidate of timezones) {
    if (candidate && isIanaTimezone(candidate)) {
      return {
        today: localDateOf(now, candidate.trim()),
        timezone: candidate.trim(),
      };
    }
  }
  return { today: parseDateOnly(formatDate(now), 'today'), timezone: null };
}

/** Audit in the caller's transaction; metadata never carries dependent names or birth dates. */
export function writeBenefitsAudit(
  audit: AuditService,
  client: Prisma.TransactionClient,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: BenefitsRequestContext;
    metadata: Record<string, unknown>;
  },
) {
  return audit.write(
    {
      action: input.action,
      actorUserId: input.context.actorUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
      correlationId: input.context.correlationId,
      metadata: jsonValue(input.metadata),
    },
    client,
  );
}
