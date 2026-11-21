import type { Prisma } from '../generated/prisma/client.js';

/** The published revision a correction or cancellation just appended. */
export interface AppendedShiftRevision {
  id: string;
  scheduledShiftId: string;
  revisionNumber: number;
  revisionType: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ScheduleRevisionReviewSignal {
  exceptionId: string;
  /** The reviewed attendance: a time entry, or (Phase 9.5) a sign-in. */
  timeEntryId: string | null;
  attendanceSignInId: string | null;
  employeeId: string;
  created: boolean;
  interpretedRevisionId: string;
  interpretedRevisionNumber: number;
}

/**
 * Phase 7 Batch 9 — Time & Attendance owns what a published schedule change means for
 * attendance already linked to the shift. A correction or cancellation never silently mutates a
 * TimeEntry or its interpretation: every live entry still interpreted against an older revision
 * gets one OPEN, non-blocking SCHEDULE_CHANGED_AFTER_ATTENDANCE review signal naming the
 * interpreted revision N and the current revision M. The entry keeps its revision reference
 * until a manager explicitly reinterprets it, so approved/locked payroll-sensitive history is
 * never rewritten. Repeated changes refresh the one open signal's current-revision metadata.
 *
 * Callers hold the shift row lock (FOR UPDATE), which serializes against clock-in linking.
 */
export async function raiseScheduleRevisionReviewSignals(
  tx: Prisma.TransactionClient,
  revision: AppendedShiftRevision,
  detectedAt: Date,
): Promise<ScheduleRevisionReviewSignal[]> {
  const entries = await tx.timeEntry.findMany({
    where: {
      scheduledShiftId: revision.scheduledShiftId,
      archivedAt: null,
      NOT: { scheduledShiftRevisionId: revision.id },
    },
    include: {
      scheduledShiftRevision: {
        select: {
          id: true,
          revisionNumber: true,
          startsAt: true,
          endsAt: true,
          status: true,
        },
      },
    },
    orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
  });
  const signals: ScheduleRevisionReviewSignal[] = [];
  for (const entry of entries) {
    const interpreted = entry.scheduledShiftRevision;
    if (!interpreted) continue;
    const change = revision.status === 'CANCELLED' ? 'CANCELLED' : 'CORRECTED';
    const metadata = {
      scheduledShiftId: revision.scheduledShiftId,
      interpretedRevisionId: interpreted.id,
      interpretedRevisionNumber: interpreted.revisionNumber,
      interpretedStartsAt: interpreted.startsAt.toISOString(),
      interpretedEndsAt: interpreted.endsAt.toISOString(),
      currentRevisionId: revision.id,
      currentRevisionNumber: revision.revisionNumber,
      currentRevisionType: revision.revisionType,
      currentStatus: revision.status,
      currentStartsAt: revision.startsAt.toISOString(),
      currentEndsAt: revision.endsAt.toISOString(),
      change,
    };
    const open = await tx.attendanceException.findFirst({
      where: {
        timeEntryId: entry.id,
        type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
        status: 'OPEN',
      },
      select: { id: true },
    });
    if (open) {
      await tx.attendanceException.update({
        where: { id: open.id },
        data: { metadata },
      });
      signals.push({
        exceptionId: open.id,
        timeEntryId: entry.id,
        attendanceSignInId: null,
        employeeId: entry.employeeId,
        created: false,
        interpretedRevisionId: interpreted.id,
        interpretedRevisionNumber: interpreted.revisionNumber,
      });
      continue;
    }
    const exception = await tx.attendanceException.create({
      data: {
        employeeId: entry.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
        severity: 'REVIEW',
        workflowImpact: 'NON_BLOCKING',
        status: 'OPEN',
        detectedAt,
        reason:
          change === 'CANCELLED'
            ? 'The scheduled shift was cancelled after attendance was interpreted against it.'
            : 'The scheduled shift was corrected after attendance was interpreted against it.',
        metadata,
      },
      select: { id: true },
    });
    signals.push({
      exceptionId: exception.id,
      timeEntryId: entry.id,
      attendanceSignInId: null,
      employeeId: entry.employeeId,
      created: true,
      interpretedRevisionId: interpreted.id,
      interpretedRevisionNumber: interpreted.revisionNumber,
    });
  }
  // Phase 9.5: an active sign-in linked to the shift gets the same review signal. Presence is
  // never re-linked or changed silently either.
  const signIns = await tx.attendanceSignIn.findMany({
    where: {
      scheduledShiftId: revision.scheduledShiftId,
      status: 'ACTIVE',
      NOT: { scheduledShiftRevisionId: revision.id },
    },
    include: {
      scheduledShiftRevision: {
        select: {
          id: true,
          revisionNumber: true,
          startsAt: true,
          endsAt: true,
        },
      },
    },
    orderBy: [{ signedInAt: 'asc' }, { id: 'asc' }],
  });
  for (const signIn of signIns) {
    const interpreted = signIn.scheduledShiftRevision;
    if (!interpreted) continue;
    const change = revision.status === 'CANCELLED' ? 'CANCELLED' : 'CORRECTED';
    const metadata = {
      scheduledShiftId: revision.scheduledShiftId,
      interpretedRevisionId: interpreted.id,
      interpretedRevisionNumber: interpreted.revisionNumber,
      interpretedStartsAt: interpreted.startsAt.toISOString(),
      interpretedEndsAt: interpreted.endsAt.toISOString(),
      currentRevisionId: revision.id,
      currentRevisionNumber: revision.revisionNumber,
      currentRevisionType: revision.revisionType,
      currentStatus: revision.status,
      currentStartsAt: revision.startsAt.toISOString(),
      currentEndsAt: revision.endsAt.toISOString(),
      change,
    };
    const open = await tx.attendanceException.findFirst({
      where: {
        attendanceSignInId: signIn.id,
        type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
        status: 'OPEN',
      },
      select: { id: true },
    });
    const exception = open
      ? await tx.attendanceException.update({
          where: { id: open.id },
          data: { metadata },
          select: { id: true },
        })
      : await tx.attendanceException.create({
          data: {
            employeeId: signIn.employeeId,
            employmentAssignmentId: signIn.employmentAssignmentId,
            attendanceSignInId: signIn.id,
            type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
            severity: 'REVIEW',
            workflowImpact: 'NON_BLOCKING',
            status: 'OPEN',
            detectedAt,
            reason:
              change === 'CANCELLED'
                ? 'The scheduled shift was cancelled after the sign-in was linked to it.'
                : 'The scheduled shift was corrected after the sign-in was linked to it.',
            metadata,
          },
          select: { id: true },
        });
    signals.push({
      exceptionId: exception.id,
      timeEntryId: null,
      attendanceSignInId: signIn.id,
      employeeId: signIn.employeeId,
      created: !open,
      interpretedRevisionId: interpreted.id,
      interpretedRevisionNumber: interpreted.revisionNumber,
    });
  }
  return signals;
}
