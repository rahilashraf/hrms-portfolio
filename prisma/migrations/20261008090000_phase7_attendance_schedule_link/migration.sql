-- Schedule-aware attendance signals. Both are non-blocking review items owned by Time & Attendance.
ALTER TYPE "AttendanceExceptionType" ADD VALUE 'UNSCHEDULED_WORK';
ALTER TYPE "AttendanceExceptionType" ADD VALUE 'SCHEDULE_CHANGED_AFTER_ATTENDANCE';

-- A revision is addressable together with its shift so a TimeEntry can never pair a revision
-- with a different shift.
CREATE UNIQUE INDEX "ScheduledShiftRevision_id_scheduledShiftId_key"
  ON "ScheduledShiftRevision"("id", "scheduledShiftId");

-- Expected-work link: the published shift an entry was matched to and the immutable published
-- revision its interpretation consumed. Never a pattern or rule. Unscheduled entries keep both NULL.
ALTER TABLE "TimeEntry"
  ADD COLUMN "scheduledShiftId" UUID,
  ADD COLUMN "scheduledShiftRevisionId" UUID,
  ADD CONSTRAINT "TimeEntry_scheduled_shift_link_shape_check" CHECK (
    ("scheduledShiftId" IS NULL) = ("scheduledShiftRevisionId" IS NULL)
  );

CREATE INDEX "TimeEntry_scheduledShiftId_idx" ON "TimeEntry"("scheduledShiftId");
CREATE INDEX "TimeEntry_scheduledShiftRevisionId_idx" ON "TimeEntry"("scheduledShiftRevisionId");

ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_scheduledShiftId_fkey"
  FOREIGN KEY ("scheduledShiftId") REFERENCES "ScheduledShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_scheduledShiftRevisionId_scheduledShiftId_fkey"
  FOREIGN KEY ("scheduledShiftRevisionId", "scheduledShiftId") REFERENCES "ScheduledShiftRevision"("id", "scheduledShiftId") ON DELETE RESTRICT ON UPDATE CASCADE;
