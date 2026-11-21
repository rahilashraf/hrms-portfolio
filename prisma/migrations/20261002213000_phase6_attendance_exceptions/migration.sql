CREATE TYPE "AttendanceExceptionType" AS ENUM (
  'MISSING_CLOCK_OUT',
  'AUTO_CLOSED_CLOCK_OUT',
  'OPEN_BREAK_AUTO_CLOSED',
  'LONG_SHIFT'
);

CREATE TYPE "AttendanceExceptionSeverity" AS ENUM (
  'INFO',
  'REVIEW',
  'ACTION_REQUIRED'
);

CREATE TYPE "AttendanceExceptionWorkflowImpact" AS ENUM (
  'NON_BLOCKING',
  'SUBMISSION_BLOCKING'
);

CREATE TYPE "AttendanceExceptionStatus" AS ENUM (
  'OPEN',
  'RESOLVED',
  'DISMISSED',
  'SUPERSEDED'
);

CREATE TYPE "AttendanceExceptionResolutionMethod" AS ENUM (
  'SYSTEM_AUTO_RESOLUTION',
  'EMPLOYEE_RESOLUTION',
  'MANAGER_RESOLUTION',
  'ADMIN_RESOLUTION'
);

CREATE TABLE "AttendanceException" (
  "id" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "employmentAssignmentId" UUID,
  "timeEntryId" UUID,
  "type" "AttendanceExceptionType" NOT NULL,
  "severity" "AttendanceExceptionSeverity" NOT NULL,
  "workflowImpact" "AttendanceExceptionWorkflowImpact" NOT NULL,
  "status" "AttendanceExceptionStatus" NOT NULL DEFAULT 'OPEN',
  "resolutionMethod" "AttendanceExceptionResolutionMethod",
  "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(6),
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AttendanceException_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AttendanceException_resolution_status_check" CHECK (
    ("status" IN ('RESOLVED', 'DISMISSED', 'SUPERSEDED') AND "resolvedAt" IS NOT NULL AND "resolutionMethod" IS NOT NULL)
    OR
    ("status" = 'OPEN' AND "resolvedAt" IS NULL AND "resolutionMethod" IS NULL)
  ),
  CONSTRAINT "AttendanceException_entry_assignment_shape_check" CHECK (
    ("timeEntryId" IS NULL AND "employmentAssignmentId" IS NULL)
    OR
    ("timeEntryId" IS NOT NULL AND "employmentAssignmentId" IS NOT NULL)
  )
);

CREATE INDEX "AttendanceException_employeeId_status_detectedAt_idx"
  ON "AttendanceException"("employeeId", "status", "detectedAt");

CREATE INDEX "AttendanceException_timeEntryId_type_status_idx"
  ON "AttendanceException"("timeEntryId", "type", "status");

CREATE INDEX "AttendanceException_employmentAssignmentId_detectedAt_idx"
  ON "AttendanceException"("employmentAssignmentId", "detectedAt");

CREATE UNIQUE INDEX "AttendanceException_one_open_per_timeEntry_type_key"
  ON "AttendanceException"("timeEntryId", "type")
  WHERE "timeEntryId" IS NOT NULL AND "status" = 'OPEN';

CREATE UNIQUE INDEX "AttendanceException_one_auto_closed_per_timeEntry_key"
  ON "AttendanceException"("timeEntryId", "type")
  WHERE "timeEntryId" IS NOT NULL AND "type" IN ('AUTO_CLOSED_CLOCK_OUT', 'OPEN_BREAK_AUTO_CLOSED');

ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_employmentAssignmentId_employeeId_fkey"
  FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_timeEntryId_employeeId_employmentAssignmentId_fkey"
  FOREIGN KEY ("timeEntryId", "employeeId", "employmentAssignmentId") REFERENCES "TimeEntry"("id", "employeeId", "employmentAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;
