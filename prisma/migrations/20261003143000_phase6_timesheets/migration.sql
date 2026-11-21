CREATE TYPE "TimePeriodStatus" AS ENUM ('UPCOMING', 'OPEN', 'CLOSED', 'LOCKED');
CREATE TYPE "TimePeriodCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY', 'CUSTOM');
CREATE TYPE "TimesheetStatus" AS ENUM ('OPEN', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'LOCKED');
CREATE TYPE "TimesheetSegmentStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED');
CREATE TYPE "TimesheetEventType" AS ENUM ('SUBMITTED', 'SEGMENT_APPROVED', 'CHANGES_REQUESTED', 'LOCKED', 'REOPENED');

CREATE TABLE "TimePeriod" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "status" "TimePeriodStatus" NOT NULL DEFAULT 'UPCOMING',
  "cadence" "TimePeriodCadence" NOT NULL DEFAULT 'CUSTOM',
  "metadata" JSONB,
  "openedAt" TIMESTAMPTZ(6),
  "closedAt" TIMESTAMPTZ(6),
  "lockedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TimePeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimePeriod_date_order_check" CHECK ("endDate" >= "startDate"),
  CONSTRAINT "TimePeriod_status_shape_check" CHECK (
    ("status" = 'UPCOMING' AND "openedAt" IS NULL AND "closedAt" IS NULL AND "lockedAt" IS NULL)
    OR
    ("status" = 'OPEN' AND "openedAt" IS NOT NULL AND "lockedAt" IS NULL)
    OR
    ("status" = 'CLOSED' AND "openedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND "lockedAt" IS NULL)
    OR
    ("status" = 'LOCKED' AND "openedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND "lockedAt" IS NOT NULL)
  )
);

CREATE TABLE "Timesheet" (
  "id" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "timePeriodId" UUID NOT NULL,
  "status" "TimesheetStatus" NOT NULL DEFAULT 'OPEN',
  "submittedByUserId" UUID,
  "submittedAt" TIMESTAMPTZ(6),
  "approvedByUserId" UUID,
  "approvedAt" TIMESTAMPTZ(6),
  "lockedByUserId" UUID,
  "lockedAt" TIMESTAMPTZ(6),
  "reopenedByUserId" UUID,
  "reopenedAt" TIMESTAMPTZ(6),
  "reviewerNote" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "totals" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Timesheet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Timesheet_version_positive_check" CHECK ("version" >= 1),
  CONSTRAINT "Timesheet_status_shape_check" CHECK (
    ("status" = 'OPEN')
    OR
    ("status" = 'SUBMITTED' AND "submittedAt" IS NOT NULL AND "submittedByUserId" IS NOT NULL)
    OR
    ("status" = 'CHANGES_REQUESTED')
    OR
    ("status" = 'APPROVED' AND "approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL)
    OR
    ("status" = 'LOCKED' AND "lockedAt" IS NOT NULL AND "lockedByUserId" IS NOT NULL)
  )
);

CREATE TABLE "TimesheetSegment" (
  "id" UUID NOT NULL,
  "timesheetId" UUID NOT NULL,
  "employmentAssignmentId" UUID NOT NULL,
  "status" "TimesheetSegmentStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedByUserId" UUID,
  "reviewedAt" TIMESTAMPTZ(6),
  "reviewerNote" TEXT,
  "grossMinutes" INTEGER NOT NULL DEFAULT 0,
  "paidBreakMinutes" INTEGER NOT NULL DEFAULT 0,
  "unpaidBreakMinutes" INTEGER NOT NULL DEFAULT 0,
  "policyDeductionMinutes" INTEGER NOT NULL DEFAULT 0,
  "netWorkedMinutes" INTEGER NOT NULL DEFAULT 0,
  "approvedWorkedMinutes" INTEGER NOT NULL DEFAULT 0,
  "calculatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "TimesheetSegment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimesheetSegment_totals_non_negative_check" CHECK (
    "grossMinutes" >= 0 AND
    "paidBreakMinutes" >= 0 AND
    "unpaidBreakMinutes" >= 0 AND
    "policyDeductionMinutes" >= 0 AND
    "netWorkedMinutes" >= 0 AND
    "approvedWorkedMinutes" >= 0
  ),
  CONSTRAINT "TimesheetSegment_status_shape_check" CHECK (
    ("status" = 'PENDING' AND "approvedWorkedMinutes" = 0)
    OR
    ("status" = 'APPROVED' AND "reviewedAt" IS NOT NULL AND "reviewedByUserId" IS NOT NULL)
    OR
    ("status" = 'CHANGES_REQUESTED' AND "reviewedAt" IS NOT NULL AND "reviewedByUserId" IS NOT NULL)
  )
);

CREATE TABLE "TimesheetEvent" (
  "id" UUID NOT NULL,
  "timesheetId" UUID NOT NULL,
  "segmentId" UUID,
  "actorUserId" UUID,
  "type" "TimesheetEventType" NOT NULL,
  "note" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimesheetEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TimePeriod_organizationId_startDate_endDate_key"
  ON "TimePeriod"("organizationId", "startDate", "endDate");
CREATE INDEX "TimePeriod_organizationId_status_startDate_idx"
  ON "TimePeriod"("organizationId", "status", "startDate");

CREATE UNIQUE INDEX "Timesheet_employeeId_timePeriodId_key"
  ON "Timesheet"("employeeId", "timePeriodId");
CREATE INDEX "Timesheet_employeeId_status_idx"
  ON "Timesheet"("employeeId", "status");
CREATE INDEX "Timesheet_timePeriodId_status_idx"
  ON "Timesheet"("timePeriodId", "status");

CREATE UNIQUE INDEX "TimesheetSegment_timesheetId_employmentAssignmentId_key"
  ON "TimesheetSegment"("timesheetId", "employmentAssignmentId");
CREATE INDEX "TimesheetSegment_employmentAssignmentId_status_idx"
  ON "TimesheetSegment"("employmentAssignmentId", "status");

CREATE INDEX "TimesheetEvent_timesheetId_occurredAt_idx"
  ON "TimesheetEvent"("timesheetId", "occurredAt");
CREATE INDEX "TimesheetEvent_segmentId_occurredAt_idx"
  ON "TimesheetEvent"("segmentId", "occurredAt");

ALTER TABLE "TimePeriod"
  ADD CONSTRAINT "TimePeriod_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Timesheet"
  ADD CONSTRAINT "Timesheet_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Timesheet"
  ADD CONSTRAINT "Timesheet_timePeriodId_fkey"
  FOREIGN KEY ("timePeriodId") REFERENCES "TimePeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Timesheet"
  ADD CONSTRAINT "Timesheet_submittedByUserId_fkey"
  FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Timesheet"
  ADD CONSTRAINT "Timesheet_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Timesheet"
  ADD CONSTRAINT "Timesheet_lockedByUserId_fkey"
  FOREIGN KEY ("lockedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Timesheet"
  ADD CONSTRAINT "Timesheet_reopenedByUserId_fkey"
  FOREIGN KEY ("reopenedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimesheetSegment"
  ADD CONSTRAINT "TimesheetSegment_timesheetId_fkey"
  FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimesheetSegment"
  ADD CONSTRAINT "TimesheetSegment_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimesheetSegment"
  ADD CONSTRAINT "TimesheetSegment_reviewedByUserId_fkey"
  FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimesheetEvent"
  ADD CONSTRAINT "TimesheetEvent_timesheetId_fkey"
  FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TimesheetEvent"
  ADD CONSTRAINT "TimesheetEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
