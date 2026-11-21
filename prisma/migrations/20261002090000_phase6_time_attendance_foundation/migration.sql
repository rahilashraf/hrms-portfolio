CREATE TYPE "TimeEntryStatus" AS ENUM ('OPEN', 'CLOSED', 'VOIDED');
CREATE TYPE "TimeEntrySource" AS ENUM ('LIVE_CLOCK', 'MANUAL', 'SYSTEM');
CREATE TYPE "TimePunchType" AS ENUM ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END');
CREATE TYPE "TimePunchSource" AS ENUM ('LIVE_CLOCK', 'MANUAL', 'SYSTEM');
CREATE TYPE "TimeAttendancePolicyScopeType" AS ENUM (
  'SYSTEM',
  'ORGANIZATION',
  'ORGANIZATIONAL_UNIT',
  'DEPARTMENT',
  'TEAM',
  'EMPLOYMENT_ASSIGNMENT'
);
CREATE TYPE "TimeAttendancePolicyInheritanceMode" AS ENUM ('INHERIT', 'OVERRIDE');

CREATE TABLE "TimeEntry" (
  "id" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "employmentAssignmentId" UUID NOT NULL,
  "clockInAt" TIMESTAMPTZ(6) NOT NULL,
  "clockOutAt" TIMESTAMPTZ(6),
  "timezone" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "status" "TimeEntryStatus" NOT NULL DEFAULT 'OPEN',
  "source" "TimeEntrySource" NOT NULL DEFAULT 'LIVE_CLOCK',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "archivedAt" TIMESTAMPTZ(6),
  CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimeEntry_clock_order_check" CHECK ("clockOutAt" IS NULL OR "clockOutAt" > "clockInAt"),
  CONSTRAINT "TimeEntry_status_clockout_check" CHECK (
    ("status" = 'OPEN' AND "clockOutAt" IS NULL) OR
    ("status" = 'CLOSED' AND "clockOutAt" IS NOT NULL) OR
    "status" = 'VOIDED'
  ),
  CONSTRAINT "TimeEntry_timezone_not_blank_check" CHECK (length(btrim("timezone")) > 0)
);

CREATE TABLE "TimePunch" (
  "id" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "employmentAssignmentId" UUID NOT NULL,
  "timeEntryId" UUID,
  "type" "TimePunchType" NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "timezone" TEXT NOT NULL,
  "source" "TimePunchSource" NOT NULL DEFAULT 'LIVE_CLOCK',
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimePunch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimePunch_timezone_not_blank_check" CHECK (length(btrim("timezone")) > 0)
);

