import { BadRequestException } from '@nestjs/common';
import type { TimeAttendancePolicyConfig } from './time-domain.service.js';

/**
 * Phase 9.5 — how an assignment's attendance is captured, resolved like every other
 * TimeAttendancePolicy setting (effective-dated, scoped, INHERIT/OVERRIDE), in its own
 * `attendance` section.
 *
 * - trackingMode TIME_CLOCK: duration-based attendance (clock in/out, breaks), the existing model.
 *   SIGN_IN_ONLY: completed presence facts (sign-ins) only; never a time entry, never minutes.
 * - captureMode: where attendance may be captured. KIOSK_ONLY rejects every employee
 *   self-service capture server-side; managers' corrections are unaffected.
 * - kioskLocationRule: whether any kiosk of the organization is accepted, or only kiosks at the
 *   assignment position's work location.
 * - signInDuplicateWindowMinutes: an unscheduled sign-in within this window of the previous one
 *   on the same assignment returns that sign-in instead of recording another.
 *
 * The defaults (TIME_CLOCK, SELF_SERVICE) are exactly the pre-9.5 behaviour.
 */
export const ATTENDANCE_TRACKING_MODES = [
  'TIME_CLOCK',
  'SIGN_IN_ONLY',
] as const;
export const ATTENDANCE_CAPTURE_MODES = [
  'KIOSK_ONLY',
  'SELF_SERVICE',
  'KIOSK_OR_SELF_SERVICE',
] as const;
export const KIOSK_LOCATION_RULES = [
  'ANY_IN_ORGANIZATION',
  'ASSIGNMENT_WORK_LOCATION',
] as const;

export type AttendanceTrackingMode = (typeof ATTENDANCE_TRACKING_MODES)[number];
export type AttendanceCaptureMode = (typeof ATTENDANCE_CAPTURE_MODES)[number];
export type KioskLocationRule = (typeof KIOSK_LOCATION_RULES)[number];

export interface AttendanceModes {
  trackingMode: AttendanceTrackingMode;
  captureMode: AttendanceCaptureMode;
  kioskLocationRule: KioskLocationRule;
  signInDuplicateWindowMinutes: number;
}

export const DEFAULT_ATTENDANCE_MODES: AttendanceModes = Object.freeze({
  trackingMode: 'TIME_CLOCK',
  captureMode: 'SELF_SERVICE',
  kioskLocationRule: 'ANY_IN_ORGANIZATION',
  signInDuplicateWindowMinutes: 10,
});

export type AttendanceChannel = 'SELF_SERVICE' | 'KIOSK';

/** The resolved attendance modes of a policy (writes are validated; defaults fill the rest). */
export function attendanceModes(
  config: TimeAttendancePolicyConfig,
): AttendanceModes {
  const section = (config.attendance ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ) => (allowed.includes(value as T) ? (value as T) : fallback);
  const window = section.signInDuplicateWindowMinutes;
  return {
    trackingMode: pick(
      section.trackingMode,
      ATTENDANCE_TRACKING_MODES,
      DEFAULT_ATTENDANCE_MODES.trackingMode,
    ),
    captureMode: pick(
      section.captureMode,
      ATTENDANCE_CAPTURE_MODES,
      DEFAULT_ATTENDANCE_MODES.captureMode,
    ),
    kioskLocationRule: pick(
      section.kioskLocationRule,
      KIOSK_LOCATION_RULES,
      DEFAULT_ATTENDANCE_MODES.kioskLocationRule,
    ),
    signInDuplicateWindowMinutes:
      typeof window === 'number' &&
      Number.isInteger(window) &&
      window >= 0 &&
      window <= 240
        ? window
        : DEFAULT_ATTENDANCE_MODES.signInDuplicateWindowMinutes,
  };
}

export function captureAllows(
  mode: AttendanceCaptureMode,
  channel: AttendanceChannel,
) {
  return channel === 'KIOSK'
    ? mode === 'KIOSK_ONLY' || mode === 'KIOSK_OR_SELF_SERVICE'
    : mode === 'SELF_SERVICE' || mode === 'KIOSK_OR_SELF_SERVICE';
}

// ─── Strict validation of policy writes ─────────────────────────────────────

type Rule =
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'localTime' }
  | { kind: 'date' };

const bool: Rule = { kind: 'boolean' };
const int = (min: number, max: number): Rule => ({ kind: 'integer', min, max });
const oneOf = (...values: string[]): Rule => ({ kind: 'enum', values });
const localTime: Rule = { kind: 'localTime' };
const date: Rule = { kind: 'date' };
/** Sections whose `mode` the code does not branch on accept these documented values. */
const passiveMode = oneOf('DISABLED', 'BASIC', 'MANUAL', 'REVIEW_REQUIRED');

