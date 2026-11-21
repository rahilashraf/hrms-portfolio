CREATE TYPE "ScheduleScopeType" AS ENUM ('ORGANIZATION', 'ORGANIZATIONAL_UNIT', 'DEPARTMENT', 'TEAM');
CREATE TYPE "ScheduleType" AS ENUM ('STANDARD', 'AD_HOC');
CREATE TYPE "ScheduleStatus" AS ENUM ('DRAFT', 'PUBLISHED');
CREATE TYPE "ScheduledShiftStatus" AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TYPE "ScheduledShiftSourceType" AS ENUM ('MANUAL', 'PATTERN');

CREATE TABLE "Schedule" (
  "id" UUID NOT NULL,
  "scopeType" "ScheduleScopeType" NOT NULL,
  "organizationId" UUID NOT NULL,
  "organizationalUnitId" UUID,
  "departmentId" UUID,
  "teamId" UUID,
  "name" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "type" "ScheduleType" NOT NULL,
  "status" "ScheduleStatus" NOT NULL DEFAULT 'DRAFT',
  "publishedAt" TIMESTAMPTZ(6),
  "publishedByUserId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Schedule_period_order_check" CHECK ("periodEnd" >= "periodStart"),
  CONSTRAINT "Schedule_scope_target_check" CHECK (
    (
      "scopeType" = 'ORGANIZATION' AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NULL
    ) OR (
      "scopeType" = 'ORGANIZATIONAL_UNIT' AND
      "organizationalUnitId" IS NOT NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NULL
    ) OR (
      "scopeType" = 'DEPARTMENT' AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NOT NULL AND
      "teamId" IS NULL
    ) OR (
      "scopeType" = 'TEAM' AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NOT NULL
    )
  ),
  CONSTRAINT "Schedule_publication_shape_check" CHECK (
    ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "publishedByUserId" IS NULL)
    OR
    ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "publishedByUserId" IS NOT NULL)
  )
);

CREATE TABLE "ScheduledShift" (
  "id" UUID NOT NULL,
  "scheduleId" UUID NOT NULL,
  "employmentAssignmentId" UUID NOT NULL,
  "workLocationId" UUID,
  "workDate" DATE NOT NULL,
  "startsAt" TIMESTAMPTZ(6) NOT NULL,
  "endsAt" TIMESTAMPTZ(6) NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" "ScheduledShiftStatus" NOT NULL DEFAULT 'ACTIVE',
  "sourceType" "ScheduledShiftSourceType" NOT NULL DEFAULT 'MANUAL',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ScheduledShift_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledShift_interval_order_check" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "ScheduledShift_timezone_nonempty_check" CHECK (trim("timezone") <> '')
);

CREATE INDEX "Schedule_organizationId_status_periodStart_periodEnd_idx"
  ON "Schedule"("organizationId", "status", "periodStart", "periodEnd");
CREATE INDEX "Schedule_organizationId_scopeType_status_idx"
  ON "Schedule"("organizationId", "scopeType", "status");
CREATE INDEX "Schedule_organizationId_organizationalUnitId_status_idx"
  ON "Schedule"("organizationId", "organizationalUnitId", "status");
CREATE INDEX "Schedule_organizationId_departmentId_status_idx"
  ON "Schedule"("organizationId", "departmentId", "status");
CREATE INDEX "Schedule_organizationId_teamId_status_idx"
  ON "Schedule"("organizationId", "teamId", "status");

CREATE INDEX "ScheduledShift_scheduleId_workDate_idx"
  ON "ScheduledShift"("scheduleId", "workDate");
CREATE INDEX "ScheduledShift_scheduleId_employmentAssignmentId_workDate_idx"
  ON "ScheduledShift"("scheduleId", "employmentAssignmentId", "workDate");
CREATE INDEX "ScheduledShift_employmentAssignmentId_workDate_idx"
  ON "ScheduledShift"("employmentAssignmentId", "workDate");
CREATE INDEX "ScheduledShift_employmentAssignmentId_startsAt_endsAt_idx"
  ON "ScheduledShift"("employmentAssignmentId", "startsAt", "endsAt");
CREATE INDEX "ScheduledShift_workLocationId_idx"
  ON "ScheduledShift"("workLocationId");
CREATE INDEX "ScheduledShift_workDate_status_idx"
  ON "ScheduledShift"("workDate", "status");

ALTER TABLE "Schedule"
  ADD CONSTRAINT "Schedule_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Schedule"
  ADD CONSTRAINT "Schedule_organizationalUnitId_organizationId_fkey"
  FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Schedule"
  ADD CONSTRAINT "Schedule_departmentId_organizationId_fkey"
  FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Schedule"
  ADD CONSTRAINT "Schedule_teamId_organizationId_fkey"
  FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Schedule"
  ADD CONSTRAINT "Schedule_publishedByUserId_fkey"
  FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledShift"
  ADD CONSTRAINT "ScheduledShift_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledShift"
  ADD CONSTRAINT "ScheduledShift_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledShift"
  ADD CONSTRAINT "ScheduledShift_workLocationId_fkey"
  FOREIGN KEY ("workLocationId") REFERENCES "WorkLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
