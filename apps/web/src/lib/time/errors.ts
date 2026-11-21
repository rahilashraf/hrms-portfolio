import { AuthApiError } from '../auth/types';
import { featureDisabledInfo, sharedErrorMessage } from '../features/errors';
import type { LocalTimeOccurrence } from './types';

/**
 * Batch 4E-1 — what a manager can do about each coded refusal. The API stays the authority:
 * these only explain its decision.
 */
const CODE_MESSAGES: Record<string, string> = {
  // Batch 4E-3: what an employee can do about their own refused actions.
  TIME_CAPTURE_DISABLED: 'Attendance is not recorded for this assignment.',
  TIME_BREAKS_NOT_MANUAL:
    'Breaks are not punched for this assignment: they are deducted automatically or not tracked.',
  TIME_ASSIGNMENT_SWITCHING_DISABLED:
    'Switching to this assignment while clocked in is not allowed. Clock out, then clock in to it.',
  TIME_CORRECTION_REQUESTS_DISABLED:
    'Correction requests are not available for this assignment on that date. Ask your manager to correct it.',
  TIME_MISSED_PUNCH_SELF_RESOLUTION_DISABLED:
    'You cannot enter your own missed clock-out for this assignment. Ask your manager to record it.',
  TIMESHEET_TOTALS_CHANGED:
    'Your timesheet changed since you reviewed it. It has been reloaded: check the updated totals, then submit again.',
  TIMESHEET_OPEN_ENTRY:
    'An entry in this period has no clock-out yet. Clock out, or request the missing clock-out, first.',
  TIMESHEET_BLOCKING_EXCEPTIONS:
    'An exception in this period must be resolved first. See Requests.',
  TIMESHEET_PENDING_CORRECTIONS:
    'A correction request in this period is still pending. Wait for the decision or cancel it.',
  TIMESHEET_PERIOD_NOT_ENDED: 'This period has not ended yet. Submit it after its last day.',
  TIME_ENTRY_FINALIZED:
    'That time is in an approved or locked timesheet. Ask your manager to reopen the timesheet first.',
  TIME_ENTRY_OVERLAP: 'That time overlaps another of your entries.',
  ATTENDANCE_TRACKING_MODE_MISMATCH:
    'This assignment records attendance differently on that date (by sign-in or by the time clock), so this is not possible.',
  ATTENDANCE_CAPTURE_KIOSK_ONLY:
    'Attendance for this assignment is recorded at the onsite kiosk only, with your employee number and attendance PIN.',
  SCHEDULED_SHIFT_NOT_ELIGIBLE:
    'That shift or session is not open now. The list has been refreshed.',
  ATTENDANCE_SIGN_OUT_DISABLED: 'Signing out is not used for this assignment.',
  ATTENDANCE_NOT_SIGNED_IN: 'There is no open sign-in to sign out of.',
  // Batch 4F (D2): several occurrences open now and one is already confirmed.
  ATTENDANCE_OCCURRENCE_CHOICE_REQUIRED:
    'Several shifts are open now and one is already signed in. Choose the shift to sign in for.',
  // Batch 4E-2: attendance PINs (4B rules).
  ATTENDANCE_PIN_SHARED_SCOPE:
    'This PIN also works in an organization you do not manage. An administrator of every organization the employee works in, or a System administrator, must change it.',
  ATTENDANCE_PIN_SELF_TARGET:
    'You cannot issue or revoke your own PIN here. Change it in My Time instead.',
  ATTENDANCE_PIN_ADMIN_REVOKED:
    'This PIN was revoked by an administrator. An administrator can issue a new one.',
  ATTENDANCE_PIN_WEAK: 'Choose 6 digits that are not all the same or a straight run.',
  ATTENDANCE_PIN_LOCKED: 'Too many incorrect PINs. Try again later.',
  ATTENDANCE_PIN_INCORRECT: 'The current PIN is incorrect.',
  // Batch 4E-2: policy layers.
  TIME_POLICY_CHANGED:
    'This policy changed since you opened it. It has been reloaded: review it and try again.',
  TIME_POLICY_SUPERSEDE_DATE:
    'Choose a date after this policy starts and before it ends. A policy that has not started can be archived instead.',
  TIME_POLICY_OVERLAP:
    'Another policy of this scope is in effect then. End or replace that policy first.',
  TIME_POLICY_RETROACTIVE: 'Policies never start or end in the past. Choose today or a later date.',
  TIME_POLICY_SECTION_SCOPE: 'Period automation is set on the organization policy only.',
  TIME_POLICY_PERIOD_INVALID: 'The end date must be on or after the start date.',
  TIME_POLICY_END_NOT_EARLIER: 'A policy end can only be moved earlier.',
  TIME_POLICY_STARTED: 'A policy that has started cannot be archived; end it instead.',
  TIMESHEET_SEGMENT_CHANGED:
    'This timesheet changed since you opened it. It has been reloaded: review the new totals before approving.',
  TIMESHEET_VERSION_CONFLICT:
    'Someone else updated this timesheet since you opened it. It has been reloaded: review it and try again.',
  TIME_SELF_TARGET_FORBIDDEN: 'You cannot review or change your own time.',
  TIME_EXCEPTION_NOT_OPEN: 'This exception was already resolved, dismissed or superseded.',
  TIME_EXCEPTION_CONDITION_PRESENT:
    'The time entry is still open. Correct the entry first; the exception can be reviewed once it is closed.',
  TIME_PERIOD_OVERLAP:
    'These dates overlap an existing period with different dates. Choose dates that match or avoid it.',
  TIME_PERIOD_START_INVALID: 'Monthly periods must start on day 1 to 28.',
  TIME_LOCAL_TIME_NONEXISTENT:
    'That time does not exist on this day: the clocks moved forward for daylight saving time. Enter a time after the change.',
  // Shared by every screen, most of which can't send an occurrence (an offset): it never asks
  // the user to choose. Screens with an occurrence selector show LOCAL_TIME_SELECT_OCCURRENCE.
  TIME_LOCAL_TIME_AMBIGUOUS:
    'This local time occurs twice because the clocks moved back. A manager can help record the correct occurrence.',
  TIME_LOCAL_TIME_OFFSET_MISMATCH:
    'The selected offset does not belong to this time zone at that time. Choose one of the listed times.',
};

