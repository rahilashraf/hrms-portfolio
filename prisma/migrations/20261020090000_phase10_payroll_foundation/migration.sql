-- CreateEnum
CREATE TYPE "PayrollCalendarCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('UPCOMING', 'OPEN', 'PROCESSING', 'FINALIZED');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'CALCULATED', 'APPROVED', 'FINALIZED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PayrollValidationSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');

-- CreateTable
CREATE TABLE "PayrollCalendar" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "payGroupId" UUID NOT NULL,
    "cadence" "PayrollCalendarCadence" NOT NULL,
    "timezone" TEXT NOT NULL,
    "anchorDate" DATE NOT NULL,
    "payDateOffsetDays" INTEGER NOT NULL,
    "processingCutoffOffsetDays" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "payGroupId" UUID NOT NULL,
    "payrollCalendarId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payDate" DATE NOT NULL,
    "processingCutoffAt" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'UPCOMING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "payrollPeriodId" UUID NOT NULL,
    "payGroupId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "calculationVersion" TEXT,
    "sourceFingerprint" TEXT,
    "calculatedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "approvedByUserId" UUID,
    "finalizedAt" TIMESTAMPTZ(6),
    "finalizedByUserId" UUID,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedByUserId" UUID,
    "voidReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunEmployee" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollRunEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunAssignment" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunEmployeeId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollRunAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollValidationIssue" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunEmployeeId" UUID,
    "payrollRunAssignmentId" UUID,
    "severity" "PayrollValidationSeverity" NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollValidationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollCalendar_organizationId_payGroupId_idx" ON "PayrollCalendar"("organizationId", "payGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCalendar_payGroupId_effectiveFrom_key" ON "PayrollCalendar"("payGroupId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCalendar_id_payGroupId_key" ON "PayrollCalendar"("id", "payGroupId");

