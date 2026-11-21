import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { jsonValue } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { AttendanceSignInService } from '../time/attendance-sign-in.service.js';
import {
  TimeService,
  type KioskDevice,
  type TimeRequestContext,
  type KioskUnavailableCode,
} from '../time/time.service.js';
import {
  AttendanceCredentialService,
  IDENTIFICATION_FAILED,
} from './attendance-credential.service.js';
import { unauthorized } from './attendance-device.service.js';
import {
  KioskRateLimiterService,
  type KioskIdentifyReservation,
} from './kiosk-rate-limiter.service.js';
import {
  INTERACTION_TTL_MS,
  normalizeEmployeeNumber,
  randomSecret,
  sha256,
} from './kiosk-secrets.js';

export const KIOSK_ACTIONS = [
  'CLOCK_IN',
  'CLOCK_OUT',
  'START_BREAK',
  'END_BREAK',
  'SWITCH_ASSIGNMENT',
  'SIGN_IN',
  // Batch 4D (D-H): offered only where the policy enables sign-out and a sign-in is open.
  'SIGN_OUT',
] as const;
export type KioskAction = (typeof KIOSK_ACTIONS)[number];

export interface OfferedAction {
  action: KioskAction;
  employmentAssignmentId: string | null;
  /**
   * Multi-assignment clock-in (offered when several assignments are eligible): one physical
   * clock-in may cover any two or more of these; the chosen payroll owner is one of them.
   */
  coverableAssignments?: Array<{
    employmentAssignmentId: string;
    name: string;
    /**
     * Present when the assignment has several published shifts open now: if it is chosen as the
     * payroll owner, the employee picks the shift they are starting from these.
     */
    shifts?: Array<{ scheduledShiftId: string; label: string }>;
  }>;
  /**
   * Offered when the assignment has several published shifts open for clock-in: one option per
   * shift, because the time clock never guesses between them.
   */
  scheduledShiftId?: string;
  label: string;
}

export interface Interaction {
  deviceId: string;
  employeeId: string;
  credentialId: string;
  offered: Array<{
    action: KioskAction;
    employmentAssignmentId: string | null;
    coverableAssignmentIds?: string[];
    /** The owner shifts a multi-assignment clock-in may name, per coverable assignment. */
    coverableShifts?: Array<{
      employmentAssignmentId: string;
      scheduledShiftId: string;
    }>;
    scheduledShiftId?: string;
  }>;
}

/**
 * Phase 9.5 — the attendance kiosk flow at a trusted device:
 *  1. identify: employee number + PIN (rate-limited, one generic failure for everything) gives a
 *     single-use interaction token (90s, bound to the device) and only what is needed to act:
 *     a first name and the actions available now. No profile, pay, leave or history.
 *  2. act: the token is consumed atomically (a replay or double submission finds nothing), the
 *     credential and device are re-checked, and only an offered action runs, through exactly the
 *     same Time and sign-in rules as every other channel.
 * Kiosk attendance needs a connection: there is no offline queue (no replayable, backdatable
 * attendance); an unavailable kiosk is covered by managers' MANUAL records with a reason.
 */
export type KioskNoticeCode = KioskUnavailableCode | 'MISSED_CLOCK_OUT';

/**
 * What the employee is told at the kiosk, with the code shown as a reference for their manager.
 * Plain language only: no policy internals, nothing about other employees or organizations.
 */
