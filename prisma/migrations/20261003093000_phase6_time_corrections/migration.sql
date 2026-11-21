CREATE TYPE "TimeCorrectionType" AS ENUM (
  'ADD_MISSING_CLOCK_IN',
  'ADD_MISSING_CLOCK_OUT',
  'CHANGE_CLOCK_IN',
  'CHANGE_CLOCK_OUT',
  'CHANGE_BREAK_START',
  'CHANGE_BREAK_END',
  'ADD_BREAK',
  'REMOVE_BREAK',
  'CHANGE_ASSIGNMENT',
  'ADD_MISSING_TIME_ENTRY'
);

CREATE TYPE "TimeCorrectionStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'SUPERSEDED'
);

CREATE TYPE "TimeAdjustmentSource" AS ENUM (
  'EMPLOYEE_APPROVED',
  'EMPLOYEE_AUTO_APPROVED',
  'MANAGER_DIRECT',
  'ADMIN_DIRECT'
);

ALTER TABLE "BreakEntry"
  ADD COLUMN "removedAt" TIMESTAMPTZ(6);

CREATE TABLE "TimeCorrectionRequest" (
  "id" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "requestorUserId" UUID NOT NULL,
  "reviewerUserId" UUID,
  "timeEntryId" UUID,
  "breakEntryId" UUID,
  "employmentAssignmentId" UUID,
  "targetEmploymentAssignmentId" UUID,
  "type" "TimeCorrectionType" NOT NULL,
  "status" "TimeCorrectionStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "reviewerNote" TEXT,
  "requestedValues" JSONB NOT NULL,
  "currentValues" JSONB,
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMPTZ(6),
  "cancelledAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TimeCorrectionRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimeCorrectionRequest_reason_not_blank_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "TimeCorrectionRequest_status_shape_check" CHECK (
    ("status" = 'PENDING' AND "reviewerUserId" IS NULL AND "reviewedAt" IS NULL AND "cancelledAt" IS NULL)
    OR
    ("status" IN ('APPROVED', 'REJECTED', 'SUPERSEDED') AND "reviewerUserId" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "cancelledAt" IS NULL)
    OR
    ("status" = 'CANCELLED' AND "reviewedAt" IS NULL AND "cancelledAt" IS NOT NULL)
  ),
  CONSTRAINT "TimeCorrectionRequest_target_shape_check" CHECK (
    ("type" = 'ADD_MISSING_TIME_ENTRY' AND "timeEntryId" IS NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL AND "targetEmploymentAssignmentId" IS NULL)
    OR
    ("type" = 'ADD_BREAK' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL)
    OR
    ("type" IN ('CHANGE_BREAK_START', 'CHANGE_BREAK_END', 'REMOVE_BREAK') AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NOT NULL)
    OR
    ("type" = 'CHANGE_ASSIGNMENT' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "targetEmploymentAssignmentId" IS NOT NULL)
    OR
    ("type" IN ('ADD_MISSING_CLOCK_IN', 'ADD_MISSING_CLOCK_OUT', 'CHANGE_CLOCK_IN', 'CHANGE_CLOCK_OUT') AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL)
  )
);

CREATE TABLE "TimeAdjustment" (
  "id" UUID NOT NULL,
  "correctionRequestId" UUID,
  "employeeId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "timeEntryId" UUID,
  "breakEntryId" UUID,
  "employmentAssignmentId" UUID,
  "type" "TimeCorrectionType" NOT NULL,
  "source" "TimeAdjustmentSource" NOT NULL,
  "reason" TEXT NOT NULL,
  "previousValues" JSONB NOT NULL,
  "newValues" JSONB NOT NULL,
  "appliedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeAdjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimeAdjustment_reason_not_blank_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "TimeAdjustment_target_shape_check" CHECK (
    ("type" = 'ADD_MISSING_TIME_ENTRY' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL)
    OR
    ("type" = 'ADD_BREAK' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NOT NULL)
    OR
    ("type" IN ('CHANGE_BREAK_START', 'CHANGE_BREAK_END', 'REMOVE_BREAK') AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NOT NULL)
    OR
    ("type" = 'CHANGE_ASSIGNMENT' AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL)
    OR
    ("type" IN ('ADD_MISSING_CLOCK_IN', 'ADD_MISSING_CLOCK_OUT', 'CHANGE_CLOCK_IN', 'CHANGE_CLOCK_OUT') AND "timeEntryId" IS NOT NULL AND "breakEntryId" IS NULL AND "employmentAssignmentId" IS NOT NULL)
  )
);

