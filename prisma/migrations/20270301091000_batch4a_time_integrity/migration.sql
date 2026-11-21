-- Batch 4A — Time integrity (2/2). Additive only: no existing row is changed or deleted, and
-- nothing here can fail on data already in the database.

-- ─── One CLOCK_OUT punch per time entry, from now on ───────────────────────────────────────
-- A trigger rather than a partial unique index: a unique index would fail to build if an
-- earlier race ever left an entry with two CLOCK_OUT punches, and punches are immutable
-- evidence that must not be deleted to make room for it. Existing rows are left as they are
-- (docs/audits/2026-11-02-batch-4a-notes.md has the read-only preflight that counts them); every
-- new CLOCK_OUT is refused when its entry already has one. The entry row is locked first (FOR NO
-- KEY UPDATE, the lock the closing UPDATE takes anyway, which leaves foreign-key share locks
-- alone), so two concurrent inserts for the same entry cannot both pass the check.
CREATE FUNCTION "time_punch_single_clock_out"() RETURNS trigger AS $$
BEGIN
  IF NEW."type" = 'CLOCK_OUT' AND NEW."timeEntryId" IS NOT NULL THEN
    PERFORM 1 FROM "TimeEntry" WHERE "id" = NEW."timeEntryId" FOR NO KEY UPDATE;
    IF EXISTS (
      SELECT 1 FROM "TimePunch"
      WHERE "timeEntryId" = NEW."timeEntryId" AND "type" = 'CLOCK_OUT'
    ) THEN
      RAISE EXCEPTION 'TimeEntry % already has a CLOCK_OUT punch', NEW."timeEntryId"
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TimePunch_single_clock_out"
BEFORE INSERT ON "TimePunch"
FOR EACH ROW EXECUTE FUNCTION "time_punch_single_clock_out"();

-- ─── Retroactive adjustment requirements ───────────────────────────────────────────────────
-- Written when a timesheet whose time a FINALIZED payroll run claimed is reopened. The finalized
-- run and its claims are never changed; payroll warns against each such run until a
-- retroactive adjustment answers it, or a PayrollRetroResolution records that there is no
-- difference to pay. Append-only. timesheetVersion is the version the run paid, read from its
-- own PayrollTimeSnapshot rows; NULL when they don't name exactly one version (never guessed).
CREATE TABLE "PayrollRetroRequirement" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "timesheetId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "timesheetVersion" INTEGER,
    "firstWorkDate" DATE NOT NULL,
    "lastWorkDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRetroRequirement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayrollRetroRequirement_reason_check" CHECK (btrim("reason") <> ''),
    CONSTRAINT "PayrollRetroRequirement_version_check" CHECK ("timesheetVersion" IS NULL OR "timesheetVersion" >= 1),
    CONSTRAINT "PayrollRetroRequirement_dates_check" CHECK ("firstWorkDate" <= "lastWorkDate")
);

CREATE INDEX "PayrollRetroRequirement_employmentAssignmentId_payrollRunId_idx" ON "PayrollRetroRequirement"("employmentAssignmentId", "payrollRunId");

CREATE INDEX "PayrollRetroRequirement_timesheetId_idx" ON "PayrollRetroRequirement"("timesheetId");

CREATE INDEX "PayrollRetroRequirement_payrollRunId_timesheetId_employment_idx" ON "PayrollRetroRequirement"("payrollRunId", "timesheetId", "employmentAssignmentId");

-- One requirement per run, timesheet, assignment and paid version: reopening the same paid time
-- again adds nothing. A NULL (unknown) version is its own single slot.
CREATE UNIQUE INDEX "PayrollRetroRequirement_paid_version_key" ON "PayrollRetroRequirement"("payrollRunId", "timesheetId", "employmentAssignmentId", "timesheetVersion") WHERE "timesheetVersion" IS NOT NULL;

CREATE UNIQUE INDEX "PayrollRetroRequirement_unknown_version_key" ON "PayrollRetroRequirement"("payrollRunId", "timesheetId", "employmentAssignmentId") WHERE "timesheetVersion" IS NULL;

ALTER TABLE "PayrollRetroRequirement" ADD CONSTRAINT "PayrollRetroRequirement_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRetroRequirement" ADD CONSTRAINT "PayrollRetroRequirement_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRetroRequirement" ADD CONSTRAINT "PayrollRetroRequirement_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRetroRequirement" ADD CONSTRAINT "PayrollRetroRequirement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "prevent_payroll_retro_requirement_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PayrollRetroRequirement rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollRetroRequirement_prevent_update"
BEFORE UPDATE ON "PayrollRetroRequirement"
FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_retro_requirement_mutation"();

CREATE TRIGGER "PayrollRetroRequirement_prevent_delete"
BEFORE DELETE ON "PayrollRetroRequirement"
FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_retro_requirement_mutation"();

-- ─── Retroactive adjustment resolutions ────────────────────────────────────────────────────
-- Written by the retro tool when it settles an assignment of a finalized run: at the current
-- source fingerprint, the finalized gross plus the run's adjustments (adjustedAmount) is exactly
-- what the sources now pay, either already (NO_ADJUSTMENT_REQUIRED) or with the adjustment it
-- just created (ADJUSTED). It answers PRIOR_PERIOD_SOURCE_CHANGED only while the fingerprint and
-- that sum still match. Append-only; the unique key keeps repeated calculations from adding
-- duplicates.
CREATE TABLE "PayrollRetroResolution" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "adjustedAmount" DECIMAL(19,2) NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRetroResolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayrollRetroResolution_reason_check" CHECK (btrim("reason") <> ''),
    CONSTRAINT "PayrollRetroResolution_fingerprint_check" CHECK (btrim("sourceFingerprint") <> ''),
    CONSTRAINT "PayrollRetroResolution_outcome_check" CHECK ("outcome" IN ('NO_ADJUSTMENT_REQUIRED', 'ADJUSTED'))
);

CREATE UNIQUE INDEX "PayrollRetroResolution_payrollRunId_employmentAssignmentId__key" ON "PayrollRetroResolution"("payrollRunId", "employmentAssignmentId", "sourceFingerprint", "adjustedAmount");

CREATE INDEX "PayrollRetroResolution_employmentAssignmentId_payrollRunId_idx" ON "PayrollRetroResolution"("employmentAssignmentId", "payrollRunId");

ALTER TABLE "PayrollRetroResolution" ADD CONSTRAINT "PayrollRetroResolution_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRetroResolution" ADD CONSTRAINT "PayrollRetroResolution_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayrollRetroResolution" ADD CONSTRAINT "PayrollRetroResolution_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "prevent_payroll_retro_resolution_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PayrollRetroResolution rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollRetroResolution_prevent_update"
BEFORE UPDATE ON "PayrollRetroResolution"
FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_retro_resolution_mutation"();

CREATE TRIGGER "PayrollRetroResolution_prevent_delete"
BEFORE DELETE ON "PayrollRetroResolution"
FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_retro_resolution_mutation"();
