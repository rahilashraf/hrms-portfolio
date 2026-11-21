CREATE TYPE "ScheduledShiftRevisionType" AS ENUM ('PUBLISHED_BASELINE', 'CORRECTED', 'CANCELLED');

-- Immutable published expected-work history. Every row is a full, reconstructable snapshot of
-- a ScheduledShift after one published change; ScheduledShift stays the current state.
CREATE TABLE "ScheduledShiftRevision" (
  "id" UUID NOT NULL,
  "scheduledShiftId" UUID NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "revisionType" "ScheduledShiftRevisionType" NOT NULL,
  "employmentAssignmentId" UUID NOT NULL,
  "workLocationId" UUID,
  "workDate" DATE NOT NULL,
  "startsAt" TIMESTAMPTZ(6) NOT NULL,
  "endsAt" TIMESTAMPTZ(6) NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" "ScheduledShiftStatus" NOT NULL,
  "sourceType" "ScheduledShiftSourceType" NOT NULL,
  "reason" TEXT,
  "changedByUserId" UUID NOT NULL,
  "changedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledShiftRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledShiftRevision_revision_number_positive_check" CHECK ("revisionNumber" > 0),
  -- Revision 1 is always, and only, the published baseline.
  CONSTRAINT "ScheduledShiftRevision_baseline_number_check" CHECK (
    ("revisionNumber" = 1) = ("revisionType" = 'PUBLISHED_BASELINE')
  ),
  -- A cancellation snapshot is CANCELLED; baselines and corrections describe active work.
  CONSTRAINT "ScheduledShiftRevision_status_shape_check" CHECK (
    ("revisionType" = 'CANCELLED' AND "status" = 'CANCELLED')
    OR
    ("revisionType" <> 'CANCELLED' AND "status" = 'ACTIVE')
  ),
  -- Post-publication changes are explicit: corrections and cancellations carry a reason.
  CONSTRAINT "ScheduledShiftRevision_reason_required_check" CHECK (
    "revisionType" = 'PUBLISHED_BASELINE' OR "reason" IS NOT NULL
  ),
  CONSTRAINT "ScheduledShiftRevision_reason_nonempty_check" CHECK ("reason" IS NULL OR trim("reason") <> ''),
  CONSTRAINT "ScheduledShiftRevision_interval_order_check" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "ScheduledShiftRevision_timezone_nonempty_check" CHECK (trim("timezone") <> '')
);

-- Ordered, gap-free history per shift; concurrent writers cannot reuse a number.
CREATE UNIQUE INDEX "ScheduledShiftRevision_scheduledShiftId_revisionNumber_key"
  ON "ScheduledShiftRevision"("scheduledShiftId", "revisionNumber");
-- Cancellation is final in V1: at most one CANCELLED revision per shift.
CREATE UNIQUE INDEX "ScheduledShiftRevision_scheduledShiftId_cancelled_key"
  ON "ScheduledShiftRevision"("scheduledShiftId")
  WHERE "revisionType" = 'CANCELLED';
CREATE INDEX "ScheduledShiftRevision_employmentAssignmentId_workDate_idx"
  ON "ScheduledShiftRevision"("employmentAssignmentId", "workDate");
CREATE INDEX "ScheduledShiftRevision_workLocationId_idx"
  ON "ScheduledShiftRevision"("workLocationId");
CREATE INDEX "ScheduledShiftRevision_changedByUserId_changedAt_idx"
  ON "ScheduledShiftRevision"("changedByUserId", "changedAt");

-- RESTRICT keeps a published shift (one with history) from ever being hard-deleted.
ALTER TABLE "ScheduledShiftRevision"
  ADD CONSTRAINT "ScheduledShiftRevision_scheduledShiftId_fkey"
  FOREIGN KEY ("scheduledShiftId") REFERENCES "ScheduledShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledShiftRevision"
  ADD CONSTRAINT "ScheduledShiftRevision_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledShiftRevision"
  ADD CONSTRAINT "ScheduledShiftRevision_workLocationId_fkey"
  FOREIGN KEY ("workLocationId") REFERENCES "WorkLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledShiftRevision"
  ADD CONSTRAINT "ScheduledShiftRevision_changedByUserId_fkey"
  FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