CREATE INDEX "TimeCorrectionRequest_employeeId_status_requestedAt_idx"
  ON "TimeCorrectionRequest"("employeeId", "status", "requestedAt");

CREATE INDEX "TimeCorrectionRequest_timeEntryId_status_idx"
  ON "TimeCorrectionRequest"("timeEntryId", "status");

CREATE INDEX "TimeCorrectionRequest_breakEntryId_status_idx"
  ON "TimeCorrectionRequest"("breakEntryId", "status");

CREATE INDEX "TimeCorrectionRequest_employmentAssignmentId_status_idx"
  ON "TimeCorrectionRequest"("employmentAssignmentId", "status");

CREATE UNIQUE INDEX "TimeCorrectionRequest_one_pending_target_key"
  ON "TimeCorrectionRequest"(
    "employeeId",
    "type",
    COALESCE("timeEntryId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("breakEntryId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("employmentAssignmentId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("targetEmploymentAssignmentId", '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX "TimeAdjustment_correctionRequestId_key"
  ON "TimeAdjustment"("correctionRequestId")
  WHERE "correctionRequestId" IS NOT NULL;

CREATE INDEX "TimeAdjustment_employeeId_appliedAt_idx"
  ON "TimeAdjustment"("employeeId", "appliedAt");

CREATE INDEX "TimeAdjustment_timeEntryId_appliedAt_idx"
  ON "TimeAdjustment"("timeEntryId", "appliedAt");

CREATE INDEX "TimeAdjustment_breakEntryId_appliedAt_idx"
  ON "TimeAdjustment"("breakEntryId", "appliedAt");

ALTER TABLE "TimeCorrectionRequest"
  ADD CONSTRAINT "TimeCorrectionRequest_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeCorrectionRequest"
  ADD CONSTRAINT "TimeCorrectionRequest_requestorUserId_fkey"
  FOREIGN KEY ("requestorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeCorrectionRequest"
  ADD CONSTRAINT "TimeCorrectionRequest_reviewerUserId_fkey"
  FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeCorrectionRequest"
  ADD CONSTRAINT "TimeCorrectionRequest_timeEntryId_fkey"
  FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeCorrectionRequest"
  ADD CONSTRAINT "TimeCorrectionRequest_breakEntryId_fkey"
  FOREIGN KEY ("breakEntryId") REFERENCES "BreakEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeCorrectionRequest"
  ADD CONSTRAINT "TimeCorrectionRequest_employmentAssignmentId_employeeId_fkey"
  FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeCorrectionRequest"
  ADD CONSTRAINT "TimeCorrectionRequest_targetEmploymentAssignmentId_employeeId_fkey"
  FOREIGN KEY ("targetEmploymentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeAdjustment"
  ADD CONSTRAINT "TimeAdjustment_correctionRequestId_fkey"
  FOREIGN KEY ("correctionRequestId") REFERENCES "TimeCorrectionRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeAdjustment"
  ADD CONSTRAINT "TimeAdjustment_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeAdjustment"
  ADD CONSTRAINT "TimeAdjustment_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeAdjustment"
  ADD CONSTRAINT "TimeAdjustment_timeEntryId_fkey"
  FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeAdjustment"
  ADD CONSTRAINT "TimeAdjustment_breakEntryId_fkey"
  FOREIGN KEY ("breakEntryId") REFERENCES "BreakEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeAdjustment"
  ADD CONSTRAINT "TimeAdjustment_employmentAssignmentId_employeeId_fkey"
  FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;
