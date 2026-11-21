-- Phase 8 — organization calendar, leave types and effective-dated leave policies.
CREATE TYPE "HolidayKind" AS ENUM ('STATUTORY_HOLIDAY', 'CLOSURE');

CREATE TYPE "LeaveClassification" AS ENUM ('PAID', 'UNPAID');

CREATE TYPE "LeaveDisplayUnit" AS ENUM ('HOURS', 'DAYS');

CREATE TYPE "LeavePolicyScopeType" AS ENUM ('ORGANIZATION', 'ORGANIZATIONAL_UNIT', 'DEPARTMENT', 'TEAM', 'EMPLOYMENT_ASSIGNMENT');

CREATE TYPE "LeaveAmountSource" AS ENUM ('SCHEDULE_THEN_STANDARD', 'STANDARD_ONLY');

CREATE TYPE "LeaveAccrualMethod" AS ENUM ('NONE', 'ANNUAL_GRANT', 'PERIODIC');

CREATE TYPE "LeaveAccrualFrequency" AS ENUM ('MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY');

CREATE TYPE "LeaveCarryoverMode" AS ENUM ('NONE', 'CAPPED', 'UNLIMITED');

ALTER TABLE "Organization" ADD COLUMN     "timezone" TEXT;

CREATE TABLE "OrganizationHoliday" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "organizationalUnitId" UUID,
    "departmentId" UUID,
    "teamId" UUID,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "HolidayKind" NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "OrganizationHoliday_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaveType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "classification" "LeaveClassification" NOT NULL,
    "tracksBalance" BOOLEAN NOT NULL DEFAULT true,
    "displayUnit" "LeaveDisplayUnit" NOT NULL DEFAULT 'DAYS',
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeavePolicy" (
    "id" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "scopeType" "LeavePolicyScopeType" NOT NULL,
    "organizationalUnitId" UUID,
    "departmentId" UUID,
    "teamId" UUID,
    "employmentAssignmentId" UUID,
    "employmentTypes" "EmploymentType"[] DEFAULT ARRAY[]::"EmploymentType"[],
    "name" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "waitingPeriodDays" INTEGER NOT NULL DEFAULT 0,
    "leaveYearStartMonth" INTEGER NOT NULL DEFAULT 1,
    "leaveYearStartDay" INTEGER NOT NULL DEFAULT 1,
    "amountSource" "LeaveAmountSource" NOT NULL DEFAULT 'SCHEDULE_THEN_STANDARD',
    "standardWorkdayMinutes" INTEGER NOT NULL DEFAULT 480,
    "standardWorkdays" "ScheduleDayOfWeek"[] DEFAULT ARRAY['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']::"ScheduleDayOfWeek"[],
    "excludeHolidays" BOOLEAN NOT NULL DEFAULT true,
    "allowPartialDay" BOOLEAN NOT NULL DEFAULT true,
    "accrualMethod" "LeaveAccrualMethod" NOT NULL DEFAULT 'NONE',
    "annualGrantMinutes" INTEGER,
    "accrualFrequency" "LeaveAccrualFrequency",
    "accrualMinutesPerPeriod" INTEGER,
    "accrualAnchorDate" DATE,
    "prorateFirstYear" BOOLEAN NOT NULL DEFAULT false,
    "maxBalanceMinutes" INTEGER,
    "negativeBalanceLimitMinutes" INTEGER NOT NULL DEFAULT 0,
    "carryoverMode" "LeaveCarryoverMode" NOT NULL DEFAULT 'UNLIMITED',
    "carryoverMaxMinutes" INTEGER,
    "carryoverExpiryDays" INTEGER,
    "employeeMayCancelApprovedFuture" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrganizationHoliday_organizationId_date_idx" ON "OrganizationHoliday"("organizationId", "date");

CREATE UNIQUE INDEX "LeaveType_organizationId_code_key" ON "LeaveType"("organizationId", "code");

CREATE UNIQUE INDEX "LeaveType_id_organizationId_key" ON "LeaveType"("id", "organizationId");

CREATE INDEX "LeavePolicy_leaveTypeId_scopeType_effectiveFrom_idx" ON "LeavePolicy"("leaveTypeId", "scopeType", "effectiveFrom");

CREATE INDEX "LeavePolicy_organizationId_effectiveFrom_idx" ON "LeavePolicy"("organizationId", "effectiveFrom");

CREATE INDEX "LeavePolicy_employmentAssignmentId_idx" ON "LeavePolicy"("employmentAssignmentId");

ALTER TABLE "OrganizationHoliday" ADD CONSTRAINT "OrganizationHoliday_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrganizationHoliday" ADD CONSTRAINT "OrganizationHoliday_organizationalUnitId_organizationId_fkey" FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrganizationHoliday" ADD CONSTRAINT "OrganizationHoliday_departmentId_organizationId_fkey" FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrganizationHoliday" ADD CONSTRAINT "OrganizationHoliday_teamId_organizationId_fkey" FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_leaveTypeId_organizationId_fkey" FOREIGN KEY ("leaveTypeId", "organizationId") REFERENCES "LeaveType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_organizationalUnitId_organizationId_fkey" FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_departmentId_organizationId_fkey" FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_teamId_organizationId_fkey" FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_employmentAssignmentId_fkey" FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Organization timezone: the fallback after a position's WorkLocation timezone when converting
-- local dates to instants. Backfilled from the organization's own WorkLocations (most common
-- timezone), otherwise the deployment timezone (America/Toronto). WorkLocation stays more specific.
UPDATE "Organization" o
SET "timezone" = COALESCE(
  (
    SELECT wl."timezone"
    FROM "WorkLocation" wl
    WHERE wl."organizationId" = o."id" AND wl."timezone" IS NOT NULL AND btrim(wl."timezone") <> ''
    GROUP BY wl."timezone"
    ORDER BY count(*) DESC, wl."timezone"
    LIMIT 1
  ),
  'America/Toronto'
)
WHERE o."timezone" IS NULL;

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_timezone_not_blank_check" CHECK ("timezone" IS NULL OR btrim("timezone") <> '');

