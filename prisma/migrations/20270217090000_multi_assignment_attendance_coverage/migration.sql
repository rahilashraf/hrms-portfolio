-- Multi-assignment attendance coverage.
--
-- A TimeEntry stays the one physical work interval: its clock-in/out and breaks are the only
-- source of elapsed minutes, and its "employmentAssignmentId" is the interval's payroll owner
-- (timesheets, payroll and reporting keep attributing worked time to it alone, so one interval
-- is paid exactly once). TimeEntryAssignmentCoverage lists every assignment the interval covers,
-- the payroll owner included; secondary rows are presence/attribution only and never add time.
--
-- Rows are append-only: a correction ends a row ("removedAt") instead of deleting or rewriting
-- it, so earlier coverage stays explainable next to its TimeAdjustment.

ALTER TYPE "TimeCorrectionType" ADD VALUE 'CHANGE_COVERAGE';

-- A CHANGE_COVERAGE adjustment targets one entry (and its owner assignment), never a break.
-- Compared as text: the enum value is new in this transaction. Employees never request it, so
-- the TimeCorrectionRequest shape check deliberately still refuses it.
ALTER TABLE "TimeAdjustment" DROP CONSTRAINT "TimeAdjustment_target_shape_check";
ALTER TABLE "TimeAdjustment" ADD CONSTRAINT "TimeAdjustment_target_shape_check" CHECK (
  ("type" = 'ADD_MISSING_TIME_ENTRY' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL)
  OR
  ("type" = 'ADD_BREAK' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NOT NULL)
  OR
  ("type" IN ('CHANGE_BREAK_START', 'CHANGE_BREAK_END', 'REMOVE_BREAK') AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NOT NULL)
  OR
  ("type" = 'CHANGE_ASSIGNMENT' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL)
  OR
  ("type" IN ('ADD_MISSING_CLOCK_IN', 'ADD_MISSING_CLOCK_OUT', 'CHANGE_CLOCK_IN', 'CHANGE_CLOCK_OUT') AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL)
  OR
  ("type"::text = 'CHANGE_COVERAGE' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL)
);

CREATE TABLE "TimeEntryAssignmentCoverage" (
  "id" UUID NOT NULL,
  "timeEntryId" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "employmentAssignmentId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMPTZ(6),
  CONSTRAINT "TimeEntryAssignmentCoverage_pkey" PRIMARY KEY ("id")
);

-- Every existing interval is covered by exactly its current (payroll-owning) assignment.
INSERT INTO "TimeEntryAssignmentCoverage"
  ("id", "timeEntryId", "employeeId", "employmentAssignmentId", "createdAt")
SELECT gen_random_uuid(), "id", "employeeId", "employmentAssignmentId", "createdAt"
FROM "TimeEntry";

-- One active coverage row per interval and assignment.
CREATE UNIQUE INDEX "TimeEntryAssignmentCoverage_active_key"
  ON "TimeEntryAssignmentCoverage" ("timeEntryId", "employmentAssignmentId")
  WHERE "removedAt" IS NULL;
CREATE INDEX "TimeEntryAssignmentCoverage_timeEntryId_idx"
  ON "TimeEntryAssignmentCoverage" ("timeEntryId");
CREATE INDEX "TimeEntryAssignmentCoverage_employmentAssignmentId_timeEntr_idx"
  ON "TimeEntryAssignmentCoverage" ("employmentAssignmentId", "timeEntryId");

-- Same employee on both sides: an interval can only cover its own employee's assignments.
ALTER TABLE "TimeEntryAssignmentCoverage"
  ADD CONSTRAINT "TimeEntryAssignmentCoverage_timeEntryId_employeeId_fkey"
    FOREIGN KEY ("timeEntryId", "employeeId")
    REFERENCES "TimeEntry" ("id", "employeeId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "TimeEntryAssignmentCoverage_employmentAssignmentId_employe_fkey"
    FOREIGN KEY ("employmentAssignmentId", "employeeId")
    REFERENCES "EmploymentAssignment" ("id", "employeeId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Append-only, and one organization per interval: a covered assignment belongs to the payroll
-- owner's organization (the kiosk, policy and pay group all live there).
CREATE FUNCTION "guard_time_entry_assignment_coverage"() RETURNS trigger AS $$
DECLARE
  covered_org UUID;
  owner_org UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Time entry coverage is never deleted; remove it with a correction.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."removedAt" IS NOT NULL
      OR NEW."removedAt" IS NULL
      OR NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."timeEntryId" IS DISTINCT FROM OLD."timeEntryId"
      OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId"
      OR NEW."employmentAssignmentId" IS DISTINCT FROM OLD."employmentAssignmentId"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'Time entry coverage can only be removed once.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p."organizationId" INTO covered_org
    FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
    WHERE a."id" = NEW."employmentAssignmentId";
  SELECT p."organizationId" INTO owner_org
    FROM "TimeEntry" e
    JOIN "EmploymentAssignment" a ON a."id" = e."employmentAssignmentId"
    JOIN "Position" p ON p."id" = a."positionId"
    WHERE e."id" = NEW."timeEntryId";
  IF covered_org IS DISTINCT FROM owner_org THEN
    RAISE EXCEPTION 'A time entry only covers assignments of its own organization.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TimeEntryAssignmentCoverage_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "TimeEntryAssignmentCoverage"
FOR EACH ROW EXECUTE FUNCTION "guard_time_entry_assignment_coverage"();
