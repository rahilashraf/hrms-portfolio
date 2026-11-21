CREATE TYPE "ScheduleConflictType" AS ENUM ('SAME_ASSIGNMENT_OVERLAP', 'EMPLOYEE_ASSIGNMENT_OVERLAP');

-- Conflicts are computed. Only accepted overrides of WARNING conflicts are persisted, each tied
-- to the exact conflict state (conflictKey) that was approved.
CREATE TABLE "ScheduleConflictOverride" (
  "id" UUID NOT NULL,
  "scheduledShiftId" UUID NOT NULL,
  "conflictingShiftId" UUID,
  "conflictType" "ScheduleConflictType" NOT NULL,
  "conflictKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "overriddenByUserId" UUID NOT NULL,
  "overriddenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduleConflictOverride_pkey" PRIMARY KEY ("id"),
  -- Same-assignment overlap is a hard error and can never be overridden.
  CONSTRAINT "ScheduleConflictOverride_overrideable_type_check" CHECK ("conflictType" <> 'SAME_ASSIGNMENT_OVERLAP'),
  CONSTRAINT "ScheduleConflictOverride_reason_nonempty_check" CHECK (trim("reason") <> ''),
  CONSTRAINT "ScheduleConflictOverride_conflict_key_format_check" CHECK ("conflictKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ScheduleConflictOverride_distinct_shifts_check" CHECK ("conflictingShiftId" IS NULL OR "conflictingShiftId" <> "scheduledShiftId")
);

-- One approval per exact conflict state and orientation. The key fingerprints both shifts'
-- state, so a changed state gets a new key and earlier approvals remain as history.
CREATE UNIQUE INDEX "ScheduleConflictOverride_scheduledShiftId_conflictKey_key"
  ON "ScheduleConflictOverride"("scheduledShiftId", "conflictKey");
CREATE INDEX "ScheduleConflictOverride_conflictingShiftId_conflictKey_idx"
  ON "ScheduleConflictOverride"("conflictingShiftId", "conflictKey");
CREATE INDEX "ScheduleConflictOverride_overriddenByUserId_overriddenAt_idx"
  ON "ScheduleConflictOverride"("overriddenByUserId", "overriddenAt");

ALTER TABLE "ScheduleConflictOverride"
  ADD CONSTRAINT "ScheduleConflictOverride_scheduledShiftId_fkey"
  FOREIGN KEY ("scheduledShiftId") REFERENCES "ScheduledShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Removing the other shift leaves the override as history (metadata keeps its snapshot);
-- a null conflictingShiftId can never match a recomputed conflict again.
ALTER TABLE "ScheduleConflictOverride"
  ADD CONSTRAINT "ScheduleConflictOverride_conflictingShiftId_fkey"
  FOREIGN KEY ("conflictingShiftId") REFERENCES "ScheduledShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduleConflictOverride"
  ADD CONSTRAINT "ScheduleConflictOverride_overriddenByUserId_fkey"
  FOREIGN KEY ("overriddenByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
