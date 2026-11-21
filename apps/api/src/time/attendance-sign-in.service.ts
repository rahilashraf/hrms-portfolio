import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  addDays,
  advisoryLock,
  domainError,
  formatDate,
  jsonValue,
  parseDateOnly,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  AttendanceSignIn,
  AttendanceSignOut,
  Prisma,
} from '../generated/prisma/client.js';
import { ScheduleAttendanceService } from '../scheduling/schedule-attendance.service.js';
import { TimeDomainService } from './time-domain.service.js';
import {
  APPROVED_ABSENCE_SOURCE,
  type ApprovedAbsenceSource,
  type AttendancePresenceFact,
  type AttendancePresenceSource,
} from './time-integration.contracts.js';
import {
  SystemClock,
  TimeService,
  type ClockActor,
  type KioskDevice,
  type TimeRequestContext,
} from './time.service.js';

type Tx = Prisma.TransactionClient;
type Client = PrismaService | Tx;

const MAX_RANGE_DAYS = 31;
/** Batch 4F (Q3): row caps; each list reports `truncated` when the range holds more. */
const MANAGED_SIGN_IN_CAP = 1000;
const EXPECTED_SIGN_IN_CAP = 2000;
const SELF_EXPECTED_CAP = 1000;

export interface SignInCaptureResult {
  outcome: 'SIGNED_IN' | 'ALREADY_SIGNED_IN';
  signIn: ReturnType<AttendanceSignInService['shape']>;
  exceptions: string[];
}

/**
 * Phase 9.5 — presence attendance (SIGN_IN_ONLY tracking). A sign-in is a completed fact: the
 * employee attended a work occurrence at an instant. It never opens a time entry, never has a
 * duration and never becomes worked minutes; it never receives clock-out or break exceptions.
 *
 * Scheduling stays the owner of expected work: a sign-in may link to the published shift (and
 * its immutable latest revision) it attended, chosen by the same eligibility windows as clock-in,
 * nearest start first, never a shift already signed in for. Duplicates are prevented without
 * blocking legitimate repeats: a retried request (same idempotency key) or a second sign-in for
 * the same shift returns the first; an unscheduled sign-in within the policy's duplicate window of
 * the previous one on the assignment does too. Corrections void and replace (MANUAL, with who and
 * why); nothing is ever edited or deleted.
 */