ALTER TABLE "OrganizationHoliday"
  ADD CONSTRAINT "OrganizationHoliday_scope_shape_check" CHECK (num_nonnulls("organizationalUnitId", "departmentId", "teamId") <= 1),
  ADD CONSTRAINT "OrganizationHoliday_name_not_blank_check" CHECK (btrim("name") <> '');

-- One active holiday per scope target and date.
CREATE UNIQUE INDEX "OrganizationHoliday_active_scope_date_key"
  ON "OrganizationHoliday" (
    "organizationId",
    COALESCE("organizationalUnitId", "departmentId", "teamId", '00000000-0000-0000-0000-000000000000'::uuid),
    "date"
  )
  WHERE "archivedAt" IS NULL;

ALTER TABLE "LeaveType"
  ADD CONSTRAINT "LeaveType_code_not_blank_check" CHECK (btrim("code") <> ''),
  ADD CONSTRAINT "LeaveType_name_not_blank_check" CHECK (btrim("name") <> '');

ALTER TABLE "LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_scope_target_check" CHECK (
    ("scopeType" = 'ORGANIZATION' AND num_nonnulls("organizationalUnitId", "departmentId", "teamId", "employmentAssignmentId") = 0) OR
    ("scopeType" = 'ORGANIZATIONAL_UNIT' AND "organizationalUnitId" IS NOT NULL AND num_nonnulls("departmentId", "teamId", "employmentAssignmentId") = 0) OR
    ("scopeType" = 'DEPARTMENT' AND "departmentId" IS NOT NULL AND num_nonnulls("organizationalUnitId", "teamId", "employmentAssignmentId") = 0) OR
    ("scopeType" = 'TEAM' AND "teamId" IS NOT NULL AND num_nonnulls("organizationalUnitId", "departmentId", "employmentAssignmentId") = 0) OR
    ("scopeType" = 'EMPLOYMENT_ASSIGNMENT' AND "employmentAssignmentId" IS NOT NULL AND num_nonnulls("organizationalUnitId", "departmentId", "teamId") = 0)
  ),
  ADD CONSTRAINT "LeavePolicy_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  ADD CONSTRAINT "LeavePolicy_name_not_blank_check" CHECK ("name" IS NULL OR btrim("name") <> ''),
  ADD CONSTRAINT "LeavePolicy_arrays_not_null_check" CHECK ("employmentTypes" IS NOT NULL AND "standardWorkdays" IS NOT NULL),
  ADD CONSTRAINT "LeavePolicy_waiting_period_check" CHECK ("waitingPeriodDays" BETWEEN 0 AND 3660),
  ADD CONSTRAINT "LeavePolicy_leave_year_check" CHECK ("leaveYearStartMonth" BETWEEN 1 AND 12 AND "leaveYearStartDay" BETWEEN 1 AND 28),
  ADD CONSTRAINT "LeavePolicy_standard_workday_check" CHECK ("standardWorkdayMinutes" BETWEEN 1 AND 1440),
  ADD CONSTRAINT "LeavePolicy_accrual_shape_check" CHECK (
    ("accrualMethod" = 'NONE' AND num_nonnulls("annualGrantMinutes", "accrualFrequency", "accrualMinutesPerPeriod", "accrualAnchorDate") = 0) OR
    ("accrualMethod" = 'ANNUAL_GRANT' AND "annualGrantMinutes" BETWEEN 0 AND 527040 AND num_nonnulls("accrualFrequency", "accrualMinutesPerPeriod", "accrualAnchorDate") = 0) OR
    ("accrualMethod" = 'PERIODIC' AND "annualGrantMinutes" IS NULL AND "accrualFrequency" IS NOT NULL
      AND "accrualMinutesPerPeriod" BETWEEN 0 AND 44640
      AND (("accrualFrequency" = 'BIWEEKLY') = ("accrualAnchorDate" IS NOT NULL)))
  ),
  ADD CONSTRAINT "LeavePolicy_balance_limits_check" CHECK (
    ("maxBalanceMinutes" IS NULL OR "maxBalanceMinutes" >= 0) AND "negativeBalanceLimitMinutes" BETWEEN 0 AND 527040
  ),
  ADD CONSTRAINT "LeavePolicy_carryover_shape_check" CHECK (
    (("carryoverMode" = 'CAPPED') = ("carryoverMaxMinutes" IS NOT NULL))
    AND ("carryoverMaxMinutes" IS NULL OR "carryoverMaxMinutes" >= 0)
    AND ("carryoverExpiryDays" IS NULL OR ("carryoverExpiryDays" BETWEEN 1 AND 3660 AND "carryoverMode" <> 'NONE'))
  );
