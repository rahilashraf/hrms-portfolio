-- AlterTable
ALTER TABLE "PayrollDeductionLine" ADD COLUMN     "benefitSnapshotId" UUID;

-- AlterTable
ALTER TABLE "PayrollEmployerContributionLine" ADD COLUMN     "benefitSnapshotId" UUID;

-- AlterTable
ALTER TABLE "PayrollSourceClaim" ADD COLUMN     "benefitEnrollmentId" UUID;

-- CreateTable
CREATE TABLE "PayrollBenefitSnapshot" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "benefitEnrollmentId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "planCode" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "benefitType" "BenefitType" NOT NULL,
    "optionId" UUID NOT NULL,
    "optionCode" TEXT NOT NULL,
    "coverageLevel" "BenefitCoverageLevel" NOT NULL,
    "rateId" UUID NOT NULL,
    "frequency" "BenefitRateFrequency" NOT NULL,
    "employeeAmount" DECIMAL(19,2) NOT NULL,
    "employerAmount" DECIMAL(19,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "employerContributionTaxable" BOOLEAN NOT NULL,
    "coveredFrom" DATE NOT NULL,
    "coveredTo" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollBenefitSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollBenefitSnapshot_payrollRunAssignmentId_idx" ON "PayrollBenefitSnapshot"("payrollRunAssignmentId");

-- CreateIndex
CREATE INDEX "PayrollBenefitSnapshot_benefitEnrollmentId_idx" ON "PayrollBenefitSnapshot"("benefitEnrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollBenefitSnapshot_id_payrollRunAssignmentId_key" ON "PayrollBenefitSnapshot"("id", "payrollRunAssignmentId");

-- AddForeignKey
ALTER TABLE "PayrollDeductionLine" ADD CONSTRAINT "PayrollDeductionLine_benefitSnapshotId_payrollRunAssignmen_fkey" FOREIGN KEY ("benefitSnapshotId", "payrollRunAssignmentId") REFERENCES "PayrollBenefitSnapshot"("id", "payrollRunAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployerContributionLine" ADD CONSTRAINT "PayrollEmployerContributionLine_benefitSnapshotId_payrollR_fkey" FOREIGN KEY ("benefitSnapshotId", "payrollRunAssignmentId") REFERENCES "PayrollBenefitSnapshot"("id", "payrollRunAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollBenefitSnapshot" ADD CONSTRAINT "PayrollBenefitSnapshot_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollBenefitSnapshot" ADD CONSTRAINT "PayrollBenefitSnapshot_payrollRunAssignmentId_payrollRunId_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity ───────────────────────────────────────────────────────────────

-- A BENEFIT line names its benefit snapshot (and only a BENEFIT line does); it is never zero
-- and never negative (a correction of finalized pay is an adjustment, not a negative line).
ALTER TABLE "PayrollDeductionLine"
  ADD CONSTRAINT "PayrollDeductionLine_benefit_shape_check" CHECK (
    ("category" = 'BENEFIT') = ("benefitSnapshotId" IS NOT NULL)
    AND ("category" <> 'BENEFIT' OR "amount" > 0)
  );

ALTER TABLE "PayrollEmployerContributionLine"
  ADD CONSTRAINT "PayrollEmployerContributionLine_benefit_shape_check" CHECK (
    ("category" = 'BENEFIT') = ("benefitSnapshotId" IS NOT NULL)
    AND ("category" <> 'BENEFIT' OR "amount" > 0)
  );

ALTER TABLE "PayrollBenefitSnapshot"
  ADD CONSTRAINT "PayrollBenefitSnapshot_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PayrollBenefitSnapshot_amount_check" CHECK ("employeeAmount" >= 0 AND "employerAmount" >= 0),
  ADD CONSTRAINT "PayrollBenefitSnapshot_period_check" CHECK ("coveredTo" >= "coveredFrom");

-- A benefit claim names its election; the duplicate-pay invariant gains one payer per benefit
-- election and date (an employee's deductions for different plans on one date stay distinct).
ALTER TABLE "PayrollSourceClaim"
  ADD CONSTRAINT "PayrollSourceClaim_benefit_shape_check" CHECK (
    ("kind" = 'BENEFIT_DAY') = ("benefitEnrollmentId" IS NOT NULL)
  );

DROP INDEX "PayrollSourceClaim_one_payer_per_assignment_date_key";
CREATE UNIQUE INDEX "PayrollSourceClaim_one_payer_per_assignment_date_key"
  ON "PayrollSourceClaim" ("employmentAssignmentId", "kind", "workDate")
  WHERE "kind" IN ('WORKED_TIME', 'SALARY_DAY');
CREATE UNIQUE INDEX "PayrollSourceClaim_one_payer_per_benefit_day_key"
  ON "PayrollSourceClaim" ("benefitEnrollmentId", "workDate")
  WHERE "kind" = 'BENEFIT_DAY';

-- Benefit snapshots follow the other snapshots: written once, frozen with a final run.
CREATE TRIGGER "PayrollBenefitSnapshot_prevent_update" BEFORE UPDATE ON "PayrollBenefitSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollBenefitSnapshot_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollBenefitSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