@Injectable()
export class AttendanceSignInService implements AttendancePresenceSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly domain: TimeDomainService,
    private readonly audit: AuditService,
    private readonly clock: SystemClock,
    @Optional() private readonly schedules?: ScheduleAttendanceService,
    @Optional()
    @Inject(APPROVED_ABSENCE_SOURCE)
    private readonly absences?: ApprovedAbsenceSource,
  ) {}

  // ─── Live capture ────────────────────────────────────────────────────────

  async selfSignIn(
    userId: string,
    input: {
      employmentAssignmentId: string;
      idempotencyKey?: string;
      /** Batch 4E-3 (C7): one of the caller's own occurrences open for sign-in now. */
      scheduledShiftId?: string;
    },
    context: TimeRequestContext,
  ) {
    const employee = await this.time.selfEmployee(userId);
    return this.capture(
      { channel: 'SELF_SERVICE', userId },
      employee,
      input.employmentAssignmentId,
      input.idempotencyKey,
      context,
      input.scheduledShiftId,
    );
  }

  async kioskSignIn(
    device: KioskDevice,
    employeeId: string,
    employmentAssignmentId: string,
    idempotencyKey: string | undefined,
    context: TimeRequestContext,
    /** Batch 4F (D2): the occurrence chosen among several offered at the kiosk. */
    scheduledShiftId?: string,
  ) {
    const employee = await this.time.kioskEmployee(employeeId);
    return this.capture(
      { channel: 'KIOSK', device },
      employee,
      employmentAssignmentId,
      idempotencyKey,
      {
        ...context,
        actorUserId: undefined,
        capture: { channel: 'KIOSK', attendanceDeviceId: device.id },
      },
      scheduledShiftId,
    );
  }

  private async capture(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['selfEmployee']>>,
    employmentAssignmentId: string,
    idempotencyKey: string | undefined,
    context: TimeRequestContext,
    chosenShiftId?: string,
  ): Promise<SignInCaptureResult> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const eligibility = await this.time.signInEligibility(
        actor,
        employee,
        employmentAssignmentId,
        now,
        tx,
      );
      // One employee's presence is recorded one at a time (duplicate checks below are exact).
      await advisoryLock(tx, `attendance:presence:${employee.id}`);
      if (idempotencyKey) {
        const repeated = await tx.attendanceSignIn.findUnique({
          where: {
            employeeId_idempotencyKey: {
              employeeId: employee.id,
              idempotencyKey,
            },
          },
        });
        if (repeated) {
          await this.requireSameSignInOperation(
            repeated,
            employee.id,
            employmentAssignmentId,
            eligibility.workDate,
            now,
            tx,
            chosenShiftId,
          );
          return this.duplicate(repeated);
        }
      }
      const match = chosenShiftId
        ? await this.matchChosenShift(
            employee.id,
            employmentAssignmentId,
            chosenShiftId,
            now,
            tx,
          )
        : await this.matchShift(employee.id, employmentAssignmentId, now, tx);
      if (match.alreadySignedIn) return this.duplicate(match.alreadySignedIn);
      // Batch 4F (D2): several occurrences open now and one already confirmed: a tap that
      // names none is the same arrival (inside the duplicate window), never silently the
      // other occurrence; after the window the employee must choose it explicitly.
      const signedSibling = (match as { signedSibling?: AttendanceSignIn })
        .signedSibling;
      if (signedSibling) {
        const window = eligibility.duplicateWindowMinutes;
        if (
          window > 0 &&
          signedSibling.signedInAt.getTime() >= now.getTime() - window * 60_000
        ) {
          return this.duplicate(signedSibling);
        }
        throw new ConflictException(
          domainError(
            409,
            'ATTENDANCE_OCCURRENCE_CHOICE_REQUIRED',
            'Several shifts are open now and one is already signed in. Choose the shift to sign in for.',
          ),
        );
      }
      let unscheduledMode: string | null = null;
      if (!match.link) {
        const window = eligibility.duplicateWindowMinutes;
        if (window > 0) {
          // Any recent sign-in, linked or not: a re-tap just after a shift's sign-in window
          // closed is the same arrival, not unscheduled work.
          const recent = await tx.attendanceSignIn.findFirst({
            where: {
              employmentAssignmentId,
              status: 'ACTIVE',
              signedInAt: {
                gte: new Date(now.getTime() - window * 60_000),
                lte: now,
              },
            },
            orderBy: { signedInAt: 'desc' },
          });
          if (recent) return this.duplicate(recent);
        }
        unscheduledMode = this.schedules
          ? await this.schedules.unscheduledWorkMode(
              employmentAssignmentId,
              eligibility.workDate,
              tx,
            )
          : 'ALLOW_UNSCHEDULED';
        if (unscheduledMode === 'REQUIRE_SCHEDULED_SHIFT') {
          throw new ForbiddenException(
            domainError(
              403,
              'SCHEDULED_SHIFT_REQUIRED',
              'A sign-in for this assignment needs a published shift open for it now.',
            ),
          );
        }
      }
      const signIn = await tx.attendanceSignIn.create({
        data: {
          employeeId: employee.id,
          employmentAssignmentId,
          signedInAt: now,
          timezone: eligibility.timezone,
          // Batch 4E-3 (C9): a sign-in for a published occurrence belongs to the occurrence's
          // work date (an overnight shift's sign-in after midnight included), as linked time
          // entries do since Batch 4D. New rows only; existing ones are never rewritten.
          workDate: match.link?.workDate ?? eligibility.workDate,
          source: actor.channel === 'KIOSK' ? 'KIOSK' : 'LIVE_CLOCK',
          attendanceDeviceId:
            actor.channel === 'KIOSK' ? actor.device.id : null,
          workLocationId: eligibility.assignment.position.workLocationId,
          scheduledShiftId: match.link?.shiftId ?? null,
          scheduledShiftRevisionId: match.link?.revisionId ?? null,
          idempotencyKey: idempotencyKey ?? null,
        },
      });
      await this.writeAudit(tx, 'ATTENDANCE_SIGNED_IN', signIn.id, context, {
        employeeId: employee.id,
        employmentAssignmentId,
        signedInAt: now.toISOString(),
        scheduledShiftId: signIn.scheduledShiftId,
        scheduledShiftRevisionId: signIn.scheduledShiftRevisionId,
      });
      const exceptions = await this.raisePresenceExceptions(
        tx,
        signIn,
        match.link,
        unscheduledMode,
        eligibility,
        context,
      );
      return {
        outcome: 'SIGNED_IN' as const,
        signIn: this.shape(signIn),
        exceptions,
      };
    });
  }

  // ─── Batch 4D (D-H): optional sign-out ───────────────────────────────────

  /**
   * Signs the employee out of their open sign-in for an assignment (self-service). Only where
   * the policy enables sign-out (attendance.signOutEnabled, off by default) and the channel may
   * capture for that assignment (the sign-in rules, so KIOSK_ONLY refuses self-service). A
   * presence fact only: never payable time. A retry with the same key, or signing out twice,
   * answers ALREADY_SIGNED_OUT.
   */
  async selfSignOut(
    userId: string,
    input: { employmentAssignmentId: string; idempotencyKey?: string },
    context: TimeRequestContext,
  ) {
    const employee = await this.time.selfEmployee(userId);
    return this.captureSignOut(
      { channel: 'SELF_SERVICE', userId },
      employee,
      input.employmentAssignmentId,
      input.idempotencyKey,
      context,
    );
  }

  async kioskSignOut(
    device: KioskDevice,
    employeeId: string,
    employmentAssignmentId: string,
    idempotencyKey: string | undefined,
    context: TimeRequestContext,
  ) {
    const employee = await this.time.kioskEmployee(employeeId);
    return this.captureSignOut(
      { channel: 'KIOSK', device },
      employee,
      employmentAssignmentId,
      idempotencyKey,
      {
        ...context,
        actorUserId: undefined,
        capture: { channel: 'KIOSK', attendanceDeviceId: device.id },
      },
    );
  }

  private async captureSignOut(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['selfEmployee']>>,
    employmentAssignmentId: string,
    idempotencyKey: string | undefined,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const eligibility = await this.time.signInEligibility(
        actor,
        employee,
        employmentAssignmentId,
        now,
        tx,
      );
      if (!eligibility.signOutEnabled) {
        throw new ForbiddenException(
          domainError(
            403,
            'ATTENDANCE_SIGN_OUT_DISABLED',
            'Signing out is not enabled for this assignment.',
          ),
        );
      }
      await advisoryLock(tx, `attendance:presence:${employee.id}`);
      const repeated = idempotencyKey
        ? await tx.attendanceSignOut.findUnique({
            where: {
              employeeId_idempotencyKey: {
                employeeId: employee.id,
                idempotencyKey,
              },
            },
          })
        : null;
      // A key names one sign-out operation: the same assignment's sign-out of one sign-in. It
      // never answers for another assignment.
      if (
        repeated &&
        repeated.employmentAssignmentId !== employmentAssignmentId
      ) {
        throw signOutKeyReused();
      }
      const latest = await tx.attendanceSignIn.findFirst({
        where: {
          employmentAssignmentId,
          status: 'ACTIVE',
          signedInAt: { gt: new Date(now.getTime() - 86_400_000), lt: now },
        },
        include: { signOuts: { where: { status: 'ACTIVE' } } },
        orderBy: { signedInAt: 'desc' },
      });
      if (repeated) {
        // A retry replays its own result. Reused for a later sign-in, it is another operation.
        if (latest && latest.id !== repeated.signInId) {
          throw signOutKeyReused();
        }
        return {
          outcome: 'ALREADY_SIGNED_OUT' as const,
          signOut: signOutShape(repeated),
        };
      }
      if (!latest) {
        throw new ConflictException(
          domainError(
            409,
            'ATTENDANCE_NOT_SIGNED_IN',
            'There is no sign-in of the last 24 hours to sign out of.',
          ),
        );
      }
      if (latest.signOuts[0]) {
        return {
          outcome: 'ALREADY_SIGNED_OUT' as const,
          signOut: signOutShape(latest.signOuts[0]),
        };
      }
      const signOut = await tx.attendanceSignOut.create({
        data: {
          signInId: latest.id,
          employeeId: employee.id,
          employmentAssignmentId,
          signedOutAt: now,
          source: actor.channel === 'KIOSK' ? 'KIOSK' : 'LIVE_CLOCK',
          attendanceDeviceId:
            actor.channel === 'KIOSK' ? actor.device.id : null,
          idempotencyKey: idempotencyKey ?? null,
        },
      });
      await this.writeAudit(tx, 'ATTENDANCE_SIGNED_OUT', latest.id, context, {
        employeeId: employee.id,
        employmentAssignmentId,
        signOutId: signOut.id,
        signedOutAt: now.toISOString(),
      });
      return { outcome: 'SIGNED_OUT' as const, signOut: signOutShape(signOut) };
    });
  }

  /**
   * A manager records (or, after voiding the old one, corrects) the sign-out of a sign-in:
   * time.correct on the assignment, never one's own, a reason; the local time is typed (D-C
   * daylight-saving rules). Recorded even where self-service sign-out is not enabled, as for
   * manual sign-ins.
   */
  async recordManualSignOut(
    userId: string,
    signInId: string,
    input: { signedOutAt: string; reason: string },
    context: TimeRequestContext,
  ) {
    const reason = this.requireReason(input.reason);
    return this.prisma.$transaction(async (tx) => {
      const signIn = await this.lockedForCorrection(tx, userId, signInId);
      const signedOutAt = this.domain.parseLocalDateTime(
        input.signedOutAt,
        signIn.timezone,
      );
      if (signedOutAt.getTime() > this.clock.now().getTime()) {
        throw new BadRequestException(
          domainError(
            400,
            'ATTENDANCE_SIGN_OUT_IN_FUTURE',
            'A sign-out cannot be recorded in the future.',
          ),
        );
      }
      if (
        signedOutAt <= signIn.signedInAt ||
        signedOutAt.getTime() > signIn.signedInAt.getTime() + 86_400_000
      ) {
        throw new BadRequestException(
          domainError(
            400,
            'ATTENDANCE_SIGN_OUT_RANGE',
            'A sign-out is after its sign-in, within 24 hours.',
          ),
        );
      }
      const active = await tx.attendanceSignOut.findFirst({
        where: { signInId: signIn.id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (active) {
        throw new ConflictException(
          domainError(
            409,
            'ATTENDANCE_ALREADY_SIGNED_OUT',
            'The sign-in already has a sign-out. Void it first to correct it.',
            { signOutId: active.id },
          ),
        );
      }
      const signOut = await tx.attendanceSignOut.create({
        data: {
          signInId: signIn.id,
          employeeId: signIn.employeeId,
          employmentAssignmentId: signIn.employmentAssignmentId,
          signedOutAt,
          source: 'MANUAL',
          recordedByUserId: userId,
          reason,
        },
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_SIGN_OUT_RECORDED',
        signIn.id,
        context,
        {
          employeeId: signIn.employeeId,
          employmentAssignmentId: signIn.employmentAssignmentId,
          signOutId: signOut.id,
          signedOutAt: signedOutAt.toISOString(),
          reason,
        },
      );
      return signOutShape(signOut);
    });
  }

  /** Voids a sign-out (it stays in history); a manager may then record the right one. */
  async voidSignOut(
    userId: string,
    signOutId: string,
    reasonInput: string,
    context: TimeRequestContext,
  ) {
    const reason = this.requireReason(reasonInput);
    return this.prisma.$transaction(async (tx) => {
      // Batch 4F (D4, D9): visibility before the row lock (see lockedForCorrection).
      const unlocked = await tx.attendanceSignOut.findUnique({
        where: { id: signOutId },
        select: {
          signIn: {
            select: {
              employeeId: true,
              employmentAssignment: { select: { positionId: true } },
            },
          },
        },
      });
      if (!unlocked) throw new NotFoundException('Sign-out not found.');
      await this.time.assertPositionVisible(
        userId,
        unlocked.signIn.employmentAssignment.positionId,
        // Batch 4F (D4/Q2): time.view makes sign-ins visible (manager lists): 403, not 404.
        ['time.view', 'time.correct'],
        'Sign-out not found.',
        tx,
        unlocked.signIn.employeeId,
      );
      await tx.$queryRaw`SELECT "id" FROM "AttendanceSignOut" WHERE "id" = ${signOutId}::uuid FOR UPDATE`;
      const signOut = await tx.attendanceSignOut.findUnique({
        where: { id: signOutId },
      });
      if (!signOut) throw new NotFoundException('Sign-out not found.');
      // The sign-in's own correction rules: time.correct, never one's own (it must be ACTIVE).
      await this.lockedForCorrection(tx, userId, signOut.signInId);
      if (signOut.status !== 'ACTIVE') {
        throw new ConflictException(
          domainError(
            409,
            'ATTENDANCE_SIGN_OUT_VOIDED',
            'The sign-out is already voided.',
          ),
        );
      }
      const voided = await tx.attendanceSignOut.update({
        where: { id: signOut.id },
        data: {
          status: 'VOIDED',
          voidedAt: this.clock.now(),
          voidedByUserId: userId,
          voidReason: reason,
        },
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_SIGN_OUT_VOIDED',
        signOut.signInId,
        context,
        {
          employeeId: signOut.employeeId,
          employmentAssignmentId: signOut.employmentAssignmentId,
          signOutId: signOut.id,
          reason,
        },
      );
      return signOutShape(voided);
    });
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  async mySignIns(userId: string, query: { from?: string; to?: string }) {
    // Batch 4F (C10): the caller's own history stays readable when Time & attendance is off.
    const employee = await this.time.selfEmployeeForRead(userId);
    const { from, to } = this.range(query.from, query.to);
    const rows = await this.prisma.attendanceSignIn.findMany({
      where: { employeeId: employee.id, workDate: { gte: from, lte: to } },
      orderBy: [{ signedInAt: 'desc' }, { id: 'asc' }],
      include: this.include(),
    });
    return {
      items: rows.map((row) => this.detailShape(row)),
      // Batch 4F (C10): the caller's organizations with Time & attendance turned off.
      attendanceDisabledOrganizationIds:
        await this.time.disabledOrganizationsOfEmployee(employee.id),
    };
  }

  /** Sign-ins in an organization and range that the user may view (time.view per position). */
  async managedSignIns(
    userId: string,
    query: {
      organizationId: string;
      from?: string;
      to?: string;
      employeeId?: string;
      includeVoided?: boolean;
      includeDisabledOrganizations?: boolean;
    },
  ) {
    const { from, to } = this.range(query.from, query.to);
    // Batch 4F (D5): authorization first (the organization's feature state is not revealed to
    // an outsider), and in the query itself, before the row limit.
    const position = await this.readablePositions(userId, query.organizationId);
    // Phase 18: an organization's sign-in administration needs Time & attendance enabled,
    // except to read its history (Batch 4F, C10), which then offers no action.
    const attendanceEnabled =
      (
        await this.time.features.disabledAmong('ATTENDANCE', [
          query.organizationId,
        ])
      ).size === 0;
    if (!attendanceEnabled && !query.includeDisabledOrganizations) {
      await this.time.features.require(query.organizationId, 'ATTENDANCE');
    }
    const fetched = await this.prisma.attendanceSignIn.findMany({
      where: {
        workDate: { gte: from, lte: to },
        employmentAssignment: { position },
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        ...(query.includeVoided ? {} : { status: 'ACTIVE' as const }),
      },
      orderBy: [{ signedInAt: 'desc' }, { id: 'asc' }],
      include: this.include(),
      take: MANAGED_SIGN_IN_CAP + 1,
    });
    const truncated = fetched.length > MANAGED_SIGN_IN_CAP;
    const rows = fetched.slice(0, MANAGED_SIGN_IN_CAP);
    const actorEmployeeId = await this.employeeIdOfUser(userId);
    const items = [];
    for (const row of rows) {
      const positionId = row.employmentAssignment.positionId;
      const canCorrect =
        attendanceEnabled &&
        row.status === 'ACTIVE' &&
        row.employeeId !== actorEmployeeId &&
        (await this.time.canOnAssignment(userId, 'time.correct', positionId));
      items.push({
        ...this.detailShape(row),
        actions: { canVoid: canCorrect, canCorrect },
      });
    }
    // Batch 4F (Q3): never imply a partial list is complete.
    return {
      items,
      truncated,
      limit: MANAGED_SIGN_IN_CAP,
      attendanceDisabledOrganizationIds: attendanceEnabled
        ? []
        : [query.organizationId],
    };
  }

  /**
   * Batch 4F (D5): the position filter of the caller's time.view scope in the organization;
   * 403 when they hold time.view nowhere in it.
   */
  private async readablePositions(
    userId: string,
    organizationId: string,
  ): Promise<Prisma.PositionWhereInput> {
    const readable = await this.time.readablePositionIds(
      userId,
      'time.view',
      organizationId,
    );
    if (readable === null) {
      throw new ForbiddenException(
        'Missing permission time.view for the organization.',
      );
    }
    return readable === 'ALL'
      ? { organizationId }
      : { organizationId, id: { in: readable } };
  }

  /**
   * Batch 4F (Q3): approved absence of each employee over the whole span, read once per
   * employee (bounded by the row cap) instead of once per shift; checked in memory.
   */
  private async absenceLookup(
    shifts: Array<{ employeeId: string; startsAt: Date; endsAt: Date }>,
  ) {
    const byEmployee = new Map<string, { start: Date; end: Date }>();
    for (const shift of shifts) {
      const span = byEmployee.get(shift.employeeId);
      if (!span) {
        byEmployee.set(shift.employeeId, {
          start: shift.startsAt,
          end: shift.endsAt,
        });
        continue;
      }
      if (shift.startsAt < span.start) span.start = shift.startsAt;
      if (shift.endsAt > span.end) span.end = shift.endsAt;
    }
    const intervals = new Map<string, Array<{ start: number; end: number }>>();
    if (this.absences) {
      for (const [employeeId, span] of byEmployee) {
        const absences = await this.absences.approvedAbsences({
          employeeId,
          start: span.start.toISOString(),
          end: span.end.toISOString(),
        });
        intervals.set(
          employeeId,
          absences.map((absence) => ({
            start: new Date(absence.start).getTime(),
            end: new Date(absence.end).getTime(),
          })),
        );
      }
    }
    // The same overlap rule as the per-shift query: start < shift end and end > shift start.
    return (employeeId: string, start: Date, end: Date) =>
      (intervals.get(employeeId) ?? []).some(
        (absence) =>
          absence.start < end.getTime() && absence.end > start.getTime(),
      );
  }

  /**
   * Published shifts of SIGN_IN_ONLY assignments in a range, with whether each was attended:
   * SIGNED_IN (with how late), EXCUSED (approved absence), MISSING (the occurrence has ended
   * without a sign-in) or PENDING. Computed on read; Scheduling's published shifts are the
   * source of expected work and are never changed.
   */
  async expectedSignIns(
    userId: string,
    query: { organizationId: string; from?: string; to?: string },
  ) {
    const { from, to } = this.range(query.from, query.to);
    const now = this.clock.now();
    // Batch 4F (D5): authorization first, and in the query before the row limit.
    const position = await this.readablePositions(userId, query.organizationId);
    // Phase 18: expected sign-ins read published schedules: both modules must be enabled.
    await this.time.features.requireAll(query.organizationId, [
      'ATTENDANCE',
      'SCHEDULING',
    ]);
    const fetched = await this.prisma.scheduledShift.findMany({
      where: {
        status: 'ACTIVE',
        schedule: { status: 'PUBLISHED' },
        workDate: { gte: from, lte: to },
        employmentAssignment: { position },
      },
      include: {
        revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 },
        employmentAssignment: {
          select: {
            id: true,
            employeeId: true,
            positionId: true,
            position: { select: { name: true } },
            employee: {
              select: {
                employeeNumber: true,
                person: {
                  select: {
                    firstName: true,
                    lastName: true,
                    preferredName: true,
                  },
                },
              },
            },
          },
        },
        attendanceSignIns: {
          where: { status: 'ACTIVE' },
          select: { id: true, signedInAt: true, source: true },
        },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: EXPECTED_SIGN_IN_CAP + 1,
    });
    const truncated = fetched.length > EXPECTED_SIGN_IN_CAP;
    const shifts = fetched.slice(0, EXPECTED_SIGN_IN_CAP);
    const isExcused = await this.absenceLookup(
      shifts.flatMap((shift) =>
        shift.revisions[0] && shift.attendanceSignIns.length === 0
          ? [
              {
                employeeId: shift.employmentAssignment.employeeId,
                startsAt: shift.revisions[0].startsAt,
                endsAt: shift.revisions[0].endsAt,
              },
            ]
          : [],
      ),
    );
    const modes = new Map<string, string | null>();
    const rows = [];
    for (const shift of shifts) {
      const revision = shift.revisions[0];
      if (!revision) continue;
      const assignment = shift.employmentAssignment;
      const modeKey = `${assignment.id}:${formatDate(shift.workDate)}`;
      if (!modes.has(modeKey)) {
        modes.set(
          modeKey,
          await this.time.trackingModeOn(assignment.id, shift.workDate),
        );
      }
      if (modes.get(modeKey) !== 'SIGN_IN_ONLY') continue;
      const signIn = shift.attendanceSignIns[0] ?? null;
      let status: 'SIGNED_IN' | 'EXCUSED' | 'MISSING' | 'PENDING';
      if (signIn) status = 'SIGNED_IN';
      else if (
        isExcused(assignment.employeeId, revision.startsAt, revision.endsAt)
      ) {
        status = 'EXCUSED';
      } else
        status =
          revision.endsAt.getTime() < now.getTime() ? 'MISSING' : 'PENDING';
      const person = assignment.employee.person;
      rows.push({
        scheduledShiftId: shift.id,
        scheduledShiftRevisionId: revision.id,
        employmentAssignmentId: assignment.id,
        employeeId: assignment.employeeId,
        employeeNumber: assignment.employee.employeeNumber,
        employeeName:
          [person.preferredName ?? person.firstName, person.lastName]
            .filter(Boolean)
            .join(' ') || null,
        positionName: assignment.position.name,
        workDate: formatDate(shift.workDate),
        startsAt: revision.startsAt.toISOString(),
        endsAt: revision.endsAt.toISOString(),
        timezone: revision.timezone,
        status,
        signIn: signIn
          ? {
              id: signIn.id,
              signedInAt: signIn.signedInAt.toISOString(),
              source: signIn.source,
              minutesAfterStart: Math.max(
                0,
                Math.floor(
                  (signIn.signedInAt.getTime() - revision.startsAt.getTime()) /
                    60_000,
                ),
              ),
            }
          : null,
      });
    }
    // Batch 4F (Q3): never imply a partial list is complete.
    return { items: rows, truncated, limit: EXPECTED_SIGN_IN_CAP };
  }

  /**
   * Batch 4E-3 (C8) — the caller's own published shifts in a range (31 days at most) and what
   * attendance shows for each, for My Time and My Schedule. Nothing is recomputed here:
   *
   * - presence (SIGN_IN_ONLY on the shift's work date): the manager's expected-sign-ins rule —
   *   signed in, excused (approved absence), MISSING only once the shift has ended;
   * - timed work: the entries linked to the shift; MISSING only where the no-show detection
   *   (policy- and automation-gated) recorded a no-show for the current revision; otherwise
   *   UPCOMING before the start, DUE while it runs, NOT_RECORDED once it ended;
   * - LATE from the late exceptions recorded at capture (their grace already applied);
   * - CANCELLED shifts, and CHANGED_AFTER_ATTENDANCE where the attendance belongs to an earlier
   *   revision (or a cancelled shift).
   *
   * Overnight shifts are listed under their own work date; instants are ISO with the shift's
   * time zone. Presence carries no minutes.
   */
  async myExpectedAttendance(
    userId: string,
    query: { from?: string; to?: string },
  ) {
    // Batch 4F (C10): the caller's own history stays readable when Time & attendance is off.
    const employee = await this.time.selfEmployeeForRead(userId);
    const { from, to } = this.range(query.from, query.to);
    const now = this.clock.now();
    const schedulingOff = [
      ...(await this.time.features.disabledOrganizations('SCHEDULING')),
    ];
    const fetched = await this.prisma.scheduledShift.findMany({
      where: {
        employmentAssignment: {
          employeeId: employee.id,
          position: { organizationId: { notIn: schedulingOff } },
        },
        schedule: { status: 'PUBLISHED' },
        workDate: { gte: from, lte: to },
      },
      include: {
        revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 },
        employmentAssignment: {
          select: {
            id: true,
            position: {
              select: {
                id: true,
                name: true,
                organization: { select: { id: true, name: true } },
              },
            },
          },
        },
        attendanceSignIns: {
          where: { status: 'ACTIVE' },
          select: {
            id: true,
            signedInAt: true,
            source: true,
            scheduledShiftRevisionId: true,
            signOuts: {
              where: { status: 'ACTIVE' },
              select: { id: true, signedOutAt: true },
            },
          },
        },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: SELF_EXPECTED_CAP + 1,
    });
    // Batch 4F (Q3): bounded, and said so when the range holds more.
    const truncated = fetched.length > SELF_EXPECTED_CAP;
    const shifts = fetched.slice(0, SELF_EXPECTED_CAP);
    const shiftIds = shifts.map((shift) => shift.id);
    const entries =
      shiftIds.length === 0
        ? []
        : await this.prisma.timeEntry.findMany({
            where: {
              employeeId: employee.id,
              scheduledShiftId: { in: shiftIds },
              status: { not: 'VOIDED' },
            },
            select: {
              id: true,
              scheduledShiftId: true,
              scheduledShiftRevisionId: true,
              clockInAt: true,
              clockOutAt: true,
              status: true,
            },
            orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
          });
    const signInIds = shifts.flatMap((shift) =>
      shift.attendanceSignIns.map((signIn) => signIn.id),
    );
    const exceptions =
      shiftIds.length === 0
        ? []
        : await this.prisma.attendanceException.findMany({
            where: {
              employeeId: employee.id,
              OR: [
                { scheduledShiftId: { in: shiftIds } },
                { attendanceSignInId: { in: signInIds } },
                {
                  timeEntryId: {
                    in: entries.map((entry) => entry.id),
                  },
                },
              ],
            },
            select: {
              id: true,
              type: true,
              status: true,
              scheduledShiftId: true,
              scheduledShiftRevisionId: true,
              attendanceSignInId: true,
              timeEntryId: true,
            },
          });
    const isExcused = await this.absenceLookup(
      shifts.flatMap((shift) =>
        shift.revisions[0]
          ? [
              {
                employeeId: employee.id,
                startsAt: shift.revisions[0].startsAt,
                endsAt: shift.revisions[0].endsAt,
              },
            ]
          : [],
      ),
    );
    const modes = new Map<string, string | null>();
    const items = [];
    for (const shift of shifts) {
      const revision = shift.revisions[0];
      if (!revision) continue;
      const assignment = shift.employmentAssignment;
      const modeKey = `${assignment.id}:${formatDate(shift.workDate)}`;
      if (!modes.has(modeKey)) {
        modes.set(
          modeKey,
          await this.time.trackingModeOn(assignment.id, shift.workDate),
        );
      }
      const trackingMode = modes.get(modeKey) ?? null;
      const signIn = shift.attendanceSignIns[0] ?? null;
      const linkedEntries = entries.filter(
        (entry) => entry.scheduledShiftId === shift.id,
      );
      const related = exceptions.filter(
        (exception) =>
          exception.scheduledShiftId === shift.id ||
          (signIn && exception.attendanceSignInId === signIn.id) ||
          linkedEntries.some((entry) => entry.id === exception.timeEntryId),
      );
      const counted = (types: string[]) =>
        related.some(
          (exception) =>
            types.includes(exception.type) &&
            (exception.status === 'OPEN' || exception.status === 'RESOLVED'),
        );
      const attendedAt =
        signIn?.signedInAt ?? linkedEntries[0]?.clockInAt ?? null;
      const attendedRevisions = [
        ...(signIn ? [signIn.scheduledShiftRevisionId] : []),
        ...linkedEntries.map((entry) => entry.scheduledShiftRevisionId),
      ];
      const changedAfterAttendance =
        attendedRevisions.length > 0 &&
        (shift.status === 'CANCELLED' ||
          attendedRevisions.some((id) => id !== revision.id));
      let status:
        | 'UPCOMING'
        | 'DUE'
        | 'ATTENDED'
        | 'LATE'
        | 'MISSING'
        | 'NOT_RECORDED'
        | 'EXCUSED'
        | 'CANCELLED'
        | 'CHANGED_AFTER_ATTENDANCE';
      if (changedAfterAttendance) status = 'CHANGED_AFTER_ATTENDANCE';
      else if (shift.status === 'CANCELLED') status = 'CANCELLED';
      else if (attendedAt) {
        status = counted(['LATE_SIGN_IN', 'LATE_ARRIVAL'])
          ? 'LATE'
          : 'ATTENDED';
      } else if (isExcused(employee.id, revision.startsAt, revision.endsAt)) {
        status = 'EXCUSED';
      } else if (now < revision.startsAt) status = 'UPCOMING';
      else if (trackingMode === 'SIGN_IN_ONLY') {
        // The manager's expected-sign-ins rule: missing only once the shift has ended.
        status = revision.endsAt < now ? 'MISSING' : 'DUE';
      } else if (
        related.some(
          (exception) =>
            exception.type === 'NO_SHOW' &&
            exception.scheduledShiftRevisionId === revision.id &&
            (exception.status === 'OPEN' || exception.status === 'RESOLVED'),
        )
      ) {
        status = 'MISSING';
      } else status = revision.endsAt < now ? 'NOT_RECORDED' : 'DUE';
      items.push({
        scheduledShiftId: shift.id,
        scheduledShiftRevisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        shiftStatus: shift.status,
        employmentAssignmentId: assignment.id,
        position: {
          id: assignment.position.id,
          name: assignment.position.name,
        },
        organization: assignment.position.organization,
        workDate: formatDate(shift.workDate),
        startsAt: revision.startsAt.toISOString(),
        endsAt: revision.endsAt.toISOString(),
        timezone: revision.timezone,
        trackingMode,
        status,
        minutesAfterStart: attendedAt
          ? Math.max(
              0,
              Math.floor(
                (attendedAt.getTime() - revision.startsAt.getTime()) / 60_000,
              ),
            )
          : null,
        signIn: signIn
          ? {
              id: signIn.id,
              signedInAt: signIn.signedInAt.toISOString(),
              source: signIn.source,
              signedOutAt:
                signIn.signOuts[0]?.signedOutAt.toISOString() ?? null,
            }
          : null,
        timeEntries: linkedEntries.map((entry) => ({
          id: entry.id,
          clockInAt: entry.clockInAt.toISOString(),
          clockOutAt: entry.clockOutAt?.toISOString() ?? null,
          status: entry.status,
        })),
        exceptions: related.map((exception) => ({
          id: exception.id,
          type: exception.type,
          status: exception.status,
        })),
      });
    }
    return {
      from: formatDate(from),
      to: formatDate(to),
      items,
      truncated,
      limit: SELF_EXPECTED_CAP,
      // Batch 4F (C10): the caller's organizations with Time & attendance turned off.
      attendanceDisabledOrganizationIds:
        await this.time.disabledOrganizationsOfEmployee(employee.id),
    };
  }

  /** The payroll-facing presence facts (no minutes, ever). */
  async presenceFactsBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<AttendancePresenceFact[]> {
    const db = (client as Client | undefined) ?? this.prisma;
    const rows = await db.attendanceSignIn.findMany({
      where: {
        employmentAssignmentId: query.employmentAssignmentId,
        status: 'ACTIVE',
        workDate: {
          gte: parseDateOnly(query.from, 'from'),
          lte: parseDateOnly(query.to, 'to'),
        },
      },
      orderBy: [{ signedInAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      signInId: row.id,
      employeeId: row.employeeId,
      employmentAssignmentId: row.employmentAssignmentId,
      workDate: formatDate(row.workDate),
      signedInAt: row.signedInAt.toISOString(),
      timezone: row.timezone,
      source: row.source,
      scheduledShiftId: row.scheduledShiftId,
      scheduledShiftRevisionId: row.scheduledShiftRevisionId,
    }));
  }

  // ─── Corrections (time.correct, never one's own) ──────────────────────────

  /** Records a sign-in that did not happen at a kiosk or online (MANUAL, with a reason). */
  async recordManual(
    userId: string,
    input: {
      employmentAssignmentId: string;
      signedInAt: string;
      reason: string;
      scheduledShiftId?: string;
    },
    context: TimeRequestContext,
  ) {
    const reason = this.requireReason(input.reason);
    return this.prisma.$transaction(async (tx) => {
      const created = await this.createManual(tx, userId, {
        employmentAssignmentId: input.employmentAssignmentId,
        signedInAtLocal: input.signedInAt,
        reason,
        scheduledShiftId: input.scheduledShiftId,
        replaces: null,
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_SIGN_IN_RECORDED',
        created.signIn.id,
        context,
        {
          employeeId: created.signIn.employeeId,
          employmentAssignmentId: created.signIn.employmentAssignmentId,
          signedInAt: created.signIn.signedInAt.toISOString(),
          scheduledShiftId: created.signIn.scheduledShiftId,
          reason,
        },
      );
      const exceptions = await this.raisePresenceExceptions(
        tx,
        created.signIn,
        created.link,
        null,
        created.eligibility,
        context,
      );
      return { signIn: this.shape(created.signIn), exceptions };
    });
  }

  /** Voids a sign-in (e.g. a duplicate); it stays in history, its signals are superseded. */
  async voidSignIn(
    userId: string,
    signInId: string,
    reasonInput: string,
    context: TimeRequestContext,
  ) {
    const reason = this.requireReason(reasonInput);
    return this.prisma.$transaction(async (tx) => {
      const signIn = await this.lockedForCorrection(tx, userId, signInId);
      const voided = await this.voidRow(tx, signIn, userId, reason);
      await this.writeAudit(
        tx,
        'ATTENDANCE_SIGN_IN_VOIDED',
        signIn.id,
        context,
        {
          employeeId: signIn.employeeId,
          employmentAssignmentId: signIn.employmentAssignmentId,
          reason,
        },
      );
      return this.shape(voided);
    });
  }

  /** Corrects a sign-in: voids it and records a linked MANUAL replacement. */
  async correctSignIn(
    userId: string,
    signInId: string,
    input: {
      signedInAt?: string;
      employmentAssignmentId?: string;
      scheduledShiftId?: string | null;
      reason: string;
    },
    context: TimeRequestContext,
  ) {
    const reason = this.requireReason(input.reason);
    return this.prisma.$transaction(async (tx) => {
      const original = await this.lockedForCorrection(tx, userId, signInId);
      const assignmentId =
        input.employmentAssignmentId ?? original.employmentAssignmentId;
      const signedInAtLocal =
        input.signedInAt ??
        this.domain.formatLocalDateTime(original.signedInAt, original.timezone);
      await this.voidRow(tx, original, userId, `Corrected: ${reason}`);
      const created = await this.createManual(tx, userId, {
        employmentAssignmentId: assignmentId,
        signedInAtLocal,
        reason,
        scheduledShiftId:
          input.scheduledShiftId === null
            ? null
            : (input.scheduledShiftId ??
              original.scheduledShiftId ??
              undefined),
        replaces: original,
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_SIGN_IN_CORRECTED',
        created.signIn.id,
        context,
        {
          employeeId: original.employeeId,
          correctedSignInId: original.id,
          before: this.shape(original),
          after: this.shape(created.signIn),
          reason,
        },
      );
      const exceptions = await this.raisePresenceExceptions(
        tx,
        created.signIn,
        created.link,
        null,
        created.eligibility,
        context,
      );
      return {
        signIn: this.shape(created.signIn),
        replaced: original.id,
        exceptions,
      };
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Batch 4D: an idempotency key names one sign-in operation, so a keyed request replays the
   * original sign-in only when it is a retry of that same operation:
   * - the same assignment;
   * - no later sign-in of that assignment since (else the key's sign-in is history);
   * - linked to a shift: that shift is still open for sign-in now;
   * - unscheduled: the same local work date, with no published shift now open for sign-in
   *   (which would be another occurrence).
   * Anything else is another operation: 409, never an unrelated earlier record.
   */
  private async requireSameSignInOperation(
    repeated: AttendanceSignIn,
    employeeId: string,
    employmentAssignmentId: string,
    workDate: Date,
    now: Date,
    tx: Tx,
    chosenShiftId?: string,
  ) {
    const reused = () =>
      new ConflictException(
        domainError(
          409,
          'ATTENDANCE_IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different sign-in.',
        ),
      );
    if (repeated.employmentAssignmentId !== employmentAssignmentId) {
      throw reused();
    }
    // Batch 4E-3 (C7): a key names one occurrence; it never answers for another one.
    if (chosenShiftId && repeated.scheduledShiftId !== chosenShiftId) {
      throw reused();
    }
    const later = await tx.attendanceSignIn.findFirst({
      where: {
        employmentAssignmentId,
        id: { not: repeated.id },
        signedInAt: { gt: repeated.signedInAt },
      },
      select: { id: true },
    });
    if (later) throw reused();
    const candidates = this.schedules
      ? await this.schedules.clockInCandidates(
          {
            employeeId,
            employmentAssignmentIds: [employmentAssignmentId],
            at: now,
          },
          tx,
        )
      : [];
    if (repeated.scheduledShiftId) {
      if (
        !candidates.some(
          (candidate) =>
            candidate.scheduledShiftId === repeated.scheduledShiftId,
        )
      ) {
        throw reused();
      }
      return;
    }
    if (repeated.workDate.getTime() !== workDate.getTime()) throw reused();
    if (candidates.length > 0) {
      const signed = await tx.attendanceSignIn.count({
        where: {
          scheduledShiftId: {
            in: candidates.map((candidate) => candidate.scheduledShiftId),
          },
          status: 'ACTIVE',
        },
      });
      if (signed < candidates.length) throw reused();
    }
  }

  private duplicate(existing: AttendanceSignIn): SignInCaptureResult {
    return {
      outcome: 'ALREADY_SIGNED_IN',
      signIn: this.shape(existing),
      exceptions: [],
    };
  }

  /**
   * Batch 4E-3 (C7): the occurrence the employee chose (self-service). It must be one of their
   * own published occurrences open for sign-in now (the same windows as automatic matching);
   * anything else (another employee's, another assignment's, closed, cancelled or not yet open)
   * is the same 400, so nothing about other shifts is revealed. One already confirmed answers
   * with its sign-in (ALREADY_SIGNED_IN), never a second one.
   */
  private async matchChosenShift(
    employeeId: string,
    employmentAssignmentId: string,
    scheduledShiftId: string,
    at: Date,
    tx: Tx,
  ): Promise<{
    link: {
      shiftId: string;
      revisionId: string;
      startsAt: Date;
      workDate: Date;
    } | null;
    alreadySignedIn?: AttendanceSignIn;
  }> {
    const notEligible = () =>
      new BadRequestException(
        domainError(
          400,
          'SCHEDULED_SHIFT_NOT_ELIGIBLE',
          'That occurrence is not open for sign-in now.',
        ),
      );
    if (!this.schedules) throw notEligible();
    const candidates = await this.schedules.clockInCandidates(
      { employeeId, employmentAssignmentIds: [employmentAssignmentId], at },
      tx,
    );
    if (
      !candidates.some(
        (candidate) => candidate.scheduledShiftId === scheduledShiftId,
      )
    ) {
      throw notEligible();
    }
    const existing = await tx.attendanceSignIn.findFirst({
      where: { scheduledShiftId, status: 'ACTIVE' },
    });
    if (existing) return { link: null, alreadySignedIn: existing };
    const locked = await this.schedules.lockPublishedShift(
      scheduledShiftId,
      tx,
    );
    if (
      !locked ||
      locked.shift.status !== 'ACTIVE' ||
      locked.shift.employmentAssignmentId !== employmentAssignmentId
    ) {
      throw notEligible();
    }
    return {
      link: {
        shiftId: scheduledShiftId,
        revisionId: locked.revision.id,
        startsAt: locked.revision.startsAt,
        workDate: locked.revision.workDate,
      },
    };
  }

  /**
   * The published shift a sign-in at `at` attends: an explicit one (manager records), or the
   * eligible one starting nearest to `at` that has no active sign-in yet. If every eligible
   * shift is already signed in for, that sign-in is the answer (a duplicate).
   */
  private async matchShift(
    employeeId: string,
    employmentAssignmentId: string,
    at: Date,
    tx: Tx,
    explicitShiftId?: string | null,
  ): Promise<{
    link: {
      shiftId: string;
      revisionId: string;
      startsAt: Date;
      workDate: Date;
    } | null;
    alreadySignedIn?: AttendanceSignIn;
    signedSibling?: AttendanceSignIn;
  }> {
    if (explicitShiftId === null) return { link: null };
    if (!this.schedules) {
      if (explicitShiftId) {
        throw new BadRequestException(
          'Scheduled shift linking is not available.',
        );
      }
      return { link: null };
    }
    if (explicitShiftId) {
      const locked = await this.schedules.lockPublishedShift(
        explicitShiftId,
        tx,
      );
      if (
        !locked ||
        locked.shift.status !== 'ACTIVE' ||
        locked.shift.employmentAssignmentId !== employmentAssignmentId
      ) {
        throw new BadRequestException(
          domainError(
            400,
            'SCHEDULED_SHIFT_NOT_ELIGIBLE',
            'The shift is not a published shift of this assignment.',
          ),
        );
      }
      return {
        link: {
          shiftId: explicitShiftId,
          revisionId: locked.revision.id,
          startsAt: locked.revision.startsAt,
          workDate: locked.revision.workDate,
        },
      };
    }
    const candidates = await this.schedules.clockInCandidates(
      { employeeId, employmentAssignmentIds: [employmentAssignmentId], at },
      tx,
    );
    if (candidates.length === 0) return { link: null };
    const signed = await tx.attendanceSignIn.findMany({
      where: {
        scheduledShiftId: {
          in: candidates.map((candidate) => candidate.scheduledShiftId),
        },
        status: 'ACTIVE',
      },
    });
    const open = candidates.filter(
      (candidate) =>
        !signed.some(
          (row) => row.scheduledShiftId === candidate.scheduledShiftId,
        ),
    );
    if (open.length === 0) return { link: null, alreadySignedIn: signed[0] };
    // Batch 4F (D2): another open occurrence is already confirmed; live capture without an
    // explicit choice treats that as ambiguous (see capture). Manual records keep the link.
    const signedSibling =
      signed.length > 0
        ? [...signed].sort(
            (a, b) => b.signedInAt.getTime() - a.signedInAt.getTime(),
          )[0]
        : undefined;
    const chosen = [...open].sort(
      (a, b) =>
        Math.abs(a.startsAt.getTime() - at.getTime()) -
          Math.abs(b.startsAt.getTime() - at.getTime()) ||
        a.startsAt.getTime() - b.startsAt.getTime(),
    )[0]!;
    const locked = await this.schedules.lockPublishedShift(
      chosen.scheduledShiftId,
      tx,
    );
    if (!locked || locked.shift.status !== 'ACTIVE') {
      return { link: null, signedSibling };
    }
    return {
      link: {
        shiftId: chosen.scheduledShiftId,
        revisionId: locked.revision.id,
        startsAt: locked.revision.startsAt,
        workDate: locked.revision.workDate,
      },
      signedSibling,
    };
  }

  private async raisePresenceExceptions(
    tx: Tx,
    signIn: AttendanceSignIn,
    link: { shiftId: string; startsAt: Date } | null,
    unscheduledMode: string | null,
    eligibility: { lateArrivalEnabled: boolean; lateGraceMinutes: number },
    context: TimeRequestContext,
  ) {
    const raised: string[] = [];
    const record = async (
      type: 'LATE_SIGN_IN' | 'UNSCHEDULED_SIGN_IN',
      reason: string,
      metadata: Record<string, unknown>,
    ) => {
      const exception = await tx.attendanceException.create({
        data: {
          employeeId: signIn.employeeId,
          employmentAssignmentId: signIn.employmentAssignmentId,
          attendanceSignInId: signIn.id,
          type,
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          detectedAt: signIn.signedInAt,
          reason,
          metadata: jsonValue(metadata),
        },
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_SIGN_IN_EXCEPTION_RECORDED',
        exception.id,
        context,
        {
          attendanceSignInId: signIn.id,
          type,
        },
      );
      raised.push(type);
    };
    if (link && eligibility.lateArrivalEnabled) {
      const minutesLate = Math.floor(
        (signIn.signedInAt.getTime() - link.startsAt.getTime()) / 60_000,
      );
      if (minutesLate > eligibility.lateGraceMinutes) {
        await record('LATE_SIGN_IN', 'Signed in after the scheduled start.', {
          scheduledShiftId: link.shiftId,
          expectedStart: link.startsAt.toISOString(),
          minutesLate,
        });
      }
    }
    if (!link && unscheduledMode === 'WARN_UNSCHEDULED') {
      await record(
        'UNSCHEDULED_SIGN_IN',
        'Signed in without a published shift open for it.',
        {
          signedInAt: signIn.signedInAt.toISOString(),
        },
      );
    }
    return raised;
  }

  private async createManual(
    tx: Tx,
    userId: string,
    input: {
      employmentAssignmentId: string;
      signedInAtLocal: string;
      reason: string;
      scheduledShiftId?: string | null;
      replaces: AttendanceSignIn | null;
    },
  ) {
    const { assignment, timezone } = await this.time.timezoneOf(
      input.employmentAssignmentId,
      tx,
    );
    // Batch 4F (D4): an assignment of an organization the caller cannot see is answered 404.
    await this.time.assertPositionVisible(
      userId,
      assignment.positionId,
      ['time.view', 'time.correct'],
      'Assignment not found.',
      tx,
      assignment.employeeId,
    );
    if (
      !(await this.time.canOnAssignment(
        userId,
        'time.correct',
        assignment.positionId,
        tx,
      ))
    ) {
      throw new ForbiddenException(
        'Missing permission time.correct for the assignment.',
      );
    }
    if (assignment.employeeId === (await this.employeeIdOfUser(userId))) {
      throw new ForbiddenException(
        domainError(
          403,
          'ATTENDANCE_SELF_CORRECTION',
          'You cannot record or correct your own attendance.',
        ),
      );
    }
    if (input.replaces && input.replaces.employeeId !== assignment.employeeId) {
      throw new BadRequestException(
        'A correction stays with the same employee.',
      );
    }
    const signedInAt = this.domain.parseLocalDateTime(
      input.signedInAtLocal,
      timezone,
    );
    if (signedInAt.getTime() > this.clock.now().getTime()) {
      throw new BadRequestException(
        domainError(
          400,
          'ATTENDANCE_SIGN_IN_IN_FUTURE',
          'A sign-in cannot be recorded in the future.',
        ),
      );
    }
    const workDate = this.domain.parseDateOnly(
      this.domain.deriveWorkDate(signedInAt, timezone),
    );
    if (
      assignment.status === 'CANCELLED' ||
      assignment.status === 'PLANNED' ||
      workDate < assignment.startDate ||
      (assignment.endDate && workDate > assignment.endDate)
    ) {
      throw new BadRequestException(
        'The assignment was not effective on that date.',
      );
    }
    if (
      (await this.time.trackingModeOn(assignment.id, workDate, tx)) !==
      'SIGN_IN_ONLY'
    ) {
      throw new ConflictException(
        domainError(
          409,
          'ATTENDANCE_TRACKING_MODE_MISMATCH',
          'This assignment records attendance by clocking in and out on that date, not by sign-in.',
        ),
      );
    }
    await advisoryLock(tx, `attendance:presence:${assignment.employeeId}`);
    const match = await this.matchShift(
      assignment.employeeId,
      assignment.id,
      signedInAt,
      tx,
      input.scheduledShiftId,
    );
    if (match.link) {
      const existing = await tx.attendanceSignIn.findFirst({
        where: { scheduledShiftId: match.link.shiftId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException(
          domainError(
            409,
            'ATTENDANCE_SIGN_IN_EXISTS',
            'That shift already has a sign-in.',
            {
              signInId: existing.id,
            },
          ),
        );
      }
    }
    const signIn = await tx.attendanceSignIn.create({
      data: {
        employeeId: assignment.employeeId,
        employmentAssignmentId: assignment.id,
        signedInAt,
        timezone,
        // Batch 4E-3 (C9): the linked occurrence's work date, as for live sign-ins.
        workDate: match.link?.workDate ?? workDate,
        source: 'MANUAL',
        workLocationId: assignment.position.workLocationId,
        scheduledShiftId: match.link?.shiftId ?? null,
        scheduledShiftRevisionId: match.link?.revisionId ?? null,
        recordedByUserId: userId,
        reason: input.reason,
        replacesSignInId: input.replaces?.id ?? null,
      },
    });
    const policyEligibility = await this.interpretationSettings(
      assignment.id,
      workDate,
      tx,
    );
    return { signIn, link: match.link, eligibility: policyEligibility };
  }

  /** Late-arrival settings of the policy in force on the work date (manual records). */
  private async interpretationSettings(
    assignmentId: string,
    workDate: Date,
    tx: Tx,
  ) {
    return this.time.interpretationSettingsOn(assignmentId, workDate, tx);
  }

  private async lockedForCorrection(tx: Tx, userId: string, signInId: string) {
    // Batch 4F (D4, D9): a sign-in of an organization the caller cannot see is answered 404,
    // before the row lock is taken (a sign-in never changes assignment).
    const unlocked = await tx.attendanceSignIn.findUnique({
      where: { id: signInId },
      select: {
        employeeId: true,
        employmentAssignment: { select: { positionId: true } },
      },
    });
    if (!unlocked) throw new NotFoundException('Sign-in not found.');
    await this.time.assertPositionVisible(
      userId,
      unlocked.employmentAssignment.positionId,
      ['time.view', 'time.correct'],
      'Sign-in not found.',
      tx,
      unlocked.employeeId,
    );
    await tx.$queryRaw`SELECT "id" FROM "AttendanceSignIn" WHERE "id" = ${signInId}::uuid FOR UPDATE`;
    const signIn = await tx.attendanceSignIn.findUnique({
      where: { id: signInId },
      include: { employmentAssignment: { select: { positionId: true } } },
    });
    if (!signIn) throw new NotFoundException('Sign-in not found.');
    if (
      !(await this.time.canOnAssignment(
        userId,
        'time.correct',
        signIn.employmentAssignment.positionId,
        tx,
      ))
    ) {
      throw new ForbiddenException(
        'Missing permission time.correct for the sign-in.',
      );
    }
    if (signIn.employeeId === (await this.employeeIdOfUser(userId))) {
      throw new ForbiddenException(
        domainError(
          403,
          'ATTENDANCE_SELF_CORRECTION',
          'You cannot record or correct your own attendance.',
        ),
      );
    }
    if (signIn.status !== 'ACTIVE') {
      throw new ConflictException(
        domainError(
          409,
          'ATTENDANCE_SIGN_IN_VOIDED',
          'The sign-in is already voided.',
        ),
      );
    }
    return signIn;
  }

  private async voidRow(
    tx: Tx,
    signIn: AttendanceSignIn,
    userId: string,
    reason: string,
  ) {
    const now = this.clock.now();
    const voided = await tx.attendanceSignIn.update({
      where: { id: signIn.id },
      data: {
        status: 'VOIDED',
        voidedAt: now,
        voidedByUserId: userId,
        voidReason: reason,
      },
    });
    await tx.attendanceException.updateMany({
      where: { attendanceSignInId: signIn.id, status: 'OPEN' },
      data: {
        status: 'SUPERSEDED',
        resolvedAt: now,
        resolutionMethod: 'MANAGER_RESOLUTION',
      },
    });
    return voided;
  }

  private range(fromInput?: string, toInput?: string) {
    const today = this.domain.parseDateOnly(
      this.clock.now().toISOString().slice(0, 10),
    );
    const to = toInput ? parseDateOnly(toInput, 'to') : today;
    const from = fromInput
      ? parseDateOnly(fromInput, 'from')
      : addDays(to, -(MAX_RANGE_DAYS - 1));
    if (to < from)
      throw new BadRequestException('to must be on or after from.');
    if ((to.getTime() - from.getTime()) / 86_400_000 >= MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `A range covers at most ${MAX_RANGE_DAYS} days.`,
      );
    }
    return { from, to };
  }

  private requireReason(value: string) {
    const reason = value?.trim();
    if (!reason) throw new BadRequestException('reason is required.');
    return reason;
  }

  private async employeeIdOfUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    return user?.person?.employee?.id ?? null;
  }

  private include() {
    return {
      employmentAssignment: {
        select: {
          positionId: true,
          position: { select: { name: true } },
          employee: {
            select: {
              employeeNumber: true,
              person: {
                select: {
                  firstName: true,
                  lastName: true,
                  preferredName: true,
                },
              },
            },
          },
        },
      },
      attendanceDevice: { select: { id: true, name: true } },
      // Batch 4D: the sign-in's active sign-out, if any.
      signOuts: { where: { status: 'ACTIVE' as const } },
      workLocation: { select: { id: true, name: true } },
      exceptions: { select: { id: true, type: true, status: true } },
    } as const;
  }

  shape(row: AttendanceSignIn) {
    return {
      id: row.id,
      employeeId: row.employeeId,
      employmentAssignmentId: row.employmentAssignmentId,
      signedInAt: row.signedInAt.toISOString(),
      timezone: row.timezone,
      workDate: formatDate(row.workDate),
      source: row.source,
      attendanceDeviceId: row.attendanceDeviceId,
      workLocationId: row.workLocationId,
      scheduledShiftId: row.scheduledShiftId,
      scheduledShiftRevisionId: row.scheduledShiftRevisionId,
      status: row.status,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidReason: row.voidReason,
      replacesSignInId: row.replacesSignInId,
      recordedByUserId: row.recordedByUserId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private detailShape(
    row: AttendanceSignIn & {
      employmentAssignment: {
        position: { name: string };
        employee: {
          employeeNumber: string;
          person: {
            firstName: string | null;
            lastName: string | null;
            preferredName: string | null;
          };
        };
      };
      attendanceDevice: { id: string; name: string } | null;
      workLocation: { id: string; name: string } | null;
      exceptions: Array<{ id: string; type: string; status: string }>;
      signOuts?: AttendanceSignOut[];
    },
  ) {
    const person = row.employmentAssignment.employee.person;
    return {
      ...this.shape(row),
      positionName: row.employmentAssignment.position.name,
      employeeNumber: row.employmentAssignment.employee.employeeNumber,
      employeeName:
        [person.preferredName ?? person.firstName, person.lastName]
          .filter(Boolean)
          .join(' ') || null,
      device: row.attendanceDevice,
      workLocation: row.workLocation,
      exceptions: row.exceptions,
      signOut: row.signOuts?.[0] ? signOutShape(row.signOuts[0]) : null,
    };
  }

  private writeAudit(
    client: Tx,
    action: string,
    entityId: string,
    context: TimeRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: action.includes('EXCEPTION')
          ? 'AttendanceException'
          : 'AttendanceSignIn',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(
          context.capture
            ? { ...metadata, capture: context.capture }
            : metadata,
        ),
      },
      client,
    );
  }
}

/** Batch 4D: an idempotency key reused for a different sign-out operation. */
function signOutKeyReused() {
  return new ConflictException(
    domainError(
      409,
      'ATTENDANCE_IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different sign-out.',
    ),
  );
}

/** Batch 4D: a sign-out as returned to readers. */
function signOutShape(row: AttendanceSignOut) {
  return {
    id: row.id,
    signInId: row.signInId,
    employmentAssignmentId: row.employmentAssignmentId,
    signedOutAt: row.signedOutAt.toISOString(),
    source: row.source,
    attendanceDeviceId: row.attendanceDeviceId,
    recordedByUserId: row.recordedByUserId,
    reason: row.reason,
    status: row.status,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
  };
}