/** Every key the Time service reads, with its type and bounds; nothing else is accepted. */
export const TIME_POLICY_CONFIG_SCHEMA: Record<string, Record<string, Rule>> = {
  clock: { mode: oneOf('DISABLED', 'LIVE_CLOCK'), assignmentSwitching: bool },
  breaks: {
    mode: oneOf('NONE', 'MANUAL_PUNCH', 'AUTO_DEDUCT'),
    autoDeductMinutes: int(0, 480),
    // Batch 4D (D-G): the day's gross minutes from which the deduction applies. Unset is 0 on
    // layers written before 4D; a new AUTO_DEDUCT layer without it is saved with 360.
    autoDeductAfterMinutes: int(0, 1440),
    paidUnpaidClassification: bool,
    defaultPayType: oneOf('PAID', 'UNPAID'),
    openBreakAutoCloseExceptionEnabled: bool,
  },
  missedPunch: {
    mode: passiveMode,
    enabled: bool,
    maxOpenDurationMinutes: int(1, 2880),
    detectionGraceMinutes: int(0, 1440),
    allowAutoCloseFromExpectedEnd: bool,
    expectedEndLocalTime: localTime,
    employeeResolutionEnabled: bool,
  },
  correction: {
    mode: passiveMode,
    employeeRequestsEnabled: bool,
    approvalMode: oneOf(
      'REQUIRE_APPROVAL',
      'NO_APPROVAL_REQUIRED',
      'AUTO_APPROVE_SAFE',
    ),
    autoApprovalToleranceMinutes: int(0, 1440),
  },
  attendanceInterpretation: {
    mode: passiveMode,
    lateArrivalEnabled: bool,
    earlyDepartureEnabled: bool,
    lateGraceMinutes: int(0, 1440),
    earlyDepartureGraceMinutes: int(0, 1440),
    expectedStartLocalTime: localTime,
    expectedEndLocalTime: localTime,
  },
  timesheet: {
    mode: passiveMode,
    autoLockOnApproval: bool,
    // Batch 4A: submit (and approve) before the period ends. Off unless set.
    allowEarlySubmission: bool,
  },
  attendance: {
    mode: passiveMode,
    trackingMode: oneOf(...ATTENDANCE_TRACKING_MODES),
    captureMode: oneOf(...ATTENDANCE_CAPTURE_MODES),
    kioskLocationRule: oneOf(...KIOSK_LOCATION_RULES),
    signInDuplicateWindowMinutes: int(0, 240),
    // Batch 4D (D-H): sign-in-only staff may also sign out (presence only, never payable).
    signOutEnabled: bool,
  },
  // Batch 4C: a published shift with no attendance raises a NO_SHOW review exception once the
  // shift has been running for graceMinutes (TIME_CLOCK assignments only). Off by default.
  noShow: { mode: passiveMode, enabled: bool, graceMinutes: int(0, 1440) },
  // Batch 4C: attendance-only period automation. Read from the SYSTEM and ORGANIZATION layers
  // only (periods belong to an organization); refused on narrower scopes.
  periods: {
    mode: passiveMode,
    autoGenerate: bool,
    cadence: oneOf('WEEKLY', 'BIWEEKLY', 'MONTHLY'),
    anchorDate: date,
    leadDays: int(0, 90),
    autoMaterialize: bool,
  },
};

/** Batch 4D (D-G): the threshold a new AUTO_DEDUCT policy layer gets when it sets none. */
export const AUTO_DEDUCT_DEFAULT_AFTER_MINUTES = 360;

/** Sections a policy layer of a narrower scope than ORGANIZATION may not set (Batch 4C). */
export const ORGANIZATION_ONLY_POLICY_SECTIONS: readonly string[] = ['periods'];

function invalid(path: string, message: string): never {
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'TIME_POLICY_CONFIG_INVALID',
    message: `${path}: ${message}`,
    path,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Validates a policy layer's config for writing: only known sections and keys, each of the right
 * type and within bounds. A layer may set any subset (INHERIT merges it section by section).
 */
export function validateTimePolicyConfig(
  config: unknown,
): Record<string, unknown> {
  if (!isPlainObject(config)) invalid('config', 'must be an object.');
  const result: Record<string, unknown> = {};
  for (const [sectionKey, section] of Object.entries(config)) {
    const rules = TIME_POLICY_CONFIG_SCHEMA[sectionKey];
    if (!rules) invalid(sectionKey, 'is not a time policy section.');
    if (!isPlainObject(section)) invalid(sectionKey, 'must be an object.');
    const validated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(section)) {
      const rule = rules[key];
      const path = `${sectionKey}.${key}`;
      if (!rule) invalid(path, 'is not a known setting.');
      switch (rule.kind) {
        case 'boolean':
          if (typeof value !== 'boolean')
            invalid(path, 'must be true or false.');
          break;
        case 'enum':
          if (typeof value !== 'string' || !rule.values.includes(value)) {
            invalid(path, `must be one of ${rule.values.join(', ')}.`);
          }
          break;
        case 'integer':
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < rule.min ||
            value > rule.max
          ) {
            invalid(
              path,
              `must be a whole number from ${rule.min} to ${rule.max}.`,
            );
          }
          break;
        case 'localTime':
          if (
            typeof value !== 'string' ||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
          ) {
            invalid(path, 'must be a local time HH:mm.');
          }
          break;
        case 'date':
          if (
            typeof value !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
            new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !==
              value
          ) {
            invalid(path, 'must be a date YYYY-MM-DD.');
          }
          break;
      }
      validated[key] = value;
    }
    result[sectionKey] = validated;
  }
  return result;
}
