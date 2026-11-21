import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  jsonValue,
  type DomainRequestContext,
} from '../common/domain-support.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

export type PayrollClient = PrismaService | Prisma.TransactionClient;
export type PayrollRequestContext = DomainRequestContext;

/** The payroll clock (overridden in tests). */
@Injectable()
export class PayrollClock {
  now(): Date {
    return new Date();
  }
}

/**
 * Lock order of every Payroll write: PayGroup → PayrollCalendar/PayrollPeriod → PayrollRun →
 * PayrollAdjustment. Source domains (Time, Leave, Compensation) are only read, never locked,
 * except Time's own TimePeriod/timesheet upserts that Payroll asks Time to perform after
 * taking its pay-group lock (Time never locks Payroll rows, so no cycle exists).
 *
 * The pay group is locked FOR NO KEY UPDATE: it serializes payroll configuration and period
 * generation of the pay group without blocking Compensation's foreign-key reads of it.
 */
export async function lockPayGroup(
  tx: Prisma.TransactionClient,
  payGroupId: string,
) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; organizationId: string; archivedAt: Date | null }>
  >(Prisma.sql`
    SELECT "id", "organizationId", "archivedAt" FROM "PayGroup"
    WHERE "id" = ${payGroupId}::uuid FOR NO KEY UPDATE`);
  const payGroup = rows[0];
  if (!payGroup) throw new NotFoundException('Pay group not found.');
  return payGroup;
}

export function assertPayGroupActive(payGroup: { archivedAt: Date | null }) {
  if (payGroup.archivedAt) {
    throw new ConflictException(
      domainError(
        409,
        'PAYROLL_PAY_GROUP_ARCHIVED',
        'The pay group is archived; its payroll cannot be configured or generated.',
      ),
    );
  }
}

/** Audit in the caller's transaction; metadata never carries personal or tax data. */
export function writePayrollAudit(
  audit: AuditService,
  client: Prisma.TransactionClient,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: PayrollRequestContext;
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