/** Batch 4E-1: the instruction where both occurrences of a repeated local time are offered. */
export const LOCAL_TIME_SELECT_OCCURRENCE =
  'This time occurs twice because the clocks moved back. Select the correct occurrence below.';

export function timeErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/** Both occurrences of a repeated local time (409 TIME_LOCAL_TIME_AMBIGUOUS), earlier first. */
export function localTimeOccurrences(error: unknown): LocalTimeOccurrence[] {
  if (!(error instanceof AuthApiError)) return [];
  const occurrences = error.details?.occurrences;
  if (!Array.isArray(occurrences)) return [];
  return occurrences.filter(
    (item): item is LocalTimeOccurrence =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as LocalTimeOccurrence).value === 'string' &&
      typeof (item as LocalTimeOccurrence).offset === 'string',
  );
}

/**
 * Batch 4F (C10): a 403 FEATURE_DISABLED for Time & attendance (or without a module named): the
 * organization turned attendance off. Reads of the user's own history stay available.
 */
export function isAttendanceTurnedOff(error: unknown): boolean {
  const info = featureDisabledInfo(error);
  return info?.kind === 'module' && (info.module === null || info.module === 'ATTENDANCE');
}

/** A 409 that means "what you saw is stale": reload before acting again. */
export function isStaleConflict(error: unknown): boolean {
  const code = timeErrorCode(error);
  return code === 'TIMESHEET_SEGMENT_CHANGED' || code === 'TIMESHEET_VERSION_CONFLICT';
}

export function timeErrorMessage(error: unknown, fallback = 'Unable to load time data.'): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  const code = timeErrorCode(error);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (error.status === 403) return 'You do not have permission for this time action.';
  if (error.status === 404) return 'The requested time record was not found.';
  // The server's own text (validationMessage); AuthApiError.message is only its category.
  if (error.status === 409)
    return error.validationMessage || 'This time action cannot be completed yet.';
  if (error.status === 400)
    return error.validationMessage || 'Check the time details and try again.';
  return fallback;
}
