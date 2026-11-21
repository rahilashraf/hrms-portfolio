-- Phase 10 Batches 4-7: gross earning lines, immutable calculation-source snapshots, run totals
-- and the salary unpaid-leave rule. Run employee/assignment rows are only ever created by the
-- calculation this release introduces, so their new NOT NULL snapshot columns are safe.

-- CreateEnum
CREATE TYPE "PayrollSalaryUnpaidLeaveRule" AS ENUM ('UNCONFIGURED', 'HOURLY_EQUIVALENT');

-- CreateEnum
CREATE TYPE "PayrollStatutoryStatus" AS ENUM ('NOT_CALCULATED', 'CALCULATED');

-- CreateEnum
CREATE TYPE "PayrollEarningType" AS ENUM ('REGULAR_HOURLY', 'REGULAR_SALARY', 'PAID_LEAVE', 'UNPAID_LEAVE_REDUCTION', 'MANUAL_EARNING', 'RETRO_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PayrollLineOrigin" AS ENUM ('CALCULATED', 'MANUAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PayrollQuantityUnit" AS ENUM ('MINUTES', 'CALENDAR_DAYS');

-- AlterTable
ALTER TABLE "PayrollCalendar" ADD COLUMN     "salaryStandardAnnualHours" DECIMAL(7,2),
ADD COLUMN     "salaryUnpaidLeaveRule" "PayrollSalaryUnpaidLeaveRule" NOT NULL DEFAULT 'UNCONFIGURED';

-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "deductionAmount" DECIMAL(19,2),
ADD COLUMN     "employerContributionAmount" DECIMAL(19,2),
ADD COLUMN     "grossAmount" DECIMAL(19,2),
ADD COLUMN     "salaryStandardAnnualHours" DECIMAL(7,2),
ADD COLUMN     "salaryUnpaidLeaveRule" "PayrollSalaryUnpaidLeaveRule",
ADD COLUMN     "statutoryStatus" "PayrollStatutoryStatus" NOT NULL DEFAULT 'NOT_CALCULATED';

-- AlterTable
ALTER TABLE "PayrollRunAssignment" ADD COLUMN     "assignmentEndDate" DATE,
ADD COLUMN     "assignmentStartDate" DATE NOT NULL,
ADD COLUMN     "assignmentStatus" "EmploymentAssignmentStatus" NOT NULL,
ADD COLUMN     "deductionAmount" DECIMAL(19,2) NOT NULL DEFAULT 0,
ADD COLUMN     "employerContributionAmount" DECIMAL(19,2) NOT NULL DEFAULT 0,
ADD COLUMN     "employmentType" "EmploymentType" NOT NULL,
ADD COLUMN     "grossAmount" DECIMAL(19,2) NOT NULL DEFAULT 0,
ADD COLUMN     "organizationId" UUID NOT NULL,
ADD COLUMN     "positionId" UUID NOT NULL,
ADD COLUMN     "positionName" TEXT NOT NULL,
ADD COLUMN     "sourceFingerprint" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "PayrollRunEmployee" ADD COLUMN     "deductionAmount" DECIMAL(19,2) NOT NULL DEFAULT 0,
ADD COLUMN     "displayName" TEXT NOT NULL,
ADD COLUMN     "employeeNumber" TEXT NOT NULL,
ADD COLUMN     "employerContributionAmount" DECIMAL(19,2) NOT NULL DEFAULT 0,
ADD COLUMN     "grossAmount" DECIMAL(19,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PayrollEarningLine" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "origin" "PayrollLineOrigin" NOT NULL,
    "type" "PayrollEarningType" NOT NULL,
    "description" TEXT NOT NULL,
    "workDate" DATE,
    "periodFrom" DATE,
    "periodTo" DATE,
    "quantity" DECIMAL(19,4),
    "quantityUnit" "PayrollQuantityUnit",
    "rateAmount" DECIMAL(19,4),
    "amount" DECIMAL(19,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "calculationRule" TEXT NOT NULL,
    "calculationRuleVersion" INTEGER NOT NULL,
    "compensationSnapshotId" UUID,
    "timeSnapshotId" UUID,
    "leaveSnapshotId" UUID,
    "reason" TEXT,
    "createdByUserId" UUID,
    "reversesLineId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollEarningLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollCompensationSnapshot" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "compensationRecordId" UUID NOT NULL,
    "payBasis" "CompensationPayBasis" NOT NULL,
    "rateAmount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "payGroupId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollCompensationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollTimeSnapshot" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "timePeriodId" UUID NOT NULL,
    "timesheetId" UUID NOT NULL,
    "timesheetSegmentId" UUID NOT NULL,
    "timesheetVersion" INTEGER NOT NULL,
    "finalizationStatus" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "approvedWorkedMinutes" INTEGER NOT NULL,
    "grossMinutes" INTEGER NOT NULL,
    "paidBreakMinutes" INTEGER NOT NULL,
    "unpaidBreakMinutes" INTEGER NOT NULL,
    "policyDeductionMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollTimeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLeaveSnapshot" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "leaveRequestId" UUID NOT NULL,
    "leaveRequestDayId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "leaveTypeCode" TEXT NOT NULL,
    "classification" "LeaveClassification" NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "scheduledShiftRevisionIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollLeaveSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPresenceSnapshot" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "attendanceSignInId" UUID NOT NULL,
    "signedInAt" TIMESTAMPTZ(6) NOT NULL,
    "workDate" DATE NOT NULL,
    "scheduledShiftRevisionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollPresenceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEarningLine_reversesLineId_key" ON "PayrollEarningLine"("reversesLineId");

-- CreateIndex
CREATE INDEX "PayrollEarningLine_payrollRunId_origin_idx" ON "PayrollEarningLine"("payrollRunId", "origin");

-- CreateIndex
CREATE INDEX "PayrollEarningLine_payrollRunAssignmentId_type_idx" ON "PayrollEarningLine"("payrollRunAssignmentId", "type");

-- CreateIndex
CREATE INDEX "PayrollCompensationSnapshot_payrollRunAssignmentId_idx" ON "PayrollCompensationSnapshot"("payrollRunAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCompensationSnapshot_id_payrollRunAssignmentId_key" ON "PayrollCompensationSnapshot"("id", "payrollRunAssignmentId");

-- CreateIndex
CREATE INDEX "PayrollTimeSnapshot_payrollRunAssignmentId_idx" ON "PayrollTimeSnapshot"("payrollRunAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollTimeSnapshot_id_payrollRunAssignmentId_key" ON "PayrollTimeSnapshot"("id", "payrollRunAssignmentId");

-- CreateIndex
CREATE INDEX "PayrollLeaveSnapshot_payrollRunAssignmentId_idx" ON "PayrollLeaveSnapshot"("payrollRunAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollLeaveSnapshot_id_payrollRunAssignmentId_key" ON "PayrollLeaveSnapshot"("id", "payrollRunAssignmentId");

-- CreateIndex
CREATE INDEX "PayrollPresenceSnapshot_payrollRunAssignmentId_idx" ON "PayrollPresenceSnapshot"("payrollRunAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunAssignment_id_payrollRunId_key" ON "PayrollRunAssignment"("id", "payrollRunId");

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_payrollRunAssignmentId_payrollRunId_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_compensationSnapshotId_payrollRunAssign_fkey" FOREIGN KEY ("compensationSnapshotId", "payrollRunAssignmentId") REFERENCES "PayrollCompensationSnapshot"("id", "payrollRunAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_timeSnapshotId_payrollRunAssignmentId_fkey" FOREIGN KEY ("timeSnapshotId", "payrollRunAssignmentId") REFERENCES "PayrollTimeSnapshot"("id", "payrollRunAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_leaveSnapshotId_payrollRunAssignmentId_fkey" FOREIGN KEY ("leaveSnapshotId", "payrollRunAssignmentId") REFERENCES "PayrollLeaveSnapshot"("id", "payrollRunAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_reversesLineId_fkey" FOREIGN KEY ("reversesLineId") REFERENCES "PayrollEarningLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCompensationSnapshot" ADD CONSTRAINT "PayrollCompensationSnapshot_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCompensationSnapshot" ADD CONSTRAINT "PayrollCompensationSnapshot_payrollRunAssignmentId_payroll_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollTimeSnapshot" ADD CONSTRAINT "PayrollTimeSnapshot_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollTimeSnapshot" ADD CONSTRAINT "PayrollTimeSnapshot_payrollRunAssignmentId_payrollRunId_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLeaveSnapshot" ADD CONSTRAINT "PayrollLeaveSnapshot_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLeaveSnapshot" ADD CONSTRAINT "PayrollLeaveSnapshot_payrollRunAssignmentId_payrollRunId_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPresenceSnapshot" ADD CONSTRAINT "PayrollPresenceSnapshot_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPresenceSnapshot" ADD CONSTRAINT "PayrollPresenceSnapshot_payrollRunAssignmentId_payrollRunI_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────

ALTER TABLE "PayrollCalendar"
  ADD CONSTRAINT "PayrollCalendar_unpaid_leave_rule_check" CHECK (
    ("salaryUnpaidLeaveRule" = 'HOURLY_EQUIVALENT') = ("salaryStandardAnnualHours" IS NOT NULL)
    AND ("salaryStandardAnnualHours" IS NULL OR "salaryStandardAnnualHours" BETWEEN 1 AND 8784)
  );

-- A calculated run carries its totals; statutory deductions are never "calculated" without an
-- engine (none exists in Phase 10).
ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_totals_shape_check" CHECK (
    "status" NOT IN ('CALCULATED', 'APPROVED', 'FINALIZED')
    OR ("grossAmount" IS NOT NULL AND "deductionAmount" IS NOT NULL AND "employerContributionAmount" IS NOT NULL)
  ),
  ADD CONSTRAINT "PayrollRun_unpaid_leave_rule_check" CHECK (
    ("salaryUnpaidLeaveRule" = 'HOURLY_EQUIVALENT') = ("salaryStandardAnnualHours" IS NOT NULL)
  );

ALTER TABLE "PayrollEarningLine"
  ADD CONSTRAINT "PayrollEarningLine_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PayrollEarningLine_text_check" CHECK (
    btrim("description") <> '' AND btrim("calculationRule") <> '' AND "calculationRuleVersion" > 0
    AND ("reason" IS NULL OR btrim("reason") <> '')
  ),
  ADD CONSTRAINT "PayrollEarningLine_quantity_shape_check" CHECK (
    ("quantity" IS NULL) = ("quantityUnit" IS NULL)
    AND ("periodFrom" IS NULL) = ("periodTo" IS NULL)
    AND ("periodTo" IS NULL OR "periodTo" >= "periodFrom")
  ),
  -- Manual lines say who and why; only manual lines reverse other lines.
  ADD CONSTRAINT "PayrollEarningLine_origin_shape_check" CHECK (
    ("origin" = 'MANUAL') = ("reason" IS NOT NULL AND "createdByUserId" IS NOT NULL)
    AND ("reversesLineId" IS NULL OR "origin" = 'MANUAL')
    AND (("origin" = 'MANUAL') = ("type" = 'MANUAL_EARNING'))
    AND (("origin" = 'ADJUSTMENT') = ("type" = 'RETRO_ADJUSTMENT'))
  ),
  -- Regular pay and paid leave are never negative; an unpaid-leave reduction never positive.
  ADD CONSTRAINT "PayrollEarningLine_amount_sign_check" CHECK (
    ("type" NOT IN ('REGULAR_HOURLY', 'REGULAR_SALARY', 'PAID_LEAVE') OR "amount" >= 0)
    AND ("type" <> 'UNPAID_LEAVE_REDUCTION' OR "amount" <= 0)
  );

ALTER TABLE "PayrollCompensationSnapshot"
  ADD CONSTRAINT "PayrollCompensationSnapshot_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "PayrollTimeSnapshot"
  ADD CONSTRAINT "PayrollTimeSnapshot_finalization_check" CHECK ("finalizationStatus" IN ('APPROVED', 'LOCKED')),
  ADD CONSTRAINT "PayrollTimeSnapshot_minutes_check" CHECK (
    "approvedWorkedMinutes" >= 0 AND "grossMinutes" >= 0 AND "paidBreakMinutes" >= 0
    AND "unpaidBreakMinutes" >= 0 AND "policyDeductionMinutes" >= 0
  );

ALTER TABLE "PayrollLeaveSnapshot"
  ADD CONSTRAINT "PayrollLeaveSnapshot_minutes_check" CHECK ("minutes" >= 0);

-- Lines and snapshots are written once: never updated. A recalculation of a run that is not
-- final deletes its calculated rows and writes new ones.
CREATE FUNCTION "prevent_payroll_line_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Payroll % rows are immutable.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollEarningLine_prevent_update" BEFORE UPDATE ON "PayrollEarningLine"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollCompensationSnapshot_prevent_update" BEFORE UPDATE ON "PayrollCompensationSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollTimeSnapshot_prevent_update" BEFORE UPDATE ON "PayrollTimeSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollLeaveSnapshot_prevent_update" BEFORE UPDATE ON "PayrollLeaveSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollPresenceSnapshot_prevent_update" BEFORE UPDATE ON "PayrollPresenceSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();

-- Nothing of a finalized or voided run changes: no row of it is inserted, updated or deleted.
-- The run row is read FOR SHARE, so a write here and a finalization (which updates the run)
-- serialize: a line can never slip into a run as it is being finalized.
CREATE FUNCTION "guard_final_payroll_run_children"() RETURNS trigger AS $$
DECLARE
  run_status "PayrollRunStatus";
  run_id UUID;
BEGIN
  run_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."payrollRunId" ELSE NEW."payrollRunId" END;
  SELECT "status" INTO run_status FROM "PayrollRun" WHERE "id" = run_id FOR SHARE;
  IF run_status IN ('FINALIZED', 'VOIDED') THEN
    RAISE EXCEPTION 'The payroll run is % and cannot change.', lower(run_status::text) USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."payrollRunId" <> NEW."payrollRunId" THEN
    RAISE EXCEPTION 'Payroll rows never move between runs.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollRunEmployee_guard_final_run" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollRunEmployee"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollRunAssignment_guard_final_run" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollRunAssignment"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollValidationIssue_guard_final_run" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollValidationIssue"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollEarningLine_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollEarningLine"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollCompensationSnapshot_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollCompensationSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollTimeSnapshot_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollTimeSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollLeaveSnapshot_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollLeaveSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollPresenceSnapshot_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollPresenceSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
