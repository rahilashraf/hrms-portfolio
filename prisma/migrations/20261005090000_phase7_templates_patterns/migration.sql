-- ISO weekday order (Monday first); never a locale or runtime-specific number.
CREATE TYPE "ScheduleDayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- Reusable organization-level N-week presets. Applying one copies its rules; nothing inherits live.
CREATE TABLE "ScheduleTemplate" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "rotationWeeks" INTEGER NOT NULL,
  "archivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ScheduleTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduleTemplate_name_nonempty_check" CHECK (trim("name") <> ''),
  CONSTRAINT "ScheduleTemplate_rotation_weeks_check" CHECK ("rotationWeeks" BETWEEN 1 AND 52)
);

-- Local wall-clock rules: TIME columns, never instants. endLocalTime <= startLocalTime ends on
-- the following local day. weekIndex is 0-based; its upper bound (rotationWeeks - 1) spans
-- two tables and is enforced by the application under the parent row lock.
CREATE TABLE "ScheduleTemplateRule" (
  "id" UUID NOT NULL,
  "scheduleTemplateId" UUID NOT NULL,
  "weekIndex" INTEGER NOT NULL,
  "dayOfWeek" "ScheduleDayOfWeek" NOT NULL,
  "startLocalTime" TIME(0) NOT NULL,
  "endLocalTime" TIME(0) NOT NULL,
  "workLocationId" UUID,
  "timezone" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ScheduleTemplateRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduleTemplateRule_week_index_check" CHECK ("weekIndex" BETWEEN 0 AND 51),
  CONSTRAINT "ScheduleTemplateRule_sort_order_check" CHECK ("sortOrder" >= 0),
  -- A deterministic timezone source must exist: a WorkLocation or an explicit fallback.
  CONSTRAINT "ScheduleTemplateRule_timezone_source_check" CHECK ("workLocationId" IS NOT NULL OR "timezone" IS NOT NULL),
  CONSTRAINT "ScheduleTemplateRule_timezone_nonempty_check" CHECK ("timezone" IS NULL OR trim("timezone") <> '')
);

-- Effective-dated recurring work for one EmploymentAssignment. weekIndex 0 is the
-- Monday-to-Sunday week that starts on anchorDate.
CREATE TABLE "EmployeeSchedulePattern" (
  "id" UUID NOT NULL,
  "employmentAssignmentId" UUID NOT NULL,
  "name" TEXT,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "rotationWeeks" INTEGER NOT NULL,
  "anchorDate" DATE NOT NULL,
  "sourceTemplateId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "EmployeeSchedulePattern_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeSchedulePattern_name_nonempty_check" CHECK ("name" IS NULL OR trim("name") <> ''),
  CONSTRAINT "EmployeeSchedulePattern_rotation_weeks_check" CHECK ("rotationWeeks" BETWEEN 1 AND 52),
  -- Inclusive DATE period: effectiveTo = effectiveFrom is a one-day pattern.
  CONSTRAINT "EmployeeSchedulePattern_effective_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  CONSTRAINT "EmployeeSchedulePattern_anchor_monday_check" CHECK (EXTRACT(ISODOW FROM "anchorDate") = 1)
);

CREATE TABLE "EmployeeSchedulePatternRule" (
  "id" UUID NOT NULL,
  "employeeSchedulePatternId" UUID NOT NULL,
  "weekIndex" INTEGER NOT NULL,
  "dayOfWeek" "ScheduleDayOfWeek" NOT NULL,
  "startLocalTime" TIME(0) NOT NULL,
  "endLocalTime" TIME(0) NOT NULL,
  "workLocationId" UUID,
  "timezone" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "EmployeeSchedulePatternRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeSchedulePatternRule_week_index_check" CHECK ("weekIndex" BETWEEN 0 AND 51),
  CONSTRAINT "EmployeeSchedulePatternRule_sort_order_check" CHECK ("sortOrder" >= 0),
  CONSTRAINT "EmployeeSchedulePatternRule_timezone_source_check" CHECK ("workLocationId" IS NOT NULL OR "timezone" IS NOT NULL),
  CONSTRAINT "EmployeeSchedulePatternRule_timezone_nonempty_check" CHECK ("timezone" IS NULL OR trim("timezone") <> '')
);

CREATE INDEX "ScheduleTemplate_organizationId_archivedAt_name_idx"
  ON "ScheduleTemplate"("organizationId", "archivedAt", "name");
-- Active template names are unique per organization, case-insensitively; archived ones are history.
CREATE UNIQUE INDEX "ScheduleTemplate_organizationId_active_name_key"
  ON "ScheduleTemplate"("organizationId", lower("name"))
  WHERE "archivedAt" IS NULL;
CREATE INDEX "ScheduleTemplateRule_scheduleTemplateId_weekIndex_dayOfWeek_idx"
  ON "ScheduleTemplateRule"("scheduleTemplateId", "weekIndex", "dayOfWeek");
CREATE INDEX "ScheduleTemplateRule_workLocationId_idx"
  ON "ScheduleTemplateRule"("workLocationId");
CREATE INDEX "EmployeeSchedulePattern_employmentAssignmentId_effectiveFro_idx"
  ON "EmployeeSchedulePattern"("employmentAssignmentId", "effectiveFrom", "effectiveTo");
CREATE INDEX "EmployeeSchedulePattern_sourceTemplateId_idx"
  ON "EmployeeSchedulePattern"("sourceTemplateId");
CREATE INDEX "EmployeeSchedulePatternRule_employeeSchedulePatternId_weekI_idx"
  ON "EmployeeSchedulePatternRule"("employeeSchedulePatternId", "weekIndex", "dayOfWeek");
CREATE INDEX "EmployeeSchedulePatternRule_workLocationId_idx"
  ON "EmployeeSchedulePatternRule"("workLocationId");

ALTER TABLE "ScheduleTemplate"
  ADD CONSTRAINT "ScheduleTemplate_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduleTemplateRule"
  ADD CONSTRAINT "ScheduleTemplateRule_scheduleTemplateId_fkey"
  FOREIGN KEY ("scheduleTemplateId") REFERENCES "ScheduleTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduleTemplateRule"
  ADD CONSTRAINT "ScheduleTemplateRule_workLocationId_fkey"
  FOREIGN KEY ("workLocationId") REFERENCES "WorkLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeSchedulePattern"
  ADD CONSTRAINT "EmployeeSchedulePattern_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT keeps provenance: a template referenced by a pattern cannot be hard-deleted.
ALTER TABLE "EmployeeSchedulePattern"
  ADD CONSTRAINT "EmployeeSchedulePattern_sourceTemplateId_fkey"
  FOREIGN KEY ("sourceTemplateId") REFERENCES "ScheduleTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeSchedulePatternRule"
  ADD CONSTRAINT "EmployeeSchedulePatternRule_employeeSchedulePatternId_fkey"
  FOREIGN KEY ("employeeSchedulePatternId") REFERENCES "EmployeeSchedulePattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeSchedulePatternRule"
  ADD CONSTRAINT "EmployeeSchedulePatternRule_workLocationId_fkey"
  FOREIGN KEY ("workLocationId") REFERENCES "WorkLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
