-- Batch 4C — Attendance lifecycle (2/2). Additive: new nullable columns, constraints that every
-- existing row already satisfies, and indexes. No existing row is changed or deleted.

-- ─── Who reviewed an exception, and their note ─────────────────────────────────────────────
-- A manager's resolution or dismissal records the reviewer and a required note; system
-- resolutions (auto-close, supersede) leave both empty. Raw punches and hours are never touched
-- by a review.
ALTER TABLE "AttendanceException"
  ADD COLUMN "resolvedByUserId" UUID,
  ADD COLUMN "resolutionNote" TEXT,
  ADD COLUMN "scheduledShiftId" UUID,
  ADD COLUMN "scheduledShiftRevisionId" UUID;

ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_resolvedByUserId_fkey"
  FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A reviewer and note only on a reviewed (RESOLVED or DISMISSED) exception, and always together.
ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_review_shape_check" CHECK (
    ("resolvedByUserId" IS NULL) = ("resolutionNote" IS NULL)
    AND ("resolvedByUserId" IS NULL OR "status" IN ('RESOLVED', 'DISMISSED'))
  );

-- ─── No-show subject: the shift (and the revision) it was detected on ──────────────────────
-- The shift must be the exception's own assignment's, and the revision that shift's.
CREATE UNIQUE INDEX "ScheduledShift_id_employmentAssignmentId_key"
  ON "ScheduledShift"("id", "employmentAssignmentId");

ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_scheduledShiftId_employmentAssignmentI_fkey"
  FOREIGN KEY ("scheduledShiftId", "employmentAssignmentId")
  REFERENCES "ScheduledShift"("id", "employmentAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_scheduledShiftRevisionId_scheduledShif_fkey"
  FOREIGN KEY ("scheduledShiftRevisionId", "scheduledShiftId")
  REFERENCES "ScheduledShiftRevision"("id", "scheduledShiftId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One subject at most (an entry, a sign-in or a shift), always with its assignment; a NO_SHOW is
-- exactly the shift-subject case. Relaxes the Phase 9.5 check, which every existing row passes.
ALTER TABLE "AttendanceException" DROP CONSTRAINT "AttendanceException_subject_shape_check";
ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_subject_shape_check" CHECK (
    (("timeEntryId" IS NOT NULL)::int + ("attendanceSignInId" IS NOT NULL)::int
      + ("scheduledShiftId" IS NOT NULL)::int) <= 1
    AND (("timeEntryId" IS NOT NULL OR "attendanceSignInId" IS NOT NULL OR "scheduledShiftId" IS NOT NULL)
      = ("employmentAssignmentId" IS NOT NULL))
  ),
  ADD CONSTRAINT "AttendanceException_no_show_shape_check" CHECK (
    ("type" = 'NO_SHOW') = ("scheduledShiftId" IS NOT NULL)
    AND ("scheduledShiftId" IS NULL) = ("scheduledShiftRevisionId" IS NULL)
  );

-- One no-show per shift revision, ever: a retried detection adds nothing, and a dismissed one
-- is not raised again unless the published shift changes (a new revision).
CREATE UNIQUE INDEX "AttendanceException_one_no_show_per_revision_key"
  ON "AttendanceException"("scheduledShiftRevisionId")
  WHERE "type" = 'NO_SHOW';

CREATE INDEX "AttendanceException_scheduledShiftId_idx"
  ON "AttendanceException"("scheduledShiftId");
