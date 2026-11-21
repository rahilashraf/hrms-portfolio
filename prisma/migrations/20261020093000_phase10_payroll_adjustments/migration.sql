-- Phase 10 Batch 8: employee deduction and employer contribution lines, and payroll adjustments
-- (differences carried by a later run; finalized runs are never rewritten).

-- CreateEnum
CREATE TYPE "PayrollDeductionCategory" AS ENUM ('MANUAL', 'STATUTORY', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PayrollContributionCategory" AS ENUM ('MANUAL', 'STATUTORY');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentKind" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentStatus" AS ENUM ('PENDING', 'APPLIED', 'CANCELLED');

-- AlterTable
ALTER TABLE "PayrollEarningLine" ADD COLUMN     "payrollAdjustmentId" UUID;

-- CreateTable
CREATE TABLE "PayrollDeductionLine" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "category" "PayrollDeductionCategory" NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT,
    "createdByUserId" UUID,
    "reversesLineId" UUID,
    "payrollAdjustmentId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollDeductionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollEmployerContributionLine" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "category" "PayrollContributionCategory" NOT NULL,
    "code" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT,
    "createdByUserId" UUID,
    "reversesLineId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollEmployerContributionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "payGroupId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "kind" "PayrollAdjustmentKind" NOT NULL,
    "amount" DECIMAL(19,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PayrollAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "sourceRunId" UUID,
    "sourceEarningLineId" UUID,
    "sourceFingerprint" TEXT,
    "payrollRunId" UUID,
    "appliedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelledByUserId" UUID,
    "cancelReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollDeductionLine_reversesLineId_key" ON "PayrollDeductionLine"("reversesLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollDeductionLine_payrollAdjustmentId_key" ON "PayrollDeductionLine"("payrollAdjustmentId");

-- CreateIndex
CREATE INDEX "PayrollDeductionLine_payrollRunId_category_idx" ON "PayrollDeductionLine"("payrollRunId", "category");

-- CreateIndex
CREATE INDEX "PayrollDeductionLine_payrollRunAssignmentId_idx" ON "PayrollDeductionLine"("payrollRunAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEmployerContributionLine_reversesLineId_key" ON "PayrollEmployerContributionLine"("reversesLineId");

-- CreateIndex
CREATE INDEX "PayrollEmployerContributionLine_payrollRunId_category_idx" ON "PayrollEmployerContributionLine"("payrollRunId", "category");

-- CreateIndex
CREATE INDEX "PayrollEmployerContributionLine_payrollRunAssignmentId_idx" ON "PayrollEmployerContributionLine"("payrollRunAssignmentId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_payGroupId_currency_status_idx" ON "PayrollAdjustment"("payGroupId", "currency", "status");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_employmentAssignmentId_status_idx" ON "PayrollAdjustment"("employmentAssignmentId", "status");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_sourceRunId_idx" ON "PayrollAdjustment"("sourceRunId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_payrollRunId_idx" ON "PayrollAdjustment"("payrollRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEarningLine_payrollAdjustmentId_key" ON "PayrollEarningLine"("payrollAdjustmentId");

-- AddForeignKey
ALTER TABLE "PayrollEarningLine" ADD CONSTRAINT "PayrollEarningLine_payrollAdjustmentId_fkey" FOREIGN KEY ("payrollAdjustmentId") REFERENCES "PayrollAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeductionLine" ADD CONSTRAINT "PayrollDeductionLine_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeductionLine" ADD CONSTRAINT "PayrollDeductionLine_payrollRunAssignmentId_payrollRunId_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeductionLine" ADD CONSTRAINT "PayrollDeductionLine_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeductionLine" ADD CONSTRAINT "PayrollDeductionLine_reversesLineId_fkey" FOREIGN KEY ("reversesLineId") REFERENCES "PayrollDeductionLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeductionLine" ADD CONSTRAINT "PayrollDeductionLine_payrollAdjustmentId_fkey" FOREIGN KEY ("payrollAdjustmentId") REFERENCES "PayrollAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployerContributionLine" ADD CONSTRAINT "PayrollEmployerContributionLine_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployerContributionLine" ADD CONSTRAINT "PayrollEmployerContributionLine_payrollRunAssignmentId_pay_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployerContributionLine" ADD CONSTRAINT "PayrollEmployerContributionLine_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployerContributionLine" ADD CONSTRAINT "PayrollEmployerContributionLine_reversesLineId_fkey" FOREIGN KEY ("reversesLineId") REFERENCES "PayrollEmployerContributionLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_payGroupId_organizationId_fkey" FOREIGN KEY ("payGroupId", "organizationId") REFERENCES "PayGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_sourceEarningLineId_fkey" FOREIGN KEY ("sourceEarningLineId") REFERENCES "PayrollEarningLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────

ALTER TABLE "PayrollDeductionLine"
  ADD CONSTRAINT "PayrollDeductionLine_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PayrollDeductionLine_text_check" CHECK (
    btrim("description") <> '' AND ("reason" IS NULL OR btrim("reason") <> '')
    AND ("code" IS NULL OR "code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
  ),
  ADD CONSTRAINT "PayrollDeductionLine_category_shape_check" CHECK (
    ("category" = 'MANUAL') = ("reason" IS NOT NULL AND "createdByUserId" IS NOT NULL)
    AND ("category" = 'ADJUSTMENT') = ("payrollAdjustmentId" IS NOT NULL)
    AND ("reversesLineId" IS NULL OR "category" = 'MANUAL')
  ),
  -- A manual deduction withholds a positive amount; only its reversal is negative.
  ADD CONSTRAINT "PayrollDeductionLine_amount_check" CHECK (
    "amount" <> 0
    AND ("category" <> 'MANUAL' OR ("reversesLineId" IS NULL) = ("amount" > 0))
  );

ALTER TABLE "PayrollEmployerContributionLine"
  ADD CONSTRAINT "PayrollEmployerContributionLine_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PayrollEmployerContributionLine_text_check" CHECK (
    btrim("description") <> '' AND ("reason" IS NULL OR btrim("reason") <> '')
    AND ("code" IS NULL OR "code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
  ),
  ADD CONSTRAINT "PayrollEmployerContributionLine_category_shape_check" CHECK (
    ("category" = 'MANUAL') = ("reason" IS NOT NULL AND "createdByUserId" IS NOT NULL)
    AND ("reversesLineId" IS NULL OR "category" = 'MANUAL')
  ),
  ADD CONSTRAINT "PayrollEmployerContributionLine_amount_check" CHECK (
    "amount" <> 0
    AND ("category" <> 'MANUAL' OR ("reversesLineId" IS NULL) = ("amount" > 0))
  );

-- An ADJUSTMENT earning line carries exactly one adjustment; no other line does.
ALTER TABLE "PayrollEarningLine"
  ADD CONSTRAINT "PayrollEarningLine_adjustment_shape_check" CHECK (
    ("origin" = 'ADJUSTMENT') = ("payrollAdjustmentId" IS NOT NULL)
  );

ALTER TABLE "PayrollAdjustment"
  ADD CONSTRAINT "PayrollAdjustment_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PayrollAdjustment_amount_check" CHECK ("amount" <> 0),
  ADD CONSTRAINT "PayrollAdjustment_text_check" CHECK (
    btrim("description") <> '' AND btrim("reason") <> ''
    AND ("cancelReason" IS NULL OR btrim("cancelReason") <> '')
  ),
  ADD CONSTRAINT "PayrollAdjustment_source_check" CHECK ("sourceEarningLineId" IS NULL OR "sourceRunId" IS NOT NULL),
  ADD CONSTRAINT "PayrollAdjustment_status_shape_check" CHECK (
    ("status" = 'APPLIED') = ("appliedAt" IS NOT NULL)
    AND ("status" <> 'APPLIED' OR "payrollRunId" IS NOT NULL)
    AND ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
    AND ("cancelledAt" IS NULL) = ("cancelledByUserId" IS NULL)
    AND ("cancelledAt" IS NULL) = ("cancelReason" IS NULL)
    AND ("status" <> 'CANCELLED' OR "payrollRunId" IS NULL)
  );

-- An adjustment's terms never change, and once applied or cancelled nothing about it does.
-- While pending, only its carrying run may change (claimed, released) and it may be applied or
-- cancelled. Never deleted.
CREATE FUNCTION "prevent_payroll_adjustment_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payroll adjustments cannot be deleted; cancel one instead.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'A % payroll adjustment cannot change.', lower(OLD."status"::text) USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."payGroupId" <> OLD."payGroupId"
    OR NEW."employeeId" <> OLD."employeeId" OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId"
    OR NEW."currency" <> OLD."currency" OR NEW."kind" <> OLD."kind" OR NEW."amount" <> OLD."amount"
    OR NEW."description" <> OLD."description" OR NEW."reason" <> OLD."reason"
    OR NEW."sourceRunId" IS DISTINCT FROM OLD."sourceRunId"
    OR NEW."sourceEarningLineId" IS DISTINCT FROM OLD."sourceEarningLineId"
    OR NEW."sourceFingerprint" IS DISTINCT FROM OLD."sourceFingerprint"
    OR NEW."createdByUserId" <> OLD."createdByUserId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Payroll adjustment terms are immutable; cancel it and create another.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollAdjustment_prevent_rewrite" BEFORE UPDATE OR DELETE ON "PayrollAdjustment"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_adjustment_rewrite"();

-- The new line tables follow the same rules as earning lines: written once, and nothing of a
-- finalized or voided run changes.
CREATE TRIGGER "PayrollDeductionLine_prevent_update" BEFORE UPDATE ON "PayrollDeductionLine"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollEmployerContributionLine_prevent_update" BEFORE UPDATE ON "PayrollEmployerContributionLine"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollDeductionLine_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollDeductionLine"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
CREATE TRIGGER "PayrollEmployerContributionLine_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollEmployerContributionLine"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
