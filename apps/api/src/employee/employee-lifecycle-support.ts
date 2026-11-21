import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { advisoryLock, domainError } from '../common/domain-support.js';

/**
 * Batch 5A — shared lifecycle helpers: strict date-only input, the lifecycle lock order and the
 * stable error shapes. Dates are calendar dates (YYYY-MM-DD) stored as UTC midnight; "today"
 * is always the assignment's own business date (work location, else organization time zone).
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD calendar date, or 400 (never an invalid Date reaching the database). */
export function strictDay(value: string, label: string): Date {
  if (typeof value !== 'string' || !DATE_ONLY.test(value))
    throw new BadRequestException(`${label} must be a YYYY-MM-DD date.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new BadRequestException(`${label} must be a valid date.`);
  return parsed;
}

export function optionalStrictDay(
  value: string | null | undefined,
  label: string,
): Date | null {
  return value === undefined || value === null ? null : strictDay(value, label);
}

export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: Date, days: number): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate() + days,
    ),
  );
}

/** The latest calendar date any time zone can be in now (UTC + 1 day bounds "today" everywhere). */
export function latestPossibleToday(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

/**
 * Lock order for every lifecycle operation (Batch 5A): the employee's lifecycle lock, then the
 * positions involved (sorted), then — only when employment actually ends — the employee's time
 * lock (the one time capture takes), then row locks. Time capture takes only the time lock, so
 * the order can never deadlock with it.
 */
export async function lockEmployeeLifecycle(
  tx: Prisma.TransactionClient,
  employeeId: string,
) {
  await advisoryLock(tx, `employee-lifecycle:${employeeId}`);
}

export async function lockPositions(
  tx: Prisma.TransactionClient,
  positionIds: string[],
) {
  for (const id of [...new Set(positionIds)].sort()) {
    await advisoryLock(tx, `employee-position:${id}`);
  }
}

/** The key time capture uses (TimeService.lockEmployeeTime); taken after the lifecycle lock. */
export async function lockEmployeeTimeForLifecycle(
  tx: Prisma.TransactionClient,
  employeeId: string,
) {
  await advisoryLock(tx, `time-employee:${employeeId}`);
}

export function lifecycleError(
  status: 400 | 403 | 404 | 409,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return domainError(status, code, message, details);
}

/**
 * R5: an assignment's status follows from its dates and the business date of its position
 * (start still to come: PLANNED; end already past: ENDED; otherwise ACTIVE).
 */
export function deriveAssignmentStatus(
  startDate: Date,
  endDate: Date | null,
  today: Date,
): 'PLANNED' | 'ACTIVE' | 'ENDED' {
  if (startDate.getTime() > today.getTime()) return 'PLANNED';
  if (endDate !== null && endDate.getTime() < today.getTime()) return 'ENDED';
  return 'ACTIVE';
}

/**
 * Batch 5B: an explicitly chosen manager assignment must exist (404) and its position must be
 * readable by the caller (403, as set-manager answers), before any relationship rule runs.
 */
export async function assertManagerVisible(
  tx: Prisma.TransactionClient,
  access: {
    assertPosition(
      userId: string,
      positionId: string,
      permission: string,
      client: Prisma.TransactionClient,
    ): Promise<unknown>;
  },
  actorUserId: string,
  managerAssignmentId: string,
) {
  const manager = await tx.employmentAssignment.findUnique({
    where: { id: managerAssignmentId },
    select: { positionId: true },
  });
  if (!manager) throw new NotFoundException('Manager assignment not found');
  await access.assertPosition(
    actorUserId,
    manager.positionId,
    'employee.read',
    tx,
  );
}
