import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import {
  formatDate,
  jsonValue,
  localDateOf,
  parseDateOnly,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

export type PerformanceClient = PrismaService | Prisma.TransactionClient;
export type PerformanceRequestContext = DomainRequestContext;

/** The performance clock (overridden in tests). */
@Injectable()
export class PerformanceClock {
  now(): Date {
    return new Date();
  }
}

/**
 * Lock order of every Performance write: configuration row (scale, template; FOR NO KEY
 * UPDATE) → PerformanceCycle (FOR NO KEY UPDATE for cycle transitions, FOR SHARE for review
 * work) → PerformanceReview (FOR NO KEY UPDATE) → its responses and links. Evidence ingestion
 * locks its source (FOR NO KEY UPDATE: one ingestion per source at a time); every evidence
 * write of an external result also takes that result's transaction advisory lock. Core HR rows
 * are only read.
 */
async function lockRow(
  tx: Prisma.TransactionClient,
  table: string,
  id: string,
  mode: 'FOR NO KEY UPDATE' | 'FOR SHARE',
  missing: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid ${Prisma.raw(mode)}`,
  );
  if (!rows[0]) throw new NotFoundException(missing);
}

export const lockScale = (tx: Prisma.TransactionClient, id: string) =>
  lockRow(
    tx,
    'PerformanceRatingScale',
    id,
    'FOR NO KEY UPDATE',
    'Rating scale not found.',
  );
export const lockTemplate = (tx: Prisma.TransactionClient, id: string) =>
  lockRow(
    tx,
    'PerformanceTemplate',
    id,
    'FOR NO KEY UPDATE',
    'Template not found.',
  );
export const lockCycle = (tx: Prisma.TransactionClient, id: string) =>
  lockRow(
    tx,
    'PerformanceCycle',
    id,
    'FOR NO KEY UPDATE',
    'Review cycle not found.',
  );
export const shareCycle = (tx: Prisma.TransactionClient, id: string) =>
  lockRow(tx, 'PerformanceCycle', id, 'FOR SHARE', 'Review cycle not found.');
export const lockReview = (tx: Prisma.TransactionClient, id: string) =>
  lockRow(
    tx,
    'PerformanceReview',
    id,
    'FOR NO KEY UPDATE',
    'Review not found.',
  );
export const lockGoal = (tx: Prisma.TransactionClient, id: string) =>
  lockRow(tx, 'PerformanceGoal', id, 'FOR NO KEY UPDATE', 'Goal not found.');

/**
 * The organization's local date "today" (due dates, overdue): its timezone, else UTC.
 */
export function performanceToday(
  now: Date,
  timezone: string | null | undefined,
): Date {
  if (timezone && isIanaTimezone(timezone))
    return localDateOf(now, timezone.trim());
  return parseDateOnly(formatDate(now), 'today');
}

export function isoDate(value: Date | null | undefined): string | null {
  return value ? formatDate(value) : null;
}

/**
 * Audit in the caller's transaction. Metadata carries identifiers, statuses and counts only:
 * never answers, comments, acknowledgement text, evidence notes or external payloads.
 */
export function writePerformanceAudit(
  audit: AuditService,
  client: Prisma.TransactionClient,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: PerformanceRequestContext;
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

/** Unique-constraint violations as a domain conflict (e.g. duplicate codes). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
