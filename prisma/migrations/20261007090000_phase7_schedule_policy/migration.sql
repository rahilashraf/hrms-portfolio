CREATE TYPE "SchedulePeriodType" AS ENUM ('WEEKLY');
CREATE TYPE "UnscheduledWorkMode" AS ENUM ('ALLOW_UNSCHEDULED', 'WARN_UNSCHEDULED', 'REQUIRE_SCHEDULED_SHIFT');
CREATE TYPE "SchedulePolicyConflictSeverity" AS ENUM ('WARNING', 'ERROR');

-- Policy-driven conflicts. Like every overrideable conflict they are computed, never stored;
-- only accepted overrides persist (with a NULL conflictingShiftId for a duration conflict).
ALTER TYPE "ScheduleConflictType" ADD VALUE 'MINIMUM_REST_VIOLATION';
ALTER TYPE "ScheduleConflictType" ADD VALUE 'MAXIMUM_SHIFT_DURATION_EXCEEDED';

-- Effective-dated scheduling policy for one organizational scope. Every setting is optional and
-- inherited per field from the most specific effective scope that sets it.
CREATE TABLE "SchedulePolicy" (
  "id" UUID NOT NULL,
  "scopeType" "ScheduleScopeType" NOT NULL,
  "organizationId" UUID NOT NULL,
  "organizationalUnitId" UUID,
  "departmentId" UUID,
  "teamId" UUID,
  "name" TEXT,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "generationHorizonDays" INTEGER,
  "defaultSchedulePeriod" "SchedulePeriodType",
  "autoCreateSchedules" BOOLEAN,
  "unscheduledWorkMode" "UnscheduledWorkMode",
  "clockInEarlyMinutes" INTEGER,
  "clockInLateMinutes" INTEGER,
  "overlapConflictSeverity" "SchedulePolicyConflictSeverity",
  "minimumRestMinutes" INTEGER,
  "maximumShiftDurationMinutes" INTEGER,
  "requireWorkLocation" BOOLEAN,
  "allowManagerConflictOverride" BOOLEAN,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "SchedulePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SchedulePolicy_scope_target_check" CHECK (
    ("scopeType" = 'ORGANIZATION' AND "organizationalUnitId" IS NULL AND "departmentId" IS NULL AND "teamId" IS NULL) OR
    ("scopeType" = 'ORGANIZATIONAL_UNIT' AND "organizationalUnitId" IS NOT NULL AND "departmentId" IS NULL AND "teamId" IS NULL) OR
    ("scopeType" = 'DEPARTMENT' AND "organizationalUnitId" IS NULL AND "departmentId" IS NOT NULL AND "teamId" IS NULL) OR
    ("scopeType" = 'TEAM' AND "organizationalUnitId" IS NULL AND "departmentId" IS NULL AND "teamId" IS NOT NULL)
  ),
  -- Inclusive DATE period.
  CONSTRAINT "SchedulePolicy_effective_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  CONSTRAINT "SchedulePolicy_name_nonempty_check" CHECK ("name" IS NULL OR trim("name") <> ''),
  -- A policy row must set something.
  CONSTRAINT "SchedulePolicy_has_setting_check" CHECK (num_nonnulls(
    "generationHorizonDays", "defaultSchedulePeriod", "autoCreateSchedules", "unscheduledWorkMode",
    "clockInEarlyMinutes", "clockInLateMinutes", "overlapConflictSeverity", "minimumRestMinutes",
    "maximumShiftDurationMinutes", "requireWorkLocation", "allowManagerConflictOverride"
  ) > 0),
  CONSTRAINT "SchedulePolicy_generation_horizon_check" CHECK ("generationHorizonDays" IS NULL OR "generationHorizonDays" BETWEEN 1 AND 366),
  CONSTRAINT "SchedulePolicy_clock_in_window_check" CHECK (
    ("clockInEarlyMinutes" IS NULL OR "clockInEarlyMinutes" BETWEEN 0 AND 1440) AND
    ("clockInLateMinutes" IS NULL OR "clockInLateMinutes" BETWEEN 0 AND 1440)
  ),
  CONSTRAINT "SchedulePolicy_minimum_rest_check" CHECK ("minimumRestMinutes" IS NULL OR "minimumRestMinutes" BETWEEN 0 AND 2880),
  CONSTRAINT "SchedulePolicy_maximum_duration_check" CHECK ("maximumShiftDurationMinutes" IS NULL OR "maximumShiftDurationMinutes" BETWEEN 1 AND 2880)
);

CREATE INDEX "SchedulePolicy_organizationId_scopeType_effectiveFrom_idx"
  ON "SchedulePolicy"("organizationId", "scopeType", "effectiveFrom");
CREATE INDEX "SchedulePolicy_organizationalUnitId_effectiveFrom_idx"
  ON "SchedulePolicy"("organizationalUnitId", "effectiveFrom");
CREATE INDEX "SchedulePolicy_departmentId_effectiveFrom_idx"
  ON "SchedulePolicy"("departmentId", "effectiveFrom");
CREATE INDEX "SchedulePolicy_teamId_effectiveFrom_idx"
  ON "SchedulePolicy"("teamId", "effectiveFrom");

ALTER TABLE "SchedulePolicy"
  ADD CONSTRAINT "SchedulePolicy_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SchedulePolicy"
  ADD CONSTRAINT "SchedulePolicy_organizationalUnitId_organizationId_fkey"
  FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SchedulePolicy"
  ADD CONSTRAINT "SchedulePolicy_departmentId_organizationId_fkey"
  FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SchedulePolicy"
  ADD CONSTRAINT "SchedulePolicy_teamId_organizationId_fkey"
  FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