export const KIOSK_NOTICES: Record<KioskNoticeCode, string> = {
  MISSED_CLOCK_OUT:
    'An earlier shift is missing its clock-out. Resolve it in My Time if you can, or ask your manager to correct it.',
  OPEN_ENTRY_NOT_AT_KIOSK:
    'You are clocked in for work that cannot be closed at this kiosk. Please ask your manager.',
  EMPLOYEE_NOT_ACTIVE:
    'Your employment is not active, so attendance cannot be recorded.',
  NO_ASSIGNMENT:
    'You have no position at this organization that records attendance here.',
  ASSIGNMENT_NOT_STARTED:
    'Your position has not started yet. Attendance can be recorded from its start date.',
  TIMEZONE_MISSING:
    'Your work location has no time zone set, so attendance cannot be recorded. Please tell your manager.',
  ASSIGNMENT_NOT_EFFECTIVE: 'You have no position that is active today.',
  ATTENDANCE_DISABLED: 'Time & attendance is turned off for your organization.',
  CAPTURE_NOT_AT_KIOSK:
    'Your attendance is not recorded at kiosks. Please ask your manager how to record it.',
  KIOSK_SITE_NOT_ALLOWED:
    'Your attendance is recorded at the kiosk of your own work site.',
  CLOCK_DISABLED:
    'Clocking in is not turned on for your position yet. Please tell your manager (time clock setting).',
  UNAVAILABLE:
    'There is nothing to record at this kiosk right now. If you expected to clock in or out, please ask your manager.',
};