-- CreateIndex
CREATE INDEX "PayrollPeriod_organizationId_status_periodStart_idx" ON "PayrollPeriod"("organizationId", "status", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_payGroupId_periodStart_key" ON "PayrollPeriod"("payGroupId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_payGroupId_periodEnd_key" ON "PayrollPeriod"("payGroupId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_id_organizationId_payGroupId_key" ON "PayrollPeriod"("id", "organizationId", "payGroupId");

-- CreateIndex
CREATE INDEX "PayrollRun_organizationId_status_idx" ON "PayrollRun"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PayrollRun_payrollPeriodId_status_idx" ON "PayrollRun"("payrollPeriodId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunEmployee_payrollRunId_employeeId_key" ON "PayrollRunEmployee"("payrollRunId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunEmployee_id_payrollRunId_key" ON "PayrollRunEmployee"("id", "payrollRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunEmployee_id_payrollRunId_employeeId_key" ON "PayrollRunEmployee"("id", "payrollRunId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunAssignment_payrollRunEmployeeId_employmentAssignm_key" ON "PayrollRunAssignment"("payrollRunEmployeeId", "employmentAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunAssignment_id_payrollRunEmployeeId_key" ON "PayrollRunAssignment"("id", "payrollRunEmployeeId");

-- CreateIndex
CREATE INDEX "PayrollValidationIssue_payrollRunId_severity_idx" ON "PayrollValidationIssue"("payrollRunId", "severity");

-- CreateIndex
CREATE INDEX "PayrollValidationIssue_payrollRunEmployeeId_idx" ON "PayrollValidationIssue"("payrollRunEmployeeId");

-- CreateIndex
CREATE INDEX "PayrollValidationIssue_payrollRunAssignmentId_idx" ON "PayrollValidationIssue"("payrollRunAssignmentId");

-- RenameForeignKey

-- RenameForeignKey

-- AddForeignKey
ALTER TABLE "PayrollCalendar" ADD CONSTRAINT "PayrollCalendar_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCalendar" ADD CONSTRAINT "PayrollCalendar_payGroupId_organizationId_fkey" FOREIGN KEY ("payGroupId", "organizationId") REFERENCES "PayGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_payGroupId_organizationId_fkey" FOREIGN KEY ("payGroupId", "organizationId") REFERENCES "PayGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_payrollCalendarId_payGroupId_fkey" FOREIGN KEY ("payrollCalendarId", "payGroupId") REFERENCES "PayrollCalendar"("id", "payGroupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_payGroupId_organizationId_fkey" FOREIGN KEY ("payGroupId", "organizationId") REFERENCES "PayGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_payrollPeriodId_organizationId_payGroupId_fkey" FOREIGN KEY ("payrollPeriodId", "organizationId", "payGroupId") REFERENCES "PayrollPeriod"("id", "organizationId", "payGroupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_finalizedByUserId_fkey" FOREIGN KEY ("finalizedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEmployee" ADD CONSTRAINT "PayrollRunEmployee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunAssignment" ADD CONSTRAINT "PayrollRunAssignment_payrollRunEmployeeId_payrollRunId_emp_fkey" FOREIGN KEY ("payrollRunEmployeeId", "payrollRunId", "employeeId") REFERENCES "PayrollRunEmployee"("id", "payrollRunId", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunAssignment" ADD CONSTRAINT "PayrollRunAssignment_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollValidationIssue" ADD CONSTRAINT "PayrollValidationIssue_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollValidationIssue" ADD CONSTRAINT "PayrollValidationIssue_payrollRunEmployeeId_payrollRunId_fkey" FOREIGN KEY ("payrollRunEmployeeId", "payrollRunId") REFERENCES "PayrollRunEmployee"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollValidationIssue" ADD CONSTRAINT "PayrollValidationIssue_payrollRunAssignmentId_payrollRunEm_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunEmployeeId") REFERENCES "PayrollRunAssignment"("id", "payrollRunEmployeeId") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─── Integrity ───────────────────────────────────────────────────────────────
-- Same-parent integrity (a calendar's pay group belongs to its organization, a period's calendar
-- to its pay group, a run's period to its pay group and organization, a run assignment to the run
-- employee, an issue's employee/assignment to its run) is enforced by the composite foreign keys
-- above. Overlap of calendars or periods within a pay group is checked by the write workflows of a
-- later batch, under a pay-group row lock; here exact duplicates are already unique.

-- Timezones are explicit IANA names (validated by the application); never blank, never defaulted.
ALTER TABLE "PayrollCalendar"
  ADD CONSTRAINT "PayrollCalendar_timezone_check" CHECK (btrim("timezone") <> '' AND "timezone" = btrim("timezone")),
  ADD CONSTRAINT "PayrollCalendar_effective_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  ADD CONSTRAINT "PayrollCalendar_pay_date_offset_check" CHECK ("payDateOffsetDays" BETWEEN -31 AND 60),
  ADD CONSTRAINT "PayrollCalendar_cutoff_offset_check" CHECK ("processingCutoffOffsetDays" BETWEEN 0 AND 60),
  -- Semi-monthly periods run 1–15 and 16–end of month; monthly anchors avoid days some months lack.
  ADD CONSTRAINT "PayrollCalendar_anchor_check" CHECK (
    ("cadence" <> 'SEMIMONTHLY' OR EXTRACT(DAY FROM "anchorDate") IN (1, 16))
    AND ("cadence" <> 'MONTHLY' OR EXTRACT(DAY FROM "anchorDate") <= 28)
  );

ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "PayrollPeriod_timezone_check" CHECK (btrim("timezone") <> '' AND "timezone" = btrim("timezone")),
  ADD CONSTRAINT "PayrollPeriod_dates_check" CHECK ("periodEnd" >= "periodStart"),
  -- Every supported cadence yields at most a calendar month (31 days).
  ADD CONSTRAINT "PayrollPeriod_length_check" CHECK ("periodEnd" - "periodStart" <= 30),
  ADD CONSTRAINT "PayrollPeriod_pay_date_check" CHECK ("payDate" >= "periodStart");

-- A run's lifecycle columns match its status: calculated runs carry what they were calculated
-- from, approval and finalization record who and when, and only a voided run has a void.
ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PayrollRun_text_check" CHECK (
    ("calculationVersion" IS NULL OR btrim("calculationVersion") <> '')
    AND ("sourceFingerprint" IS NULL OR btrim("sourceFingerprint") <> '')
    AND ("voidReason" IS NULL OR btrim("voidReason") <> '')
  ),
  ADD CONSTRAINT "PayrollRun_calculation_shape_check" CHECK (
    "status" NOT IN ('CALCULATED', 'APPROVED', 'FINALIZED')
    OR ("calculatedAt" IS NOT NULL AND "calculationVersion" IS NOT NULL AND "sourceFingerprint" IS NOT NULL)
  ),
  ADD CONSTRAINT "PayrollRun_approval_shape_check" CHECK (
    ("approvedAt" IS NULL) = ("approvedByUserId" IS NULL)
    AND ("status" NOT IN ('APPROVED', 'FINALIZED') OR "approvedAt" IS NOT NULL)
    AND ("status" NOT IN ('DRAFT', 'CALCULATED') OR "approvedAt" IS NULL)
  ),
  ADD CONSTRAINT "PayrollRun_finalization_shape_check" CHECK (
    ("status" = 'FINALIZED') = ("finalizedAt" IS NOT NULL)
    AND ("finalizedAt" IS NULL) = ("finalizedByUserId" IS NULL)
  ),
  ADD CONSTRAINT "PayrollRun_void_shape_check" CHECK (
    ("status" = 'VOIDED') = ("voidedAt" IS NOT NULL)
    AND ("voidedAt" IS NULL) = ("voidedByUserId" IS NULL)
    AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
  );

-- One live (not voided) run per period and currency. Adjustment runs, when they exist, will
-- revisit this index explicitly rather than slip past it.
CREATE UNIQUE INDEX "PayrollRun_one_live_per_period_currency_key"
  ON "PayrollRun"("payrollPeriodId", "currency") WHERE "status" <> 'VOIDED';

-- A finalized or voided run is terminal: never changed or deleted. Any run keeps the identity it
-- was created with (organization, pay group, period, currency, creator).
CREATE FUNCTION "prevent_payroll_run_rewrite"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('FINALIZED', 'VOIDED') THEN
    RAISE EXCEPTION 'A % payroll run is final and cannot be changed.', lower(OLD."status"::text) USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."organizationId" <> OLD."organizationId"
    OR NEW."payGroupId" <> OLD."payGroupId"
    OR NEW."payrollPeriodId" <> OLD."payrollPeriodId"
    OR NEW."currency" <> OLD."currency"
    OR NEW."createdByUserId" <> OLD."createdByUserId"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A payroll run keeps the period, pay group, currency and creator it was created with.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollRun_prevent_rewrite" BEFORE UPDATE OR DELETE ON "PayrollRun"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_run_rewrite"();

-- Issue codes are stable machine-readable identifiers, not free text; an assignment-level issue
-- also names the run employee (its foreign key then proves the assignment is theirs).
ALTER TABLE "PayrollValidationIssue"
  ADD CONSTRAINT "PayrollValidationIssue_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ADD CONSTRAINT "PayrollValidationIssue_message_check" CHECK (btrim("message") <> ''),
  ADD CONSTRAINT "PayrollValidationIssue_subject_check" CHECK ("payrollRunAssignmentId" IS NULL OR "payrollRunEmployeeId" IS NOT NULL);
