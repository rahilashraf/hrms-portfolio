-- Phase 9.5 — a sign-in linked to a published shift receives the same schedule-change review
-- signal as a time entry when that shift is later corrected or cancelled. Presence signals stay
-- sign-in only, and a sign-in still never carries clock-out, break, late-arrival or other
-- time-entry exceptions.
ALTER TABLE "AttendanceException" DROP CONSTRAINT "AttendanceException_sign_in_type_check";
ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_sign_in_type_check" CHECK (
    ("type" NOT IN ('LATE_SIGN_IN', 'UNSCHEDULED_SIGN_IN') OR "attendanceSignInId" IS NOT NULL)
    AND (
      "attendanceSignInId" IS NULL
      OR "type" IN ('LATE_SIGN_IN', 'UNSCHEDULED_SIGN_IN', 'SCHEDULE_CHANGED_AFTER_ATTENDANCE')
    )
  );

CREATE UNIQUE INDEX "AttendanceException_one_open_schedule_change_per_sign_in_key"
  ON "AttendanceException"("attendanceSignInId")
  WHERE "attendanceSignInId" IS NOT NULL
    AND "type" = 'SCHEDULE_CHANGED_AFTER_ATTENDANCE'
    AND "status" = 'OPEN';