CREATE TABLE "TimeAttendancePolicy" (
  "id" UUID NOT NULL,
  "scopeType" "TimeAttendancePolicyScopeType" NOT NULL,
  "organizationId" UUID,
  "organizationalUnitId" UUID,
  "departmentId" UUID,
  "teamId" UUID,
  "employmentAssignmentId" UUID,
  "inheritanceMode" "TimeAttendancePolicyInheritanceMode" NOT NULL DEFAULT 'INHERIT',
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  "config" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "archivedAt" TIMESTAMPTZ(6),
  CONSTRAINT "TimeAttendancePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TimeAttendancePolicy_effective_range_check" CHECK ("effectiveTo" IS NULL OR "effectiveFrom" <= "effectiveTo"),
  CONSTRAINT "TimeAttendancePolicy_config_object_check" CHECK (jsonb_typeof("config") = 'object'),
  CONSTRAINT "TimeAttendancePolicy_scope_target_check" CHECK (
    (
      "scopeType" = 'SYSTEM' AND
      "organizationId" IS NULL AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NULL AND
      "employmentAssignmentId" IS NULL
    ) OR (
      "scopeType" = 'ORGANIZATION' AND
      "organizationId" IS NOT NULL AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NULL AND
      "employmentAssignmentId" IS NULL
    ) OR (
      "scopeType" = 'ORGANIZATIONAL_UNIT' AND
      "organizationId" IS NOT NULL AND
      "organizationalUnitId" IS NOT NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NULL AND
      "employmentAssignmentId" IS NULL
    ) OR (
      "scopeType" = 'DEPARTMENT' AND
      "organizationId" IS NOT NULL AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NOT NULL AND
      "teamId" IS NULL AND
      "employmentAssignmentId" IS NULL
    ) OR (
      "scopeType" = 'TEAM' AND
      "organizationId" IS NOT NULL AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NOT NULL AND
      "employmentAssignmentId" IS NULL
    ) OR (
      "scopeType" = 'EMPLOYMENT_ASSIGNMENT' AND
      "organizationId" IS NULL AND
      "organizationalUnitId" IS NULL AND
      "departmentId" IS NULL AND
      "teamId" IS NULL AND
      "employmentAssignmentId" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "EmploymentAssignment_id_employeeId_key" ON "EmploymentAssignment"("id", "employeeId");

CREATE UNIQUE INDEX "TimeEntry_id_employeeId_employmentAssignmentId_key"
  ON "TimeEntry"("id", "employeeId", "employmentAssignmentId");
CREATE UNIQUE INDEX "TimeEntry_one_open_per_employee_key"
  ON "TimeEntry"("employeeId")
  WHERE "status" = 'OPEN' AND "archivedAt" IS NULL;
CREATE INDEX "TimeEntry_employeeId_status_clockInAt_idx"
  ON "TimeEntry"("employeeId", "status", "clockInAt");
CREATE INDEX "TimeEntry_employmentAssignmentId_workDate_idx"
  ON "TimeEntry"("employmentAssignmentId", "workDate");
CREATE INDEX "TimeEntry_workDate_idx" ON "TimeEntry"("workDate");

CREATE INDEX "TimePunch_employeeId_occurredAt_idx"
  ON "TimePunch"("employeeId", "occurredAt");
CREATE INDEX "TimePunch_employmentAssignmentId_occurredAt_idx"
  ON "TimePunch"("employmentAssignmentId", "occurredAt");
CREATE INDEX "TimePunch_timeEntryId_idx" ON "TimePunch"("timeEntryId");

CREATE INDEX "TimeAttendancePolicy_scopeType_effectiveFrom_effectiveTo_idx"
  ON "TimeAttendancePolicy"("scopeType", "effectiveFrom", "effectiveTo");
CREATE INDEX "TimeAttendancePolicy_organizationId_effectiveFrom_idx"
  ON "TimeAttendancePolicy"("organizationId", "effectiveFrom");
CREATE INDEX "TimeAttendancePolicy_organizationalUnitId_effectiveFrom_idx"
  ON "TimeAttendancePolicy"("organizationalUnitId", "effectiveFrom");
CREATE INDEX "TimeAttendancePolicy_departmentId_effectiveFrom_idx"
  ON "TimeAttendancePolicy"("departmentId", "effectiveFrom");
CREATE INDEX "TimeAttendancePolicy_teamId_effectiveFrom_idx"
  ON "TimeAttendancePolicy"("teamId", "effectiveFrom");
CREATE INDEX "TimeAttendancePolicy_employmentAssignmentId_effectiveFrom_idx"
  ON "TimeAttendancePolicy"("employmentAssignmentId", "effectiveFrom");

CREATE UNIQUE INDEX "TimeAttendancePolicy_system_effectiveFrom_key"
  ON "TimeAttendancePolicy"("effectiveFrom")
  WHERE "scopeType" = 'SYSTEM' AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "TimeAttendancePolicy_organization_effectiveFrom_key"
  ON "TimeAttendancePolicy"("organizationId", "effectiveFrom")
  WHERE "scopeType" = 'ORGANIZATION' AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "TimeAttendancePolicy_unit_effectiveFrom_key"
  ON "TimeAttendancePolicy"("organizationId", "organizationalUnitId", "effectiveFrom")
  WHERE "scopeType" = 'ORGANIZATIONAL_UNIT' AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "TimeAttendancePolicy_department_effectiveFrom_key"
  ON "TimeAttendancePolicy"("organizationId", "departmentId", "effectiveFrom")
  WHERE "scopeType" = 'DEPARTMENT' AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "TimeAttendancePolicy_team_effectiveFrom_key"
  ON "TimeAttendancePolicy"("organizationId", "teamId", "effectiveFrom")
  WHERE "scopeType" = 'TEAM' AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "TimeAttendancePolicy_assignment_effectiveFrom_key"
  ON "TimeAttendancePolicy"("employmentAssignmentId", "effectiveFrom")
  WHERE "scopeType" = 'EMPLOYMENT_ASSIGNMENT' AND "archivedAt" IS NULL;

ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimeEntry_employmentAssignmentId_employeeId_fkey"
  FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimePunch"
  ADD CONSTRAINT "TimePunch_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimePunch_employmentAssignmentId_employeeId_fkey"
  FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimePunch_timeEntryId_employeeId_employmentAssignmentId_fkey"
  FOREIGN KEY ("timeEntryId", "employeeId", "employmentAssignmentId") REFERENCES "TimeEntry"("id", "employeeId", "employmentAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeAttendancePolicy"
  ADD CONSTRAINT "TimeAttendancePolicy_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimeAttendancePolicy_organizationalUnitId_organizationId_fkey"
  FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimeAttendancePolicy_departmentId_organizationId_fkey"
  FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimeAttendancePolicy_teamId_organizationId_fkey"
  FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimeAttendancePolicy_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "prevent_time_punch_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TimePunch rows are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TimePunch_prevent_update"
BEFORE UPDATE ON "TimePunch"
FOR EACH ROW EXECUTE FUNCTION "prevent_time_punch_mutation"();

CREATE TRIGGER "TimePunch_prevent_delete"
BEFORE DELETE ON "TimePunch"
FOR EACH ROW EXECUTE FUNCTION "prevent_time_punch_mutation"();
