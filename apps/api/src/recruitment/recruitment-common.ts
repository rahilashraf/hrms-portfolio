import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  jsonValue,
  localDateOf,
  parseDateOnly,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import type { PrismaService } from '../database/prisma.service.js';
import {
  Prisma,
  type RecruitmentActivityType,
} from '../generated/prisma/client.js';

export type RecruitmentClient = PrismaService | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;
export type RecruitmentRequestContext = DomainRequestContext;

/** The recruitment clock (overridden in tests). */
@Injectable()
export class RecruitmentClock {
  now(): Date {
    return new Date();
  }
}

export const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));

export const badRequest = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new BadRequestException(domainError(400, code, message, extra));

/**
 * Lock order of every Recruitment write: JobOpening (FOR NO KEY UPDATE) →
 * RecruitmentApplication (FOR NO KEY UPDATE) → its offer / interview / feedback rows. Candidate
 * creation by email takes a transaction advisory lock on (organization, email) first.
 */
async function lockRow(tx: Tx, table: string, id: string, missing: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`,
  );
  if (!rows[0]) throw new NotFoundException(missing);
}

export const lockOpening = (tx: Tx, id: string) =>
  lockRow(tx, 'JobOpening', id, 'Job opening not found.');
export const lockApplication = (tx: Tx, id: string) =>
  lockRow(tx, 'RecruitmentApplication', id, 'Application not found.');
export const lockOffer = (tx: Tx, id: string) =>
  lockRow(tx, 'RecruitmentOffer', id, 'Offer not found.');
export const lockInterview = (tx: Tx, id: string) =>
  lockRow(tx, 'RecruitmentInterview', id, 'Interview not found.');
export const lockCandidate = (tx: Tx, id: string) =>
  lockRow(tx, 'RecruitmentCandidate', id, 'Candidate not found.');

/** The organization's local date "today" (offer expiry, posting dates). */
export function recruitmentToday(
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

export function optionalDate(
  value: string | null | undefined,
  field: string,
): Date | null {
  return value ? parseDateOnly(value, field) : null;
}

/**
 * Audit in the caller's transaction. Metadata carries identifiers, statuses and field names
 * only: never candidate contact details, notes, feedback, answers or offer amounts.
 */
export function writeRecruitmentAudit(
  audit: AuditService,
  client: Tx,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: RecruitmentRequestContext;
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

/** A candidate-facing timeline entry (non-sensitive summary). */
export function recordActivity(
  tx: Tx,
  input: {
    organizationId: string;
    candidateId: string;
    applicationId?: string | null;
    type: RecruitmentActivityType;
    summary: string;
    relatedId?: string | null;
    actorUserId?: string | null;
    occurredAt?: Date;
  },
) {
  return tx.recruitmentActivity.create({
    data: {
      organizationId: input.organizationId,
      candidateId: input.candidateId,
      applicationId: input.applicationId ?? null,
      type: input.type,
      summary: input.summary.slice(0, 300),
      relatedId: input.relatedId ?? null,
      actorUserId: input.actorUserId ?? null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
  });
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export function candidateDisplayName(candidate: {
  firstName: string;
  lastName: string;
  preferredName: string | null;
}) {
  return `${candidate.preferredName || candidate.firstName} ${candidate.lastName}`.trim();
}

export function personDisplayName(
  person:
    | {
        firstName: string | null;
        lastName: string | null;
        preferredName: string | null;
      }
    | null
    | undefined,
) {
  if (!person) return null;
  return (
    [person.preferredName || person.firstName, person.lastName]
      .filter(Boolean)
      .join(' ') || null
  );
}
