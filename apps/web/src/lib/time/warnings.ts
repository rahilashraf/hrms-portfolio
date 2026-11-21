/**
 * R4-A.3 — the words for a non-blocking time-clock warning. The action was recorded; the
 * warning says what will be reviewed. On a shared kiosk only the code is known, so every known
 * code has fixed, generic wording (no names, no record details).
 */
const WORDING: Record<string, string> = {
  UNSCHEDULED_WORK:
    'No published shift matched this clock-in. It was recorded and flagged for review.',
};

export function attendanceWarningText(warning: { code: string; message?: string }): string {
  return (
    WORDING[warning.code] ??
    warning.message ??
    'This was recorded, and something about it was flagged for review.'
  );
}
