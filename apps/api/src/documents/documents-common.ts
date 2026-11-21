import {
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
import { Prisma } from '../generated/prisma/client.js';

export type DocumentsClient = PrismaService | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;
export type DocumentsRequestContext = DomainRequestContext;

/** The documents clock (overridden in tests). */
@Injectable()
export class DocumentsClock {
  now(): Date {
    return new Date();
  }
}

export const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));

/** Lock order: EmployeeDocument / PolicyDocument (FOR NO KEY UPDATE) → versions → acknowledgements. */
async function lockRow(tx: Tx, table: string, id: string, missing: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`,
  );
  if (!rows[0]) throw new NotFoundException(missing);
}

export const lockDocument = (tx: Tx, id: string) =>
  lockRow(tx, 'EmployeeDocument', id, 'Document not found.');
export const lockPolicy = (tx: Tx, id: string) =>
  lockRow(tx, 'PolicyDocument', id, 'Policy not found.');

export function documentsToday(
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
 * Audit in the caller's transaction. Metadata carries identifiers, levels, providers and field
 * names only: never document contents, links, file names, notes or acknowledgement text.
 */
export function writeDocumentsAudit(
  audit: AuditService,
  client: Tx,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: DocumentsRequestContext;
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

export function personName(
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