@Injectable()
export class AttendanceKioskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly limiter: KioskRateLimiterService,
    private readonly credentials: AttendanceCredentialService,
    private readonly time: TimeService,
    private readonly signIns: AttendanceSignInService,
    private readonly audit: AuditService,
  ) {}

  /** The welcome screen: which kiosk this is (no employee data). */
  session(device: {
    id: string;
    name: string;
    physicalSite: { name: string };
    organization: { name: string; timezone?: string | null };
  }) {
    return {
      device: { id: device.id, name: device.name },
      location: {
        name: device.physicalSite.name,
        timezone: device.organization.timezone ?? null,
      },
      organization: { name: device.organization.name },
      interactionSeconds: INTERACTION_TTL_MS / 1000,
    };
  }

  async identify(
    device: KioskDevice,
    input: { employeeNumber: string; pin: string },
    context: TimeRequestContext,
  ) {
    const employeeNumber = normalizeEmployeeNumber(input.employeeNumber);
    // Batch 4B (D6): only failed identifications count; a success gives its attempt back.
    let reservation: KioskIdentifyReservation;
    try {
      reservation = await this.limiter.reserveIdentify({
        id: device.id,
        organizationId: device.organizationId,
        employeeNumber,
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429) {
        await this.writeAudit('KIOSK_RATE_LIMITED', device.id, context, {});
      }
      throw error;
    }
    const kioskContext: TimeRequestContext = {
      ...context,
      actorUserId: undefined,
      capture: { channel: 'KIOSK', attendanceDeviceId: device.id },
    };
    // An employee of another organization is indistinguishable from a wrong PIN.
    const verified = await this.credentials.verifyPin(
      employeeNumber,
      input.pin,
      device.organizationId,
      kioskContext,
    );
    if (!verified) throw new HttpException(IDENTIFICATION_FAILED, 401);
    await this.limiter.refund(reservation);

    const view = await this.optionsFor(device, verified.employeeId);
    const token = randomSecret();
    const interaction: Interaction = {
      deviceId: device.id,
      employeeId: verified.employeeId,
      credentialId: verified.credentialId,
      offered: view.actions.map(
        ({
          action,
          employmentAssignmentId,
          coverableAssignments,
          scheduledShiftId,
        }) => ({
          action,
          employmentAssignmentId,
          ...(coverableAssignments
            ? {
                coverableAssignmentIds: coverableAssignments.map(
                  (assignment) => assignment.employmentAssignmentId,
                ),
                coverableShifts: coverableAssignments.flatMap((assignment) =>
                  (assignment.shifts ?? []).map((shift) => ({
                    employmentAssignmentId: assignment.employmentAssignmentId,
                    scheduledShiftId: shift.scheduledShiftId,
                  })),
                ),
              }
            : {}),
          ...(scheduledShiftId ? { scheduledShiftId } : {}),
        }),
      ),
    };
    try {
      await this.redis.client.set(
        this.key(device.id, token),
        JSON.stringify(interaction),
        'PX',
        INTERACTION_TTL_MS,
      );
    } catch {
      throw new ServiceUnavailableException(
        'The kiosk is temporarily unavailable.',
      );
    }
    return {
      token,
      expiresInSeconds: INTERACTION_TTL_MS / 1000,
      employee: { firstName: view.firstName },
      state: view.state,
      actions: view.actions,
      notice: view.notice,
    };
  }

  async act(
    device: KioskDevice,
    input: {
      token: string;
      action: KioskAction;
      employmentAssignmentId?: string;
      additionalEmploymentAssignmentIds?: string[];
      scheduledShiftId?: string;
      idempotencyKey?: string;
    },
    context: TimeRequestContext,
  ) {
    const interaction = await this.consume(device.id, input.token);
    if (!interaction || interaction.deviceId !== device.id) {
      throw unauthorized(
        'KIOSK_INTERACTION_EXPIRED',
        'Please enter your employee number and PIN again.',
      );
    }
    const additional = input.additionalEmploymentAssignmentIds ?? [];
    const offered =
      additional.length > 0
        ? // A multi-assignment clock-in: the owner and every covered assignment were offered
          // together to this employee (TimeService re-checks each one regardless).
          input.action === 'CLOCK_IN' &&
          input.employmentAssignmentId !== undefined &&
          interaction.offered.some(
            (option) =>
              option.action === 'CLOCK_IN' &&
              option.coverableAssignmentIds !== undefined &&
              [input.employmentAssignmentId!, ...additional].every((id) =>
                option.coverableAssignmentIds!.includes(id),
              ) &&
              coverageShiftOffered(
                option.coverableShifts ?? [],
                input.employmentAssignmentId!,
                input.scheduledShiftId,
              ),
          )
        : interaction.offered.some(
            (option) =>
              option.action === input.action &&
              option.coverableAssignmentIds === undefined &&
              (option.employmentAssignmentId === null ||
                option.employmentAssignmentId ===
                  (input.employmentAssignmentId ?? null)) &&
              // A shift can only be chosen from the options shown for it.
              (option.scheduledShiftId ?? null) ===
                (input.scheduledShiftId ?? null),
          );
    if (!offered) {
      throw unauthorized(
        'KIOSK_ACTION_NOT_OFFERED',
        'That action is not available. Please start again.',
      );
    }
    if (!(await this.credentials.stillActive(interaction.credentialId))) {
      throw new HttpException(IDENTIFICATION_FAILED, 401);
    }
    const employeeId = interaction.employeeId;
    const assignmentId = input.employmentAssignmentId;
    // R4-A.3: what the time clock flagged (e.g. work with no published shift), by code only — a
    // shared screen shows a generic notice, never the exception record or other details.
    let warnings: Array<{ code: string }> = [];
    const keepCodes = (result: object) => {
      const flagged =
        'warnings' in result && Array.isArray(result.warnings)
          ? (result.warnings as Array<{ code: string }>)
          : [];
      warnings = flagged.map((warning) => ({ code: warning.code }));
    };
    switch (input.action) {
      case 'CLOCK_IN':
        keepCodes(
          await this.time.kioskClockIn(
            device,
            employeeId,
            assignmentId,
            context,
            additional,
            input.scheduledShiftId,
          ),
        );
        break;
      case 'CLOCK_OUT':
        await this.time.kioskClockOut(device, employeeId, context);
        break;
      case 'START_BREAK':
        await this.time.kioskStartBreak(device, employeeId, context);
        break;
      case 'END_BREAK':
        await this.time.kioskEndBreak(device, employeeId, context);
        break;
      case 'SWITCH_ASSIGNMENT':
        keepCodes(
          await this.time.kioskSwitchAssignment(
            device,
            employeeId,
            assignmentId!,
            context,
            input.scheduledShiftId,
          ),
        );
        break;
      case 'SIGN_OUT': {
        const result = await this.signIns.kioskSignOut(
          device,
          employeeId,
          assignmentId!,
          input.idempotencyKey,
          context,
        );
        return {
          action: input.action,
          outcome: result.outcome,
          occurredAt: result.signOut.signedOutAt,
        };
      }
      case 'SIGN_IN': {
        const result = await this.signIns.kioskSignIn(
          device,
          employeeId,
          assignmentId!,
          input.idempotencyKey,
          context,
          input.scheduledShiftId,
        );
        return {
          action: input.action,
          outcome: result.outcome,
          occurredAt: result.signIn.signedInAt,
          timezone: result.signIn.timezone,
        };
      }
    }
    return {
      action: input.action,
      outcome: 'RECORDED' as const,
      occurredAt: new Date().toISOString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Discards an interaction (the employee walked away or pressed Cancel). Batch 4B: only the
   * device that started it can discard it; another kiosk presenting the token finds nothing.
   */
  async cancel(device: KioskDevice, token: string) {
    const interaction = await this.consume(device.id, token);
    return { cancelled: interaction !== null };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** The minimal view an identified employee sees: a first name and labelled actions. */
  private async optionsFor(device: KioskDevice, employeeId: string) {
    const [status, employee] = await Promise.all([
      this.time.kioskStatus(device, employeeId),
      this.prisma.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: {
          person: { select: { firstName: true, preferredName: true } },
        },
      }),
    ]);
    const actions: OfferedAction[] = [];
    const positionOf = (id: string | null) =>
      [
        ...status.eligibleAssignments,
        ...(status.currentAssignment ? [status.currentAssignment] : []),
      ].find((assignment) => assignment.id === id)?.position.name ??
      'Assignment';
    // An assignment with several published shifts open now gets one option per shift; any other
    // assignment stays one tap (the time clock preselects its only shift, if it has one).
    const openShifts = (employmentAssignmentId: string) =>
      (status.scheduledShiftOptions ?? []).filter(
        (shift) => shift.employmentAssignmentId === employmentAssignmentId,
      );
    const shiftChoices = (
      action: 'CLOCK_IN' | 'SWITCH_ASSIGNMENT',
      employmentAssignmentId: string,
      label: string,
    ): OfferedAction[] => {
      const shifts = openShifts(employmentAssignmentId);
      if (shifts.length < 2) {
        return [{ action, employmentAssignmentId, label }];
      }
      return shifts.map((shift) => ({
        action,
        employmentAssignmentId,
        scheduledShiftId: shift.scheduledShiftId,
        label: `${label} · ${shiftWindow(shift.startsAt, shift.endsAt, shift.timezone)}`,
      }));
    };
    for (const action of status.availableActions) {
      if (action === 'CLOCK_IN') {
        for (const assignment of status.eligibleAssignments) {
          actions.push(
            ...shiftChoices(
              'CLOCK_IN',
              assignment.id,
              `Clock in — ${assignment.position.name}`,
            ),
          );
        }
        // Several eligible assignments: one physical clock-in may also cover more than one
        // (one payroll owner; the others are coverage only). One assignment stays one tap.
        if (status.eligibleAssignments.length > 1) {
          actions.push({
            action: 'CLOCK_IN',
            employmentAssignmentId: null,
            coverableAssignments: status.eligibleAssignments.map(
              (assignment) => {
                const shifts = openShifts(assignment.id);
                return {
                  employmentAssignmentId: assignment.id,
                  name: assignment.position.name,
                  // Only the payroll owner's shift is linked; with one open shift the time
                  // clock links it itself, so a choice is offered only for two or more.
                  ...(shifts.length > 1
                    ? {
                        shifts: shifts.map((shift) => ({
                          scheduledShiftId: shift.scheduledShiftId,
                          label: shiftWindow(
                            shift.startsAt,
                            shift.endsAt,
                            shift.timezone,
                          ),
                        })),
                      }
                    : {}),
                };
              },
            ),
            label: 'Clock in — several assignments',
          });
        }
      } else if (action === 'SWITCH_ASSIGNMENT') {
        for (const assignment of status.eligibleAssignments) {
          actions.push(
            ...shiftChoices(
              'SWITCH_ASSIGNMENT',
              assignment.id,
              `Switch to ${assignment.position.name}`,
            ),
          );
        }
      } else if (
        action === 'CLOCK_OUT' ||
        action === 'START_BREAK' ||
        action === 'END_BREAK'
      ) {
        actions.push({
          action,
          employmentAssignmentId: null,
          label:
            action === 'CLOCK_OUT'
              ? `Clock out — ${positionOf(status.currentAssignment?.id ?? null)}`
              : action === 'START_BREAK'
                ? 'Start break'
                : 'End break',
        });
      } else if (action === 'SIGN_OUT') {
        for (const assignment of status.signOutAssignments) {
          actions.push({
            action: 'SIGN_OUT',
            employmentAssignmentId: assignment.id,
            label: `Sign out — ${assignment.position.name}`,
          });
        }
      } else if (action === 'SIGN_IN') {
        for (const assignment of status.signInAssignments) {
          const label = `Sign in — ${assignment.position.name}`;
          // Batch 4F (D2): several occurrences open now: one explicit choice per occurrence
          // not yet signed in for, so a second tap never confirms another one silently.
          const occurrences = (status.signInOptions ?? []).filter(
            (option) => option.employmentAssignmentId === assignment.id,
          );
          const unsigned = occurrences.filter((option) => !option.signIn);
          if (occurrences.length < 2 || unsigned.length === 0) {
            actions.push({
              action: 'SIGN_IN',
              employmentAssignmentId: assignment.id,
              label,
            });
            continue;
          }
          for (const option of unsigned) {
            actions.push({
              action: 'SIGN_IN',
              employmentAssignmentId: assignment.id,
              scheduledShiftId: option.scheduledShiftId,
              label: `${label} · ${shiftWindow(option.startsAt, option.endsAt, option.timezone)}`,
            });
          }
        }
      }
    }
    // Resolving a missed clock-out is not a kiosk action: say so instead of dropping it. When
    // nothing at all can be recorded, explain why (configuration, assignment, open work…).
    const code: KioskNoticeCode | null = status.availableActions.includes(
      'RESOLVE_MISSED_CLOCK_OUT',
    )
      ? 'MISSED_CLOCK_OUT'
      : actions.length === 0
        ? await this.time.kioskUnavailableReason(device, employeeId)
        : null;
    return {
      firstName:
        employee.person.preferredName ?? employee.person.firstName ?? null,
      state: status.state,
      actions,
      notice: code ? { code, message: KIOSK_NOTICES[code] } : null,
    };
  }

  /** Batch 4B: an interaction is stored under its device, so no other kiosk can reach it. */
  private key(deviceId: string, token: string) {
    return `kiosk:interaction:${deviceId}:${sha256(token)}`;
  }

  /** Atomically takes the device's interaction (GETDEL): a second use finds nothing. */
  private async consume(
    deviceId: string,
    token: string,
  ): Promise<Interaction | null> {
    if (!token) return null;
    let raw: string | null;
    try {
      raw = await this.redis.client.getdel(this.key(deviceId, token));
    } catch {
      throw new ServiceUnavailableException(
        'The kiosk is temporarily unavailable.',
      );
    }
    return raw ? (JSON.parse(raw) as Interaction) : null;
  }

  private writeAudit(
    action: string,
    deviceId: string,
    context: TimeRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write({
      action,
      entityType: 'AttendanceDevice',
      entityId: deviceId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      correlationId: context.correlationId,
      metadata: jsonValue(metadata),
    });
  }
}

/**
 * A multi-assignment clock-in names a shift only if one was offered for its payroll owner, and
 * must name one of those when the owner had a choice.
 */
function coverageShiftOffered(
  coverableShifts: Array<{
    employmentAssignmentId: string;
    scheduledShiftId: string;
  }>,
  ownerAssignmentId: string,
  scheduledShiftId: string | undefined,
) {
  const ownerShifts = coverableShifts.filter(
    (shift) => shift.employmentAssignmentId === ownerAssignmentId,
  );
  return ownerShifts.length === 0
    ? scheduledShiftId === undefined
    : ownerShifts.some((shift) => shift.scheduledShiftId === scheduledShiftId);
}

/** "09:00–17:00" in the shift's own time zone. */
function shiftWindow(startsAt: string, endsAt: string, timezone: string) {
  const time = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${time.format(new Date(startsAt))}–${time.format(new Date(endsAt))}`;
}
