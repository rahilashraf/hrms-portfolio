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
import {
  Prisma,
  type EmployeeWorkflowEventType,
} from '../generated/prisma/client.js';

export type OnboardingClient = PrismaService | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;
export type OnboardingRequestContext = DomainRequestContext;

/** The onboarding clock (overridden in tests). */
@Injectable()
export class OnboardingClock {
  now(): Date {
    return new Date();
  }
}

export const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));

/**
 * Lock order of every workflow write: EmployeeWorkflow (FOR NO KEY UPDATE) → its tasks.
 * Starting a workflow takes a transaction advisory lock on (assignment, kind) first.
 */
export async function lockWorkflow(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "EmployeeWorkflow" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`,
  );
  if (!rows[0]) throw new NotFoundException('Workflow not found.');
}

export async function lockTemplate(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "WorkflowTemplate" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`,
  );
  if (!rows[0]) throw new NotFoundException('Template not found.');
}

/** The organization's local date "today" (due dates, overdue). */
export function onboardingToday(
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

/** Audit metadata: identifiers, statuses and counts only — never notes, reasons or evidence. */
export function writeOnboardingAudit(
  audit: AuditService,
  client: Tx,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: OnboardingRequestContext;
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

export function workflowEvent(
  tx: Tx,
  input: {
    workflowId: string;
    taskId?: string | null;
    type: EmployeeWorkflowEventType;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string | null;
    actorUserId?: string | null;
  },
) {
  return tx.employeeWorkflowEvent.create({
    data: {
      workflowId: input.workflowId,
      taskId: input.taskId ?? null,
      type: input.type,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      note: input.note ?? null,
      actorUserId: input.actorUserId ?? null,
    },
  });
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
