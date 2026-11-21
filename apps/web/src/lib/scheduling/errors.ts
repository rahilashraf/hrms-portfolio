import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';
import type { ScheduleConflict } from './types';

export function isNotEmployee(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403 && !sharedErrorMessage(error);
}

export function schedulingErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/** Conflicts carried by a 409 SCHEDULE_CONFLICT_* refusal (shift saves and published changes). */
export function conflictsOf(error: unknown): ScheduleConflict[] | null {
  if (!(error instanceof AuthApiError) || error.status !== 409) return null;
  const conflicts = error.details?.conflicts;
  return Array.isArray(conflicts) ? (conflicts as ScheduleConflict[]) : null;
}

export interface PublicationProblem {
  shiftId: string;
  message: string;
}

/** Per-shift reasons a publication was refused (invalid shifts or unresolved conflicts). */
export function publicationProblems(error: unknown): PublicationProblem[] {
  if (!(error instanceof AuthApiError)) return [];
  const invalid = error.details?.invalidShifts;
  if (Array.isArray(invalid)) {
    return invalid.map((row) => ({
      shiftId: String((row as { shiftId?: unknown }).shiftId ?? ''),
      message: String((row as { message?: unknown }).message ?? 'Invalid shift.'),
    }));
  }
  const shifts = error.details?.shifts;
  if (Array.isArray(shifts)) {
    return shifts.flatMap((row) => {
      const shift = row as { shiftId?: unknown; conflicts?: unknown };
      const conflicts = Array.isArray(shift.conflicts)
        ? (shift.conflicts as ScheduleConflict[])
        : [];
      return conflicts.map((conflict) => ({
        shiftId: String(shift.shiftId ?? ''),
        message: conflict.message,
      }));
    });
  }
  return [];
}

export function schedulingErrorMessage(
  error: unknown,
  fallback = 'Unable to load your schedule.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission for this scheduling action.';
  if (error.status === 404) return 'Not found, or outside the scopes you can access.';
  if (error.status >= 500) return 'The Scheduling service is unavailable. Please try again.';
  return fallback;
}
