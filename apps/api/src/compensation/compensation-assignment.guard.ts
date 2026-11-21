import { ConflictException } from '@nestjs/common';
import { domainError, formatDate } from '../common/domain-support.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  recordsOutsideAssignment,
  type AssignmentBounds,
} from './compensation-domain.js';

/**
 * Called by Core HR before it re-dates, ends, cancels or terminates an assignment: compensation is
 * never silently modified, so a change that would leave compensation outside the assignment (or
 * any compensation on a cancelled one) is refused with the records to change first. Locks the
 * assignment row (the shared first lock) so no compensation write can slip in between. The
 * database enforces the same rule (EmploymentAssignment_compensation_guard).
 */
export async function assertCompensationFitsAssignment(
  tx: Prisma.TransactionClient,
  assignmentId: string,
  next: {
    status: AssignmentBounds['status'];
    startDate: Date;
    endDate: Date | null;
  },
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "EmploymentAssignment" WHERE "id" = ${assignmentId}::uuid FOR NO KEY UPDATE`,
  );
  const timeline = await tx.compensationRecord.findMany({
    where: { employmentAssignmentId: assignmentId, supersededAt: null },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
    orderBy: { effectiveFrom: 'asc' },
  });
  const outside = recordsOutsideAssignment(timeline, next);
  if (outside.length > 0) {
    throw new ConflictException(
      domainError(
        409,
        'COMPENSATION_OUTSIDE_ASSIGNMENT',
        next.status === 'CANCELLED'
          ? 'The assignment has compensation; end or correct it before cancelling the assignment.'
          : 'The new assignment dates would leave compensation outside the assignment; change that compensation first.',
        {
          employmentAssignmentId: assignmentId,
          compensationRecords: outside.map((record) => ({
            id: record.id,
            effectiveFrom: formatDate(record.effectiveFrom),
            effectiveTo: record.effectiveTo && formatDate(record.effectiveTo),
          })),
        },
      ),
    );
  }
}
